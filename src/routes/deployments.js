'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const githubService = require('../services/github');
const githubClient = require('../clients/github');
const onboardingService = require('../services/onboarding');
const environmentService = require('../services/environment-deployment');
const environmentDeletion = require('../services/environment-deletion');
const repositoryDatabase = require('../services/repository-database');
const applicationAddress = require('../services/application-address');
const deploymentModel = require('../models/deployment');
const deletionRequestModel = require('../models/deletion_request');
const teamService = require('../services/teams');
const { config } = require('../config/env');
const yaml = require('js-yaml');
const { selectWorkflowRun } = require('../services/workflow-runs');
const k8sClient = require('../clients/kubernetes');
const manifestMrModel = require('../models/manifest_mr');
const azureTemplates = require('../services/azure-templates');
const { azureAppUrl } = azureTemplates;
const { PROGRESS_MESSAGES: AZURE_PROGRESS_MESSAGES } = require('../services/environment-azure');

// Clouds que le portail sait déployer. AWS n'est pas encore pris en charge.
const SUPPORTED_CLOUDS = ['gcp', 'azure'];

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

function startEnvironmentOnboarding(dep) {
    Promise.resolve().then(() => environmentService.onboard(dep)).then(() => {
        if (deploymentModel.get(dep.id)?.onboardingStatus === 'configuring') deploymentModel.updateOnboardingStatus(dep.id, 'ready');
    }).catch(err => {
        if (deploymentModel.get(dep.id)?.onboardingStatus === 'configuring') deploymentModel.updateOnboardingStatus(dep.id, 'failed', err.message);
    });
}

function canRetryConfiguration(user, dep) {
    return usesEnvironment(dep) && dep.onboardingStatus === 'failed'
        && !dep.onboardingError?.startsWith('Nettoyage partiel')
        && (user.role === 'manager' || user.id === dep.ownerUserId);
}

