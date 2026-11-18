'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const teamService = require('../services/teams');
const githubService = require('../services/github');
const repositoryDatabase = require('../services/repository-database');
const voice = require('../services/voice-deployment');

router.use(requireAuth, requirePermission('deployments:deploy'));

router.get('/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const ready = voice.configured();
  const message = !process.env.VOICE_DEPLOYMENT_ANALYSIS_MODEL?.trim()
    ? 'Le nom du modèle d’analyse manque. Vos réponses restent disponibles ici.'
    : 'Le service vocal n’est pas entièrement configuré. Vos réponses restent disponibles ici.';
  res.json({ ready, message: ready ? undefined : message });
});

function fail(res, error) {
  const status = error instanceof voice.VoiceError ? error.status : 502;
  const message = error instanceof voice.VoiceError ? error.message : 'Service vocal indisponible.';
  return res.status(status).json({ error: message });
}

function validRepoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.split('/').filter(Boolean).length === 2 && Boolean(githubService.parseRepoUrl(value));
  } catch (_) { return false; }
}

router.post('/transcribe/:questionId', express.raw({ type: 'audio/wav', limit: '10mb' }), async (req, res) => {
  try {
    if (!voice.QUESTION_IDS.includes(req.params.questionId)) throw new voice.VoiceError('Question inconnue.');
    const text = await voice.transcribe(req.body);
    res.json({ id: req.params.questionId, text });
  } catch (error) { fail(res, error); }
});

router.post('/analyze', async (req, res) => {
  try {
    const { answers, githubRepoUrl, appName } = req.body || {};
    if (!validRepoUrl(githubRepoUrl) || typeof appName !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(appName) || appName.length > 63) {
      throw new voice.VoiceError('Renseignez un dépôt GitHub et un nom d’application valides.');
    }
    const teams = teamService.getTeamsForUser(req.user.id);
    const proposal = await voice.analyze(answers, teams);
    if (proposal.fields.stack && proposal.fields.environment) {
      const selected = proposal.fields.stack === 'gcp-sqlite' ? 'sqlite' : 'postgres';
      try {
        await repositoryDatabase.assertCompatible(githubService.parseRepoUrl(githubRepoUrl), {
          environment: proposal.fields.environment, selected,
        });
      } catch (_) {
        delete proposal.fields.stack;
        delete proposal.fields.billing;
        delete proposal.notes.stack;
        delete proposal.notes.billing;
        proposal.missing.push('Hébergement : vérifier la compatibilité avec la base de données du dépôt.');
      }
    }
    res.json(proposal);
  } catch (error) { fail(res, error); }
});

module.exports = router;
