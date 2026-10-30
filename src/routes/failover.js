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

router.get('/', (req, res) => res.render('failover', {
  title: 'Phase 1 Pixelcalm', user: req.user, rows: service.rows(),
}));
router.post('/prepare/:stage', async (req, res) => {
  try {
    const candidate = await service.prepare(req.params.stage, req.user);
    if (req.accepts(['html', 'json']) === 'json') return res.json(candidate);
    return res.redirect(`/failover/${candidate.id}`);
  } catch (err) { return res.status(409).json({ error: err.message }); }
});
router.get('/:id', (req, res) => {
  const db = require('../models/db');
  service.rows();
  const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(req.params.id);
  if (!row) return res.sendStatus(404);
  return res.render('failover', { title: 'Revue phase 1 Pixelcalm', user: req.user,
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