async function environmentStatus(dep) {
    try {
        return await environmentService.observe(dep);
    } catch (_) {
        return { phase: 'waiting', message: 'Vérification du déploiement indisponible. Réessayez.',
            observedAt: new Date().toISOString(), freshness: 'unavailable' };
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
        delete_failed: ['Suppression incomplète', 'badge-danger'],
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
        } else if (d.onboardingStatus === 'delete_failed') {
            status = environmentBadge({ phase: 'delete_failed' });
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
    const deploymentDraft = req.session.deploymentDraft || null;
    delete req.session.deploymentDraft;
    const deletionDraft = req.session.deletionDraft || null;
    delete req.session.deletionDraft;

    res.render('deployments/index', {
        title: 'Déploiements — CNP Portal',
        currentPage: 'deployments',
        deployments: withRequests,
        pendingDeletionCount: pendingRequests.length,
        allTeams,
        userTeams,
        applicationsBaseDomain: applicationAddress.baseDomain(),
        deploymentDraft,
        deletionDraft,
        filterTeam,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// ---------------------------------------------------------------------------
// POST /deployments — create and trigger onboarding
// ---------------------------------------------------------------------------

// Formulaire (08/11/2026) : un seul choix « hébergement et données », traduit en réglages internes. En prod, GCP Cloud SQL
// implique toujours le secours vers AWS ; en dev, Cloud SQL sans secours. Les anciens champs restent compris (API, tests).
const STACKS = {
    'azure-postgres': { targetCluster: 'azure' },
    'gcp-sqlite': { targetCluster: 'gcp', persistentStorage: 'on' },
    'gcp-postgres': { targetCluster: 'gcp', database: 'postgres' },
};
function fromStack(body) {
    const stack = STACKS[body.stack];
    if (!body.stack) return body;
    if (!stack) throw new Error('Choix d’hébergement inconnu.');
    // Seul le choix décide de la base, du stockage et du secours : une case forgée ou restée d'un ancien formulaire ne compte pas.
    const values = { ...body };
    for (const key of ['failoverRequested', 'database', 'persistentStorage']) delete values[key];
    Object.assign(values, stack);
    if (body.stack === 'gcp-postgres' && body.environment === 'prod') { values.failoverRequested = 'on'; delete values.database; }
    return values;
}

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    try { req.body = fromStack(req.body); }
    catch (err) {
        req.flash('error', err.message);
        return res.redirect('/deployments');
    }
    const { appName, githubRepoUrl, appPort, ownerTeamId, targetCluster, persistentStorage, environment = 'dev' } = req.body;
    // Mode de facturation de Cloud Run : « usage » (défaut, mise à l'échelle à zéro) ou « instance » (une instance toujours active).
    const billing = req.body.billing === 'instance' && targetCluster !== 'azure' ? 'instance' : 'usage';
    // Sur Azure, la donnée est dans PostgreSQL (un serveur par app) : l'option « SQLite sur GCS » ne s'applique pas.
    const hasPersistentStorage = targetCluster !== 'azure'
        && (persistentStorage === 'on' || persistentStorage === 'true' || persistentStorage === true);

    if (!appName || !githubRepoUrl) {
        req.flash('error', "Veuillez renseigner le nom de l'application et l'URL du dépôt GitHub.");
        return res.redirect('/deployments');
    }

    try { environmentService.validate(environment, appName, targetCluster); }
    catch (err) {
        req.flash('error', err.message);
        return res.redirect('/deployments');
    }
    const failoverRequested = ['on', 'true', true].includes(req.body.failoverRequested);
    if (failoverRequested && (environment !== 'prod' || (targetCluster && targetCluster !== 'gcp') || hasPersistentStorage)) {
        req.flash('error', 'Le failover GCP → AWS nécessite une production GCP sans stockage SQLite local.');
        return res.redirect('/deployments');
    }
    // Base PostgreSQL Cloud SQL sans failover : dev GCP seulement pour l'instant (la prod avec base passe par le failover).
    const database = req.body.database === 'postgres' ? 'postgres' : null;
    if (database && (environment !== 'dev' || (targetCluster && targetCluster !== 'gcp') || hasPersistentStorage || failoverRequested)) {
        req.flash('error', 'La base PostgreSQL (Cloud SQL) est proposée en dev sur GCP, sans stockage SQLite.');
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

    if (targetCluster && !SUPPORTED_CLOUDS.includes(targetCluster)) {
        req.flash('error', 'Ce cloud n\'est pas encore disponible. Seuls GCP et Azure sont supportés pour le moment.');
        return res.redirect('/deployments');
    }

    // Un nom d'application partagé entre environnements garde les mêmes droits d'accès.
    const visibleIds = new Set(deploymentModel.listForUser(req.user).map(row => row.id));
    if (deploymentModel.listForUser(null).some(row => row.app_name === appName && !visibleIds.has(row.id))) {
        return res.status(403).send('Application non accessible.');
    }

    // Validate ownerTeamId if provided.
    const resolvedTeamId = ownerTeamId && teamService.getTeam(ownerTeamId) ? ownerTeamId : null;

    // Reject a known database mismatch BEFORE recording or provisioning anything.
    try {
        const selected = hasPersistentStorage ? 'sqlite'
            : (database || failoverRequested || targetCluster === 'azure') ? 'postgres' : null;
        await repositoryDatabase.assertCompatible(parsed, { environment,
            selected });
    } catch (error) {
        req.session.deploymentDraft = { appName, githubRepoUrl, appPort: port, environment,
            stack: req.body.stack || (hasPersistentStorage ? 'gcp-sqlite' : targetCluster === 'azure' ? 'azure-postgres' : 'gcp-postgres'),
            ownerTeamId: resolvedTeamId, billing, error: error.message };
        req.flash('error', error.message);
        return res.redirect('/deployments');
    }

    // Only record the deployment after the read-only compatibility check succeeds.
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
            failoverRequested,
            database,
            billing,
        });
    } catch (e) {
        req.flash('error', "Impossible d'enregistrer le déploiement.");
        return res.redirect('/deployments');
    }

    // Les ressources live suivent un CI réussi ; la production reste soumise à validation.
    startEnvironmentOnboarding(dep);

    return res.redirect(`/deployments/${dep.id}`);
});

// A partial deletion must never silently resume publishing on a new CI result.
router.post('/:id/resume-deployment', requireAuth, requirePermission('deployments:delete'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep)) return res.status(403).send('Accès refusé.');
    try {
        if (environmentDeletion.get(dep.id)) throw new Error('Une suppression définitive a été confirmée. Reprenez son nettoyage avant de redéployer.');
        await environmentService.resumeAfterCleanupFailure(dep);
        req.flash('success', 'Suivi CI repris. La prochaine CI valide sera prise en compte ; la production reste soumise à approbation.');
    } catch (error) { req.flash('error', error.message); }
    return res.redirect(`/deployments/${dep.id}`);
});

