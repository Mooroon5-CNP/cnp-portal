'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const githubService = require('../services/github');
const githubClient = require('../clients/github');
const onboardingService = require('../services/onboarding');
const environmentService = require('../services/environment-deployment');
const applicationAddress = require('../services/application-address');
const deploymentModel = require('../models/deployment');
const deletionRequestModel = require('../models/deletion_request');
const teamService = require('../services/teams');
const { config } = require('../config/env');
const yaml = require('js-yaml');
const k8sClient = require('../clients/kubernetes');
const manifestMrModel = require('../models/manifest_mr');

// ---------------------------------------------------------------------------
// GitHub PR status sync
// ---------------------------------------------------------------------------

async function syncMrsFromGitHub(mrs) {
    if (!mrs.length) return;
    const { owner, repo } = parseConfigRepo();
    const token = config.github.configRepoToken;
    await Promise.all(mrs.map(async (mr) => {
        if (!mr.prNumber) return;
        try {
            const status = await githubService.getPullRequestStatus(owner, repo, mr.prNumber, token);
            if (!status) return;
            if (status.merged) {
                manifestMrModel.approve(mr.id, 'github');
            } else if (status.state === 'closed' && !status.merged) {
                manifestMrModel.reject(mr.id, 'github', 'PR fermée directement sur GitHub');
            }
        } catch (_) { /* PR status unavailable */ }
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usesEnvironment(dep) {
    return dep.environment === 'dev' || dep.environment === 'prod';
}

function sourceBranch(dep) {
    return dep.sourceBranch || (dep.environment === 'prod' ? 'prod' : 'main');
}

function workflowId(dep) {
    return usesEnvironment(dep) ? environmentService.workflowName(dep.appName) : null;
}

function canViewDeployment(user, dep) {
    return deploymentModel.listForUser(user).some(row => row.id === dep.id);
}

async function environmentStatus(dep) {
    try {
        return await environmentService.reconcile(dep);
    } catch (_) {
        return { phase: 'waiting', message: 'Vérification du déploiement indisponible. Réessayez.' };
    }
}

function environmentBadge(status) {
    const labels = {
        success: ['Déployé', 'badge-success'],
        approval: ['Validation manager', 'badge-warning'],
        running: ['CI en cours', 'badge-warning'],
        deploying: ['Déploiement en cours', 'badge-warning'],
        failed: ['Échec du déploiement', 'badge-danger'],
        rejected: ['Production refusée', 'badge-danger'],
        deleting: ['Suppression en cours', 'badge-warning'],
    };
    const [label, badge] = labels[status.phase] || ['En attente', 'badge-gray'];
    return { label, badge };
}

function mapRunToStatus(run) {
    if (!run) return { label: 'En attente', badge: 'badge-gray' };
    if (run.status === 'in_progress') return { label: 'CI en cours', badge: 'badge-warning' };
    if (run.status === 'completed') {
        if (run.conclusion === 'success') return { label: 'Déployé', badge: 'badge-success' };
        if (run.conclusion === 'failure') return { label: 'Échec CI', badge: 'badge-danger' };
        if (run.conclusion === 'cancelled') return { label: 'Annulé', badge: 'badge-gray' };
    }
    return { label: 'En attente', badge: 'badge-gray' };
}

function parseConfigRepo() {
    const name = config.github.configRepoName || 'Mooroon5-CNP/config-repo';
    const [owner, repo] = name.split('/');
    return { owner, repo };
}

async function readDeployedTag(appName) {
    try {
        const { owner, repo } = parseConfigRepo();
        const token = config.github.configRepoToken;
        const path = `apps/${appName}/overlays/dev/kustomization.yaml`;
        const content = await githubService.getFileContent(owner, repo, path, token).catch(() => null);
        if (!content) return null;
        const doc = yaml.load(content);
        if (doc && doc.images && Array.isArray(doc.images)) {
            for (const i of doc.images) {
                if (i && i.newTag && i.newTag !== 'placeholder') return String(i.newTag).slice(0, 7);
            }
        }
        const m = content.match(/newTag:\s*["']?([a-f0-9]{7,40})["']?/i);
        if (m) return m[1].slice(0, 7);
    } catch (e) {
        return null;
    }
    return null;
}

const FAILURE_HINTS = {
    'lint-eslint': 'ESLint error in source code. Check `npm run lint` locally.',
    'lint-hadolint': 'Dockerfile violates CNP rules (must use node:20-alpine, non-root user).',
    'test': 'Unit tests failed. Check `npm test` locally.',
    'scan-secrets': 'Committed secret detected in git history. See Gitleaks report in artifacts.',
    'scan-deps': 'CRITICAL CVE in npm dependencies. Run `npm audit` then update the affected package.',
    'build': 'Docker image build failed. Check Dockerfile syntax and base image availability.',
    'scan-image': 'CRITICAL CVE in built image. The image may have been deleted from the registry.',
    'update-config-dev': 'Could not push to config-repo. Contact your platform administrator.',
    'update-config-prod': 'Waiting for manual approval in GitHub Actions. Review deployment in Actions.',
};

// ---------------------------------------------------------------------------
// GET /deployments — list
// ---------------------------------------------------------------------------

router.get('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const rows = deploymentModel.listForUser(req.user);
    const allTeams = teamService.listTeams();
    const teamById = Object.fromEntries(allTeams.map(t => [t.id, t]));
    const filterTeam = req.query.team || '';

    const enriched = await Promise.all(rows.map(async (r) => {
        const d = deploymentModel.get(r.id);
        let run = null;
        let selectedStatus = null;
        let status = { label: 'Configuration...', badge: 'badge-warning' };

        if (d.onboardingStatus === 'configuring') {
            status = { label: 'Configuration...', badge: 'badge-warning' };
        } else if (d.onboardingStatus === 'deleting') {
            status = environmentBadge({ phase: 'deleting' });
        } else if (d.onboardingStatus === 'failed') {
            status = { label: 'Erreur setup', badge: 'badge-danger' };
        } else {
            const parsed = githubService.parseRepoUrl(d.githubRepoUrl);
            if (parsed) {
                run = await githubClient.getLatestRun(parsed.owner, parsed.repo, sourceBranch(d), workflowId(d)).catch(() => null);
            }
            if (usesEnvironment(d)) {
                selectedStatus = await environmentStatus(d);
                status = environmentBadge(selectedStatus);
            } else {
                status = mapRunToStatus(run);
            }
        }

        const lastRunTime = run ? (run.updated_at || run.run_started_at || run.created_at) : null;
        const deployedTag = usesEnvironment(d)
            ? (selectedStatus?.phase === 'success' ? selectedStatus.revision?.slice(0, 7) : null)
            : (d.onboardingStatus === 'ready' ? await readDeployedTag(d.appName) : null);
        const ownerTeam = d.ownerTeamId ? (teamById[d.ownerTeamId] || null) : null;
        const accessTeamIds = deploymentModel.getAccessibleTeamIds(d.id);
        const accessTeams = accessTeamIds.map(id => teamById[id]).filter(Boolean);

        return {
            id: d.id,
            appName: d.appName,
            environment: d.environment || 'legacy',
            githubRepoUrl: d.githubRepoUrl,
            appPort: d.appPort,
            onboardingStatus: d.onboardingStatus,
            persistentStorage: d.persistentStorage,
            status,
            branch: sourceBranch(d),
            lastRunTime,
            deployedTag,
            ownerUserId: d.ownerUserId,
            ownerTeam,
            accessTeams,
        };
    }));

    // Apply team filter.
    const filtered = filterTeam
        ? enriched.filter(d => d.ownerTeam && d.ownerTeam.id === filterTeam)
        : enriched;

    // Attach pending deletion request (if any) to each deployment, for manager view.
    const pendingRequests = can(req.user, 'deployments:delete')
        ? deletionRequestModel.listPending()
        : [];
    const pendingByDep = {};
    for (const r of pendingRequests) pendingByDep[r.deploymentId] = r;

    const withRequests = filtered.map(d => ({
        ...d,
        pendingDeletion: pendingByDep[d.id] || null,
    }));

    const userTeams = teamService.getTeamsForUser(req.user.id);

    res.render('deployments/index', {
        title: 'Déploiements — CNP Portal',
        currentPage: 'deployments',
        deployments: withRequests,
        pendingDeletionCount: pendingRequests.length,
        allTeams,
        userTeams,
        applicationsBaseDomain: applicationAddress.baseDomain(),
        filterTeam,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// ---------------------------------------------------------------------------
// POST /deployments — create and trigger onboarding
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const { appName, githubRepoUrl, appPort, ownerTeamId, targetCluster, persistentStorage, environment = 'dev' } = req.body;
    const hasPersistentStorage = persistentStorage === 'on' || persistentStorage === 'true' || persistentStorage === true;

    if (!appName || !githubRepoUrl) {
        req.flash('error', "Veuillez renseigner le nom de l'application et l'URL du dépôt GitHub.");
        return res.redirect('/deployments');
    }

    try { environmentService.validate(environment, appName); }
    catch (err) {
        req.flash('error', err.message);
        return res.redirect('/deployments');
    }
    const port = Number(appPort || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        req.flash('error', 'Le port applicatif doit être compris entre 1 et 65535.');
        return res.redirect('/deployments');
    }

    if (!config.github.configRepoToken) {
        req.flash('error', 'La plateforme n\'est pas configurée (GITHUB_CONFIG_REPO_TOKEN manquant). Contactez l\'administrateur.');
        return res.redirect('/deployments');
    }

    const parsed = githubService.parseRepoUrl(githubRepoUrl);
    if (!parsed) {
        req.flash('error', 'URL de dépôt GitHub invalide (exemple : https://github.com/org/repo).');
        return res.redirect('/deployments');
    }

    if (targetCluster && targetCluster !== 'gcp') {
        req.flash('error', 'Ce cloud n\'est pas encore disponible. Seul GCP est supporté pour le moment.');
        return res.redirect('/deployments');
    }

    // Un nom d'application partagé entre environnements garde les mêmes droits d'accès.
    const visibleIds = new Set(deploymentModel.listForUser(req.user).map(row => row.id));
    if (deploymentModel.listForUser(null).some(row => row.app_name === appName && !visibleIds.has(row.id))) {
        return res.status(403).send('Application non accessible.');
    }

    // Validate ownerTeamId if provided.
    const resolvedTeamId = ownerTeamId && teamService.getTeam(ownerTeamId) ? ownerTeamId : null;

    // Create the deployment record immediately with status 'configuring'.
    let dep;
    try {
        dep = deploymentModel.create({
            appName,
            githubRepoUrl,
            appPort: port,
            configRepoToken: null,
            ownerUserId: req.user.id,
            ownerTeamId: resolvedTeamId,
            persistentStorage: hasPersistentStorage,
            targetCluster: targetCluster || 'gcp',
            environment,
        });
    } catch (e) {
        req.flash('error', "Impossible d'enregistrer le déploiement.");
        return res.redirect('/deployments');
    }

    // Les ressources live suivent un CI réussi ; la production reste soumise à validation.
    environmentService.onboard(dep).then(() => {
        if (deploymentModel.get(dep.id)?.onboardingStatus === 'configuring') {
            deploymentModel.updateOnboardingStatus(dep.id, 'ready');
        }
    }).catch(err => {
        if (deploymentModel.get(dep.id)?.onboardingStatus === 'configuring') {
            deploymentModel.updateOnboardingStatus(dep.id, 'failed', err.message);
        }
    });

    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// GET /deployments/:id/status — JSON polling endpoint
// ---------------------------------------------------------------------------

router.get('/:id/status', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).json({ error: 'Déploiement introuvable' });
    if (!canViewDeployment(req.user, dep)) return res.status(403).json({ error: 'Accès refusé' });

    if (dep.onboardingStatus === 'configuring') {
        return res.json({ phase: 'configuring', message: 'Configuration de la plateforme en cours...' });
    }

    if (dep.onboardingStatus === 'deleting') {
        return res.json({ phase: 'deleting', message: 'Suppression de cet environnement en cours...' });
    }

    if (dep.onboardingStatus === 'failed') {
        return res.json({
            phase: 'failed',
            message: 'Votre pipeline a échoué. Veuillez vérifier la configuration de votre application.',
            detail: dep.onboardingError,
        });
    }

    if (usesEnvironment(dep)) {
        try { return res.json(await environmentService.reconcile(dep)); }
        catch (_) { return res.status(503).json({ phase: 'waiting', message: 'Vérification du déploiement indisponible. Réessayez.' }); }
    }

    // Onboarding done — check actual CI run status.
    const parsed = githubService.parseRepoUrl(dep.githubRepoUrl);
    if (!parsed) return res.json({ phase: 'waiting', message: 'En attente du premier pipeline...' });

    const run = await githubClient.getLatestRun(parsed.owner, parsed.repo).catch(() => null);
    if (!run) {
        return res.json({ phase: 'waiting', message: 'En attente du premier pipeline...' });
    }

    if (run.status === 'in_progress' || run.status === 'queued') {
        return res.json({ phase: 'running', message: 'Pipeline en cours d\'exécution...', runId: run.id });
    }

    if (run.status === 'completed') {
        const runUrl = `https://github.com/${parsed.owner}/${parsed.repo}/actions/runs/${run.id}`;
        // Use cached URL from DB; only query K8s on cache miss and save on find.
        let cloudRunUrl = dep.cloudRunUrl || null;
        if (!cloudRunUrl) {
            cloudRunUrl = await k8sClient.getV2ServiceUrl(dep.appName).catch(() => null);
            if (cloudRunUrl) deploymentModel.updateCloudRunUrl(dep.id, cloudRunUrl);
        }
        if (run.conclusion === 'success') {
            return res.json({
                phase: 'success',
                message: 'Votre application a été déployée avec succès.',
                runUrl,
                cloudRunUrl,
            });
        }
        return res.json({
            phase: 'failed',
            message: 'Votre pipeline a échoué. Veuillez vérifier la configuration de votre application.',
            runUrl,
            cloudRunUrl,
        });
    }

    return res.json({ phase: 'waiting', message: 'En attente du premier pipeline...', runId: run.id });
});

// ---------------------------------------------------------------------------
// GET /deployments/:id — detail
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable');
    if (!canViewDeployment(req.user, dep)) return res.status(403).send('Accès refusé');

    let runs = [];
    let latest = null;
    let jobs = [];
    let failureHint = null;
    let githubActionsUrl = null;

    if (dep.onboardingStatus === 'ready') {
        const parsed = githubService.parseRepoUrl(dep.githubRepoUrl);
        if (parsed) {
            runs = await githubClient.getRuns(parsed.owner, parsed.repo, 5, sourceBranch(dep), workflowId(dep)).catch(() => []);
            latest = runs && runs.length > 0 ? runs[0] : null;
            if (latest) {
                jobs = await githubClient.getRunJobs(parsed.owner, parsed.repo, latest.id).catch(() => []);
                githubActionsUrl = `https://github.com/${parsed.owner}/${parsed.repo}/actions/runs/${latest.id}`;
            }
            if (latest && latest.conclusion === 'failure' && Array.isArray(jobs)) {
                const firstFailed = jobs.find(j => j.conclusion === 'failure');
                if (firstFailed) {
                    const key = String(firstFailed.name || '').toLowerCase();
                    failureHint = FAILURE_HINTS[key] || `Job "${firstFailed.name}" a échoué.`;
                }
            }
        }
    }

    // Auto-heal gcs-bucket.yaml if it's missing uniformBucketLevelAccess (fire-and-forget).
    if (!usesEnvironment(dep) && dep.targetCluster === 'gcp' && dep.persistentStorage && dep.onboardingStatus === 'ready') {
        onboardingService.healGcsBucket(dep.appName).catch(e =>
            console.warn(`[detail] healGcsBucket(${dep.appName}): ${e.message}`)
        );
    }

    const selectedStatus = usesEnvironment(dep) && dep.onboardingStatus === 'ready'
        ? await environmentStatus(dep) : null;

    // Une URL existante ne prouve pas que la nouvelle révision est prête.
    let cloudRunUrl = usesEnvironment(dep)
        ? (selectedStatus?.phase === 'success' ? selectedStatus.applicationUrl || null : null)
        : dep.cloudRunUrl || null;
    if (!usesEnvironment(dep) && !cloudRunUrl && dep.targetCluster === 'gcp') {
        cloudRunUrl = await k8sClient.getV2ServiceUrl(dep.appName).catch(() => null);
        if (cloudRunUrl) deploymentModel.updateCloudRunUrl(dep.id, cloudRunUrl);
    }
    let ingressUrl = null;
    // For GCP apps, Cloud Run is the only URL source — never fall back to nip.io.
    if (!cloudRunUrl && dep.onboardingStatus === 'ready' && dep.targetCluster !== 'gcp') {
        // 1. Try reading the actual Ingress from the cluster (protocol inferred from TLS presence).
        ingressUrl = await k8sClient.getIngressUrl(dep.appName, 'dev').catch(() => null);

        const isPlaceholder = !ingressUrl || ingressUrl.includes('cnp.example.com');
        if (isPlaceholder) {
            // 2. Fallback: build URL from known baseDomain config or cluster IP.
            const baseDomain = config.cluster?.baseDomain;
            if (baseDomain && baseDomain !== 'cnp.example.com') {
                ingressUrl = `http://${dep.appName}-dev.${baseDomain}`;
            } else {
                const ip = await k8sClient.getIngressControllerIp().catch(() => null);
                if (ip) {
                    ingressUrl = `http://${dep.appName}-dev.${ip}.nip.io`;
                    // Fire-and-forget: rewrite ingress host in config-repo.
                    onboardingService.healIngressHostname(dep.appName).catch(e =>
                        console.warn(`[detail] healIngressHostname(${dep.appName}): ${e.message}`)
                    );
                }
            }
        }
    }
    const appUrl = cloudRunUrl || ingressUrl;

    const safeDeployment = {
        id: dep.id,
        appName: dep.appName,
        githubRepoUrl: dep.githubRepoUrl,
        appPort: dep.appPort,
        onboardingStatus: dep.onboardingStatus,
        onboardingError: dep.onboardingError,
        ownerUserId: dep.ownerUserId,
        targetCluster: dep.targetCluster || 'gcp',
        environment: dep.environment || 'legacy',
        sourceBranch: sourceBranch(dep),
        createdAt: dep.createdAt,
        updatedAt: dep.updatedAt,
    };

    const deletionRequests = deletionRequestModel.listForDeployment(dep.id);
    const pendingDeletion = deletionRequests.find(r => r.status === 'pending') || null;

    const allTeams = teamService.listTeams();
    const teamById = Object.fromEntries(allTeams.map(t => [t.id, t]));
    const ownerTeam = dep.ownerTeamId ? (teamById[dep.ownerTeamId] || null) : null;
    const teamAccess = deploymentModel.getTeamAccess(dep.id); // [{ teamId, permissionLevel }]
    const accessTeamIds = teamAccess.map(a => a.teamId);
    const accessTeams = teamAccess
      .map(a => ({ ...(teamById[a.teamId] || {}), permissionLevel: a.permissionLevel }))
      .filter(t => t.id);
    // Teams not yet granted access (for the add selector).
    const otherTeams = allTeams.filter(t => !accessTeamIds.includes(t.id));

    // Sync pending MR statuses against GitHub before rendering (catches direct GitHub actions).
    if (can(req.user, 'k8s:manifest:approve')) {
        const rawPending = manifestMrModel.listPendingForDeployment(dep.id);
        await syncMrsFromGitHub(rawPending);
    }

    const pendingMrs = can(req.user, 'k8s:manifest:approve')
        ? manifestMrModel.listPendingForDeployment(dep.id)
        : [];

    const userModel = require('../models/user');
    const mrUsers = {};
    for (const mr of pendingMrs) {
        if (mr.requestedBy && !mrUsers[mr.requestedBy]) {
            mrUsers[mr.requestedBy] = userModel.findById(mr.requestedBy);
        }
    }

    res.render('deployments/detail', {
        title: `Déploiement — ${dep.appName}`,
        currentPage: 'deployments',
        deployment: safeDeployment,
        environmentStatus: selectedStatus,
        applicationUrl: applicationAddress.url(dep),
        runs,
        latest,
        jobs,
        failureHint,
        githubActionsUrl,
        cloudRunUrl: appUrl,
        pendingDeletion,
        ownerTeam,
        accessTeams,
        otherTeams,
        pendingMrs,
        mrUsers,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// Une validation manager publie exactement le candidat de production sélectionné.
for (const action of ['approve', 'reject']) {
    router.post(`/:id/releases/:revision/${action}`, requireAuth, requirePermission('k8s:manifest:approve'), async (req, res) => {
        const dep = deploymentModel.get(req.params.id);
        if (!dep) return res.status(404).send('Déploiement introuvable');
        try {
            await environmentService.review(dep, req.params.revision, action === 'approve', { reviewedBy: req.user.id });
            req.flash('success', action === 'approve' ? 'Production approuvée ; déploiement en cours.' : 'Production refusée.');
        } catch (err) { req.flash('error', err.message); }
        return res.redirect(`/deployments/${dep.id}`);
    });
}

// ---------------------------------------------------------------------------
// POST /deployments/:id/delete — manager only, triggers full cleanup
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth, requirePermission('deployments:delete'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    try {
        if (usesEnvironment(dep)) {
            deploymentModel.updateOnboardingStatus(dep.id, 'deleting');
            await environmentService.remove(dep);
        } else {
            await onboardingService.offboardApp({ appName: dep.appName, githubRepoUrl: dep.githubRepoUrl });
        }
    } catch (e) {
        // Log partial-cleanup warnings but don't block the deletion.
        req.flash('error', `Nettoyage partiel : ${e.message}`);
        if (usesEnvironment(dep)) {
            deploymentModel.updateOnboardingStatus(dep.id, 'failed', `Nettoyage partiel : ${e.message}`);
            return res.redirect(`/deployments/${dep.id}`);
        }
    }

    deletionRequestModel.deleteByDeployment(dep.id);
    deploymentModel.delete(dep.id);
    req.flash('success', `Application "${dep.appName}" supprimée et ressources nettoyées.`);
    return res.redirect('/deployments');
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/request-delete — dev/devops requests deletion
// ---------------------------------------------------------------------------

router.post('/:id/request-delete', requireAuth, requirePermission('deployments:delete:request'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    const existing = deletionRequestModel.listForDeployment(dep.id).find(r => r.status === 'pending');
    if (existing) {
        req.flash('error', 'Une demande de suppression est déjà en attente pour cette application.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    deletionRequestModel.create({
        deploymentId: dep.id,
        requestedBy: req.user.id,
        reason: (req.body.reason || '').trim() || null,
    });

    req.flash('success', 'Demande de suppression envoyée. Un manager devra la valider.');
    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/approve-delete — manager approves a pending request
// ---------------------------------------------------------------------------

router.post('/:id/approve-delete', requireAuth, requirePermission('deployments:delete'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    const request = deletionRequestModel.listForDeployment(dep.id).find(r => r.status === 'pending');
    if (request) deletionRequestModel.approve(request.id, req.user.id);

    try {
        if (usesEnvironment(dep)) {
            deploymentModel.updateOnboardingStatus(dep.id, 'deleting');
            await environmentService.remove(dep);
        } else {
            await onboardingService.offboardApp({ appName: dep.appName, githubRepoUrl: dep.githubRepoUrl });
        }
    } catch (e) {
        req.flash('error', `Nettoyage partiel : ${e.message}`);
        if (usesEnvironment(dep)) {
            deploymentModel.updateOnboardingStatus(dep.id, 'failed', `Nettoyage partiel : ${e.message}`);
            return res.redirect(`/deployments/${dep.id}`);
        }
    }

    deletionRequestModel.deleteByDeployment(dep.id);
    deploymentModel.delete(dep.id);
    req.flash('success', `Application "${dep.appName}" supprimée et ressources nettoyées.`);
    return res.redirect('/deployments');
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/reject-delete — manager rejects a pending request
// ---------------------------------------------------------------------------

router.post('/:id/reject-delete', requireAuth, requirePermission('deployments:delete'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    const request = deletionRequestModel.listForDeployment(dep.id).find(r => r.status === 'pending');
    if (request) {
        deletionRequestModel.reject(request.id, req.user.id);
        req.flash('success', 'Demande de suppression refusée.');
    }
    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/team-access — grant a team access to this deployment
// ---------------------------------------------------------------------------

router.post('/:id/team-access', requireAuth, requirePermission('deployments:manage-team-access'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    const team = teamService.getTeam(req.body.teamId);
    if (!team) {
        req.flash('error', 'Équipe introuvable.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    // devops can only manage deployments their team owns.
    if (req.user.role === 'devops' && dep.ownerTeamId && !teamService.isMemberOf(dep.ownerTeamId, req.user.id)) {
        req.flash('error', 'Vous ne pouvez gérer que les déploiements de votre équipe.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    const permissionLevel = req.body.permissionLevel === 'write' ? 'write' : 'read';
    deploymentModel.grantTeamAccess(dep.id, team.id, permissionLevel);
    const label = permissionLevel === 'write' ? 'écriture (YAML K8s)' : 'lecture';
    req.flash('success', `Équipe "${team.name}" — accès ${label} accordé.`);
    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/team-access/:teamId/revoke — revoke team access
// ---------------------------------------------------------------------------

router.post('/:id/team-access/:teamId/revoke', requireAuth, requirePermission('deployments:manage-team-access'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }

    // devops can only manage deployments their team owns.
    if (req.user.role === 'devops' && dep.ownerTeamId && !teamService.isMemberOf(dep.ownerTeamId, req.user.id)) {
        req.flash('error', 'Vous ne pouvez gérer que les déploiements de votre équipe.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    // Cannot revoke the owner team's access.
    if (req.params.teamId === dep.ownerTeamId) {
        req.flash('error', "Impossible de retirer l'accès à l'équipe propriétaire.");
        return res.redirect(`/deployments/${dep.id}`);
    }

    deploymentModel.revokeTeamAccess(dep.id, req.params.teamId);
    req.flash('success', 'Accès révoqué.');
    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/manifest-prs/:mrId/approve — manager merges the PR
// ---------------------------------------------------------------------------

router.post('/:id/manifest-prs/:mrId/approve', requireAuth, requirePermission('k8s:manifest:approve'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    const mr  = manifestMrModel.get(req.params.mrId);

    if (!dep || !mr || mr.deploymentId !== dep.id) {
        req.flash('error', 'MR introuvable.');
        return res.redirect('/deployments');
    }
    if (mr.status !== 'pending') {
        req.flash('error', 'Cette MR n\'est plus en attente.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    const { owner, repo } = parseConfigRepo();
    const token = config.github.configRepoToken;

    try {
        await githubService.mergePullRequest(owner, repo, mr.prNumber, token,
            `Approuvé par ${req.user.username} via CNP Portal`);
        manifestMrModel.approve(mr.id, req.user.id);
        req.flash('success', `Modification de ${mr.filePath.split('/').pop()} approuvée et mergée.`);
    } catch (e) {
        req.flash('error', `Erreur lors du merge : ${e.message}`);
    }
    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/manifest-prs/:mrId/reject — manager rejects the PR
// ---------------------------------------------------------------------------

router.post('/:id/manifest-prs/:mrId/reject', requireAuth, requirePermission('k8s:manifest:approve'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    const mr  = manifestMrModel.get(req.params.mrId);

    if (!dep || !mr || mr.deploymentId !== dep.id) {
        req.flash('error', 'MR introuvable.');
        return res.redirect('/deployments');
    }
    if (mr.status !== 'pending') {
        req.flash('error', 'Cette MR n\'est plus en attente.');
        return res.redirect(`/deployments/${dep.id}`);
    }

    const comment = (req.body.comment || '').trim();
    const { owner, repo } = parseConfigRepo();
    const token = config.github.configRepoToken;

    try {
        const rejectBody = comment
            ? `❌ **Rejeté par ${req.user.username}** :\n\n${comment}`
            : `❌ **Rejeté par ${req.user.username}**`;
        await githubService.addPullRequestComment(owner, repo, mr.prNumber, rejectBody, token);
        manifestMrModel.reject(mr.id, req.user.id, comment || null);
        req.flash('success', 'MR rejetée. Le DevOps peut modifier et resoumettre.');
    } catch (e) {
        req.flash('error', `Erreur lors du rejet : ${e.message}`);
    }
    return res.redirect(`/deployments/${dep.id}`);
});

module.exports = router;
