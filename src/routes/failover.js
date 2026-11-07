'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const service = require('../services/environment-failover');
const router = express.Router();
router.use(requireAuth, requirePermission('k8s:manifest:approve'));
router.use((req, res, next) => {
  req.session.failoverCsrf ||= require('crypto').randomUUID();
  res.locals.failoverCsrf = req.session.failoverCsrf;
  if (req.method === 'POST' && req.body.csrf !== req.session.failoverCsrf) {
    return res.status(403).json({ error: 'Jeton de revue absent ou expiré.' });
  }
  return next();
});

router.get('/', (req, res) => {
  const deploymentChoices = require('../models/deployment').listForUser(req.user).filter(row => row.deployment_environment === 'prod' && row.target_cluster === 'gcp');
  const selectedApp = req.query.app || '';
  const profile = selectedApp ? service.profileFor(selectedApp) : null;
  return res.render('failover', {
    title: 'Failover des applications', user: req.user, selectedApp,
    profileMode: profile?.profile.mode || 'postgres', profileConfigured: !!profile,
    provisioning: selectedApp ? require('../services/failover-provisioning').get(selectedApp) : null,
    rows: service.rows(selectedApp || undefined),
    profiles: [...new Set([...service.profiles(), ...deploymentChoices.map(row => row.app_name)])],
    operations: profile ? require('../services/failover-operations').list(selectedApp) : [], deploymentChoices,
  });
});
router.post('/configure-deployment', async (req, res) => {
  try {
    // Aucun champ de base : la plateforme choisit le nom (voir createProfile) et le transmet à l'application par DB_NAME.
    const result = await require('../services/failover-operations').createProfile(req.body.app, req.body.mode, null, req.user);
    require('../services/failover-provisioning').start(result.app, req.user);
    return res.redirect(`/failover?app=${encodeURIComponent(result.app)}`);
  } catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/profiles', (req, res) => {
  try {
    if (require('../services/failover-operations').list(req.body.app).some(row => ['running', 'applying'].includes(row.state))) throw new Error('Attendre la fin de l’opération avant de modifier ce profil.');
    const result = service.configure(req.body.app, JSON.parse(req.body.document), req.user);
    if (req.accepts(['html', 'json']) === 'json') return res.json(result);
    return res.redirect(`/failover?app=${encodeURIComponent(result.app)}`);
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.get('/operations/status/:app', (req, res) => res.json(require('../services/failover-operations').list(req.params.app)));
router.get('/provisioning/status/:app', (req, res) => res.json(require('../services/failover-provisioning').get(req.params.app)));
router.post('/provisioning/:action', (req, res) => {
  try {
    if (!['start', 'resume'].includes(req.params.action)) throw new Error('Action de préparation inconnue.');
    require('../services/failover-provisioning')[req.params.action](req.body.app, req.user);
    return res.redirect(`/failover?app=${encodeURIComponent(req.body.app)}`);
  } catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/operations/:action', (req, res) => {
  try {
    const provisioning = require('../services/failover-provisioning').get(req.body.app);
    if (provisioning && provisioning.state !== 'completed') throw new Error('Préparation automatique en cours : utiliser sa reprise ou valider la publication affichée.');
    require('../services/failover-operations').start(req.body.app, req.params.action, req.user);
    return res.redirect(`/failover?app=${encodeURIComponent(req.body.app)}`);
  } catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/operation/:id/retry', (req, res) => {
  try {
    const result = require('../services/failover-operations').retry(req.params.id, req.user);
    if (req.accepts(['html', 'json']) === 'json') return res.json(result);
    return res.redirect('/failover');
  }
  catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/ci/configure', async (req, res) => {
  try {
    const deployments = require('../models/deployment');
    const row = deployments.listForUser(req.user).find(row => row.app_name === req.body.app && row.deployment_environment === 'prod');
    if (!row) throw new Error('Rattachez ou créez d’abord le déploiement de production.');
    await require('../services/environment-deployment').configureFailoverBuild(deployments.get(row.id), req.user);
    return res.redirect(`/failover?app=${encodeURIComponent(req.body.app)}`);
  } catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/packages/:stage', (req, res) => {
  try {
    const result = service.operationalPackage(req.body.app, req.params.stage, req.user);
    res.set('Content-Disposition', 'attachment; filename="failover-package.json"');
    return res.json(result);
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.post('/adoption/preview', async (req, res) => {
  try {
    const preview = await service.adoptionPreview(req.body.app, req.user);
    return res.render('failover', { title: 'Rattacher une application existante', user: req.user,
      rows: service.rows(req.body.app), profiles: service.profiles(), selectedApp: req.body.app, adoption: preview });
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.post('/adoption/confirm', async (req, res) => {
  try {
    const result = await service.adopt(req.body.app, req.body.head, req.user);
    return res.redirect(`/deployments/${result.deploymentId}`);
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.post('/prepare/:stage', async (req, res) => {
  try {
    const candidate = await service.prepare(req.params.stage, req.user, req.body.app);
    if (req.accepts(['html', 'json']) === 'json') return res.json(candidate);
    return res.redirect(`/failover/${candidate.id}`);
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.get('/:id', (req, res) => {
  const db = require('../models/db');
  service.rows();
  const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(req.params.id);
  if (!row) return res.sendStatus(404);
  return res.render('failover', { title: `Revue failover ${row.app_name}`, user: req.user, profiles: service.profiles(), selectedApp: row.app_name,
    rows: [row], candidate: row, files: JSON.parse(row.files) });
});
router.post('/:id/approve', async (req, res) => {
  try {
    const result = await service.approve(req.params.id, req.body.head, req.user);
    if (req.accepts(['html', 'json']) === 'json') return res.json(result);
    return res.redirect('/failover');
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.post('/:id/reject', async (req, res) => {
  try {
    const result = await service.reject(req.params.id, req.user);
    if (req.accepts(['html', 'json']) === 'json') return res.json(result);
    return res.redirect('/failover');
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
module.exports = router;