// Production avec failover : la confirmation du manager crée le profil de secours (PostgreSQL, rien à remplir : la base,
// ses identifiants et son schéma sont pris en charge par la plateforme) et lance la mise en service, qui s'enchaîne seule.
// Reprise d'un parcours failover bloqué (mise en service, mise à jour ou retour), après correction de la cause affichée.
router.post('/:id/failover/resume', requireAuth, requirePermission('k8s:manifest:approve'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep)) return res.status(403).send('Accès refusé.');
    try {
        if (!dep.failoverRequested || dep.environment !== 'prod') throw new Error('Aucun failover demandé pour ce déploiement.');
        require('../services/failover-provisioning').resume(dep.appName, req.user);
        req.flash('success', 'Parcours repris à l’étape bloquée.');
    } catch (error) { req.flash('error', error.message); }
    return res.redirect(`/deployments/${dep.id}`);
});
// Retour manuel vers GCP : seulement quand le voyant « GCP disponible » est allumé (contrôlé à nouveau par le parcours).
router.post('/:id/failover/failback', requireAuth, requirePermission('k8s:manifest:approve'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep)) return res.status(403).send('Accès refusé.');
    try {
        if (!dep.failoverRequested || dep.environment !== 'prod') throw new Error('Aucun failover demandé pour ce déploiement.');
        require('../services/failover-provisioning').failback(dep.appName, req.user);
        req.flash('success', 'Retour vers GCP lancé : courte coupure des écritures (environ une minute), puis reconstruction du secours AWS.');
    } catch (error) { req.flash('error', error.message); }
    return res.redirect(`/deployments/${dep.id}`);
});
router.post('/:id/failover/confirm', requireAuth, requirePermission('k8s:manifest:approve'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep)) return res.status(403).send('Accès refusé.');
    try {
        if (!dep.failoverRequested || dep.environment !== 'prod') throw new Error('Aucun failover demandé pour ce déploiement.');
        await require('../services/failover-operations').createProfile(dep.appName, 'postgres', null, req.user);
        require('../services/failover-provisioning').start(dep.appName, req.user);
        req.flash('success', 'Déploiement confirmé : la mise en service sur GCP et AWS, la réplication et la bascule se mettent en place.');
    } catch (error) { req.flash('error', error.message); }
    return res.redirect(`/deployments/${dep.id}`);
});

// Retry only failed setup; never deploy, adopt or clean up resources via a GET.
const pipelineRetries = new Set();
router.post('/:id/retry-pipeline', requireAuth, requirePermission('cicd:trigger-pipeline'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep) || !(req.user.role === 'manager' || req.user.id === dep.ownerUserId)) {
        return res.status(403).send('Accès refusé.');
    }
    if (dep.onboardingStatus !== 'ready' || pipelineRetries.has(dep.id)) {
        return res.status(409).send('La pipeline ne peut pas être relancée dans cet état.');
    }
    pipelineRetries.add(dep.id);
    try {
        const source = githubService.parseRepoUrl(dep.githubRepoUrl);
        if (!source) return res.status(409).send('Repo GitHub invalide.');
        const runs = await githubClient.getRuns(source.owner, source.repo, 20, sourceBranch(dep), workflowId(dep));
        const run = selectWorkflowRun(runs || [], { branch: sourceBranch(dep), notBefore: dep.createdAt });
        if (!run || String(run.id) !== String(req.body.runId) || run.status !== 'completed' || run.conclusion !== 'failure') {
            return res.status(409).send('Seule la dernière pipeline en échec peut être relancée. Actualisez la page.');
        }
        await githubClient.dispatchWorkflow(source.owner, source.repo, workflowId(dep) || 'ci.yml', sourceBranch(dep), dep.appName);
        req.flash('success', 'Nouvelle pipeline demandée sur la version actuelle de la branche. Le suivi se met à jour dès son démarrage sur GitHub.');
        return res.redirect(`/deployments/${dep.id}`);
    } catch (error) {
        req.flash('error', error.userMessage || 'Impossible de relancer la pipeline. Vérifiez les droits GitHub Actions et réessayez.');
        return res.redirect(`/deployments/${dep.id}`);
    } finally {
        pipelineRetries.delete(dep.id);
    }
});

