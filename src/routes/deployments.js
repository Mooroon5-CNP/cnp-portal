'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const githubService = require('../services/github');
const githubClient = require('../clients/github');
const onboardingService = require('../services/onboarding');
const deploymentModel = require('../models/deployment');
const { config } = require('../config/env');
const yaml = require('js-yaml');

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
        };
    }));

    res.render('deployments/index', {
        title: 'Déploiements — CNP Portal',
        currentPage: 'deployments',
        deployments: enriched,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// ---------------------------------------------------------------------------
// POST /deployments — create and trigger onboarding
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
    const { appName, githubRepoUrl, appPort } = req.body;

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

    // Create the deployment record immediately with status 'configuring'.
    let dep;
    try {
        dep = deploymentModel.create({
            appName,
            githubRepoUrl,
            appPort: parseInt(appPort, 10) || 8080,
            configRepoToken: null,
            ownerUserId: req.user.id,
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
        if (run.conclusion === 'success') {
            return res.json({
                phase: 'success',
                message: 'Votre application a été déployée avec succès.',
                runUrl,
            });
        }
        return res.json({
            phase: 'failed',
            message: 'Votre pipeline a échoué. Veuillez vérifier la configuration de votre application.',
            runUrl,
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

    res.render('deployments/detail', {
        title: `Déploiement — ${dep.appName}`,
        currentPage: 'deployments',
        deployment: safeDeployment,
        runs,
        latest,
        jobs,
        failureHint,
        githubActionsUrl,
        user: req.user,
        can: (p) => can(req.user, p),
    });
});

// ---------------------------------------------------------------------------
// POST /deployments/:id/delete
// ---------------------------------------------------------------------------

router.post('/:id/delete', requireAuth, requirePermission('deployments:delete'), (req, res) => {
    const dep = deploymentModel.get(req.params.id);
    if (!dep) {
        req.flash('error', 'Déploiement introuvable.');
        return res.redirect('/deployments');
    }
    const canViewAll = can(req.user, 'k8s:pods:view-all');
    if (!canViewAll && dep.ownerUserId !== req.user.id) {
        return res.status(403).json({ error: 'Accès refusé' });
    }
    deploymentModel.delete(req.params.id);
    req.flash('success', 'Déploiement supprimé.');
    return res.redirect('/deployments');
});

module.exports = router;
