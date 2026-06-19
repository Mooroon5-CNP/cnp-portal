'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const githubService = require('../services/github');
const githubClient = require('../clients/github');
const onboardingService = require('../services/onboarding');
const deploymentModel = require('../models/deployment');
const deletionRequestModel = require('../models/deletion_request');
const teamService = require('../services/teams');
const { config } = require('../config/env');
const yaml = require('js-yaml');
const k8sClient = require('../clients/kubernetes');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        let status = { label: 'Configuration...', badge: 'badge-warning' };

        if (d.onboardingStatus === 'configuring') {
            status = { label: 'Configuration...', badge: 'badge-warning' };
        } else if (d.onboardingStatus === 'failed') {
            status = { label: 'Erreur setup', badge: 'badge-danger' };
        } else {
            const parsed = githubService.parseRepoUrl(d.githubRepoUrl);
            if (parsed) {
                run = await githubClient.getLatestRun(parsed.owner, parsed.repo).catch(() => null);
            }
            status = mapRunToStatus(run);
        }

        const lastRunTime = run ? (run.updated_at || run.run_started_at || run.created_at) : null;
        const deployedTag = d.onboardingStatus === 'ready' ? await readDeployedTag(d.appName) : null;
        const ownerTeam = d.ownerTeamId ? (teamById[d.ownerTeamId] || null) : null;
        const accessTeamIds = deploymentModel.getAccessibleTeamIds(d.id);
        const accessTeams = accessTeamIds.map(id => teamById[id]).filter(Boolean);

        return {
            id: d.id,
            appName: d.appName,
            githubRepoUrl: d.githubRepoUrl,
            appPort: d.appPort,
            onboardingStatus: d.onboardingStatus,
            status,
            branch: run ? (run.head_branch || 'main') : 'main',
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
        filterTeam,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// ---------------------------------------------------------------------------
// POST /deployments — create and trigger onboarding
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const { appName, githubRepoUrl, appPort, ownerTeamId, targetCluster } = req.body;

    if (!appName || !githubRepoUrl) {
        req.flash('error', "Veuillez renseigner le nom de l'application et l'URL du dépôt GitHub.");
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

    // Validate ownerTeamId if provided.
    const resolvedTeamId = ownerTeamId && teamService.getTeam(ownerTeamId) ? ownerTeamId : null;

    // Create the deployment record immediately with status 'configuring'.
    let dep;
    try {
        dep = deploymentModel.create({
            appName,
            githubRepoUrl,
            appPort: parseInt(appPort, 10) || 8080,
            configRepoToken: null,
            ownerUserId: req.user.id,
            ownerTeamId: resolvedTeamId,
        });
    } catch (e) {
        req.flash('error', "Impossible d'enregistrer le déploiement.");
        return res.redirect('/deployments');
    }

    // Run onboarding asynchronously — do not await so the response returns immediately.
    onboardingService.onboardApp({
        appName,
        githubRepoUrl,
        appPort: parseInt(appPort, 10) || 8080,
        teamOwner: 'team-cnp',
        targetCluster: targetCluster || 'gcp',
        updateStatus: async (status, error) => {
            deploymentModel.updateOnboardingStatus(dep.id, status, error);
        },
    }).catch((err) => {
        deploymentModel.updateOnboardingStatus(dep.id, 'failed', err.message);
    });

    return res.redirect(`/deployments/${dep.id}`);
});

// ---------------------------------------------------------------------------
// GET /deployments/:id/status — JSON polling endpoint
// ---------------------------------------------------------------------------

router.get('/:id/status', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) return res.status(404).json({ error: 'Déploiement introuvable' });

    if (dep.onboardingStatus === 'configuring') {
        return res.json({ phase: 'configuring', message: 'Configuration de la plateforme en cours...' });
    }

    if (dep.onboardingStatus === 'failed') {
        return res.json({
            phase: 'failed',
            message: 'Votre pipeline a échoué. Veuillez vérifier la configuration de votre application.',
            detail: dep.onboardingError,
        });
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
        const cloudRunUrl = await k8sClient.getV2ServiceUrl(dep.appName).catch(() => null);
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

    let runs = [];
    let latest = null;
    let jobs = [];
    let failureHint = null;
    let githubActionsUrl = null;

    if (dep.onboardingStatus === 'ready') {
        const parsed = githubService.parseRepoUrl(dep.githubRepoUrl);
        if (parsed) {
            runs = await githubClient.getRuns(parsed.owner, parsed.repo, 5).catch(() => []);
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

    const cloudRunUrl = await k8sClient.getV2ServiceUrl(dep.appName).catch(() => null);

    const safeDeployment = {
        id: dep.id,
        appName: dep.appName,
        githubRepoUrl: dep.githubRepoUrl,
        appPort: dep.appPort,
        onboardingStatus: dep.onboardingStatus,
        onboardingError: dep.onboardingError,
        ownerUserId: dep.ownerUserId,
        createdAt: dep.createdAt,
        updatedAt: dep.updatedAt,
    };

    const deletionRequests = deletionRequestModel.listForDeployment(dep.id);
    const pendingDeletion = deletionRequests.find(r => r.status === 'pending') || null;

    const allTeams = teamService.listTeams();
    const teamById = Object.fromEntries(allTeams.map(t => [t.id, t]));
    const ownerTeam = dep.ownerTeamId ? (teamById[dep.ownerTeamId] || null) : null;
    const accessTeamIds = deploymentModel.getAccessibleTeamIds(dep.id);
    const accessTeams = accessTeamIds.map(id => teamById[id]).filter(Boolean);
    // Teams not yet granted access (for the add selector).
    const otherTeams = allTeams.filter(t => !accessTeamIds.includes(t.id));

    res.render('deployments/detail', {
        title: `Déploiement — ${dep.appName}`,
        currentPage: 'deployments',
        deployment: safeDeployment,
        runs,
        latest,
        jobs,
        failureHint,
        githubActionsUrl,
        cloudRunUrl,
        pendingDeletion,
        ownerTeam,
        accessTeams,
        otherTeams,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

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
        await onboardingService.offboardApp({
            appName: dep.appName,
            githubRepoUrl: dep.githubRepoUrl,
        });
    } catch (e) {
        // Log partial-cleanup warnings but don't block the deletion.
        req.flash('error', `Nettoyage partiel : ${e.message}`);
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
        await onboardingService.offboardApp({
            appName: dep.appName,
            githubRepoUrl: dep.githubRepoUrl,
        });
    } catch (e) {
        req.flash('error', `Nettoyage partiel : ${e.message}`);
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

    deploymentModel.grantTeamAccess(dep.id, team.id);
    req.flash('success', `Équipe "${team.name}" peut maintenant voir ce déploiement.`);
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

module.exports = router;