router.post('/:id/retry-configuration', requireAuth, requirePermission('deployments:deploy'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).send('Déploiement introuvable.');
    if (!canViewDeployment(req.user, dep) || !(req.user.role === 'manager' || req.user.id === dep.ownerUserId)) return res.status(403).send('Accès refusé.');
    if (!canRetryConfiguration(req.user, dep)) return res.status(409).send('Seule une configuration en échec peut être relancée.');
    deploymentModel.updateOnboardingStatus(dep.id, 'configuring');
    startEnvironmentOnboarding({ ...dep, onboardingStatus: 'configuring', onboardingError: null });
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
        return res.json({ phase: 'configuring', message: 'Configuration de la plateforme en cours...',
            observedAt: new Date().toISOString(), freshness: 'stored' });
    }

    if (dep.onboardingStatus === 'deleting') {
        return res.json({ phase: 'deleting', message: environmentDeletion.get(dep.id)?.message || 'Suppression de cet environnement en cours ; reprise automatique.',
            observedAt: new Date().toISOString(), freshness: 'stored' });
    }

    if (dep.onboardingStatus === 'delete_failed') {
        return res.json({ phase: 'delete_failed', message: 'Suppression incomplète : réessayez la suppression ou reprenez explicitement le suivi CI.', detail: dep.onboardingError,
            observedAt: new Date().toISOString(), freshness: 'stored' });
    }

    if (dep.onboardingStatus === 'failed') {
        return res.json({
            phase: 'failed',
            message: 'La configuration de la plateforme a échoué. Consultez le détail avant de la relancer.',
            detail: dep.onboardingError,
            observedAt: new Date().toISOString(),
            freshness: 'stored',
        });
    }

    if (usesEnvironment(dep)) {
        try { return res.json(await environmentService.observe(dep)); }
        catch (_) { return res.status(503).json({ phase: 'waiting', message: 'Vérification du déploiement indisponible. Réessayez.',
            observedAt: new Date().toISOString(), freshness: 'unavailable' }); }
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
        if (run.conclusion === 'success' && dep.targetCluster === 'azure') {
            // Un run réussi = image construite et promue, pas application déployée : Crossplane crée encore le
            // serveur PostgreSQL (5 à 10 min), la base puis la Container App. On attend leur état réel.
            const names = azureTemplates.azureNames(dep.appName, config.azure);
            const azure = await k8sClient.getAzureAppStatus(dep.appName, { serverName: names.server, databaseName: names.database })
                .catch(() => null);
            if (!azure) {
                return res.json({ phase: 'running', message: 'Pipeline terminé. Vérification de l\'état des ressources Azure impossible pour le moment, nouvelle tentative…', runUrl });
            }
            if (azure.phase === 'failed') {
                return res.json({ phase: 'failed', message: 'La création des ressources Azure a échoué.', detail: azure.failure, runUrl });
            }
            if (azure.phase !== 'ready') {
                return res.json({ phase: 'running', message: AZURE_PROGRESS_MESSAGES[azure.phase], runUrl });
            }
            return res.json({
                phase: 'success',
                message: 'Votre application a été déployée avec succès.',
                runUrl,
                cloudRunUrl: azureAppUrl(dep.appName, config.azure),
            });
        }
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
            runs = await githubClient.getRuns(parsed.owner, parsed.repo, usesEnvironment(dep) ? 20 : 5, sourceBranch(dep), workflowId(dep)).catch(() => []);
            latest = selectWorkflowRun(runs || [], { branch: sourceBranch(dep) });
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
    if (!cloudRunUrl && dep.onboardingStatus === 'ready' && dep.targetCluster !== 'gcp' && dep.targetCluster !== 'azure') {
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
    // Azure, ancien chemin (un seul environnement, sans suivi de CI) : domaine par défaut de l'environnement Container
    // Apps. JAMAIS pour dev/prod : leur URL ne vient que du statut `success` (cloudRunUrl ci-dessus), sinon le lien
    // s'affiche dès la préparation, avant que le serveur PostgreSQL et la Container App existent (404 Azure).
    const azureUrl = !usesEnvironment(dep) && dep.targetCluster === 'azure' && dep.onboardingStatus === 'ready'
        ? azureAppUrl(dep.appName, config.azure) : null;
    const appUrl = cloudRunUrl || ingressUrl || azureUrl;

    const safeDeployment = {
        id: dep.id,
        appName: dep.appName,
        githubRepoUrl: dep.githubRepoUrl,
        appPort: dep.appPort,
        onboardingStatus: dep.onboardingStatus,
        onboardingError: dep.onboardingError,
        ownerUserId: dep.ownerUserId,
        persistentStorage: dep.persistentStorage,
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

    const deletionDraft = req.session.deletionDraft?.id === dep.id ? req.session.deletionDraft : null;
    if (deletionDraft) delete req.session.deletionDraft;

    res.render('deployments/detail', {
        title: `Déploiement — ${dep.appName}`,
        currentPage: 'deployments',
        deployment: safeDeployment,
        deletionDraft,
        canRetryConfiguration: canRetryConfiguration(req.user, dep),
        canRetryPipeline: can(req.user, 'cicd:trigger-pipeline') && (req.user.role === 'manager' || req.user.id === dep.ownerUserId),
        environmentStatus: selectedStatus,
        hasDeletionJob: Boolean(environmentDeletion.get(dep.id)),
        // Azure n'a pas le routage GCP (<app>.apps.mooroon5.fr passe par le load balancer GCP) : son adresse est le
        // domaine par défaut de l'environnement Container Apps.
        applicationUrl: dep.targetCluster === 'azure' && usesEnvironment(dep)
            ? azureAppUrl(dep.appName, config.azure, dep.environment)
            : applicationAddress.usesNativeCloudRun(dep)
                ? selectedStatus?.applicationUrl || null : applicationAddress.url(dep),
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

async function deleteDeployment(req, res, approveRequest = false) {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }
    if (usesEnvironment(dep) && dep.onboardingStatus === 'deleting') {
        req.flash('info', 'Suppression déjà en cours ; elle se poursuit automatiquement.');
        return res.redirect(`/deployments/${dep.id}`);
    }
    const validationError = String(req.body.confirmation || '').trim().toLowerCase() !== 'delete'
        ? 'Saisissez delete pour confirmer la suppression.'
        : dep.persistentStorage && req.body.destroyData !== 'yes'
            ? 'Confirmez la suppression définitive des données de cet environnement.' : null;
    if (validationError) {
        req.session.deletionDraft = { id: dep.id, action: approveRequest ? 'approve' : 'delete', error: validationError };
        req.flash('error', validationError);
        return res.redirect(req.body.returnTo === 'list' ? '/deployments' : `/deployments/${dep.id}`);
    }
    try {
        if (approveRequest) {
            const pending = deletionRequestModel.listForDeployment(dep.id).find(row => row.status === 'pending');
            if (pending) deletionRequestModel.approve(pending.id, req.user.id);
        }
        if (require('../services/environment-failover').enabled(dep)) {
            require('../services/failover-teardown').start(dep, req.user);
            deploymentModel.updateOnboardingStatus(dep.id, 'deleting');
        } else if (usesEnvironment(dep)) {
            environmentDeletion.start(dep, req.user, { destroyData: req.body.destroyData === 'yes' });
        } else {
            await onboardingService.offboardApp({ appName: dep.appName, githubRepoUrl: dep.githubRepoUrl, targetCluster: dep.targetCluster });
            deletionRequestModel.deleteByDeployment(dep.id);
            deploymentModel.delete(dep.id);
            req.flash('success', `Application "${dep.appName}" supprimée.`);
            return res.redirect('/deployments');
        }
        req.flash('success', `Suppression de "${dep.appName}" lancée. Le nettoyage se poursuit automatiquement ; le déploiement disparaîtra après vérification.`);
    } catch (error) {
        deploymentModel.updateOnboardingStatus(dep.id, 'delete_failed', error.message);
        req.flash('error', `Suppression à reprendre : ${error.message}`);
    }
    return res.redirect(`/deployments/${dep.id}`);
}

router.post('/:id/delete', requireAuth, requirePermission('deployments:delete'), (req, res) => deleteDeployment(req, res));

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

router.post('/:id/approve-delete', requireAuth, requirePermission('deployments:delete'), (req, res) => deleteDeployment(req, res, true));

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
