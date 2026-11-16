'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const datadogService = require('../services/datadog');
const teamService = require('../services/teams');
const scope = require('../services/observability-scope');
const { config } = require('../config/env');

// Règle métier : un utilisateur ne voit que les apps de son équipe (manager : toutes).
// Le périmètre est toujours recalculé côté serveur ; le paramètre `service` de l'URL ne fait que
// choisir une app DANS ce périmètre, et une app hors périmètre est refusée en 403.
function resolveOr403(req, res) {
  try {
    return scope.resolveServices(req.user, typeof req.query.service === 'string' && req.query.service ? req.query.service : null);
  } catch (err) {
    if (err instanceof scope.ScopeError) {
      // Même page de refus que le reste du portail ; texte brut pour l'export CSV.
      if (req.path.endsWith('.csv')) res.status(403).send(err.message);
      else res.status(403).render('error', { title: 'Accès refusé', message: err.message, code: 403, user: req.user });
      return null;
    }
    throw err;
  }
}

function commonLocals(req, title, extra) {
  return {
    title,
    currentPage: 'observability',
    user: req.user,
    can: (p) => can(req.user, p),
    ranges: datadogService.RANGES,
    ...extra,
  };
}

// Demandes d'accès qu'un approbateur peut voir et approuver : celles des personnes qui partagent
// une équipe avec lui. La même règle sert à l'affichage et à l'approbation.
function mayApprove(user, request) {
  return can(user, 'observability:access:approve') && teamService.getTeamMemberIds(user.id).has(request.userId);
}

async function accessRequestsFor(user) {
  if (!can(user, 'observability:access:approve')) return [];
  return (await datadogService.getAccessRequests()).filter(r => mayApprove(user, r));
}

router.get('/datadog', requireAuth, async (req, res) => {
  const accessRequests = await accessRequestsFor(req.user);

  res.render('observability/datadog', {
    title: 'DataDog — CNP Portal',
    currentPage: 'observability',
    accessRequests,
    datadogUrl: `https://${String(config.datadog.site || 'datadoghq.com').replace(/^(api|app)\./, '')}`,
    datadogLogsUrl: datadogService.logsExplorerUrl(config.datadog.site,
      scope.listObservableServices(req.user).map(s => s.service), datadogService.resolveWindow({ range: '24h' })),
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

// Paramètres communs Logs / Métriques : fenêtre de temps, et message si les dates sont refusées.
function windowFrom(req) {
  return datadogService.resolveWindow({ range: req.query.range, from: req.query.from, to: req.query.to });
}

async function readLogs(req, services, limit) {
  const window = windowFrom(req);
  const level = datadogService.normalizeLevel(req.query.level);
  const search = datadogService.normalizeSearch(req.query.q);
  const logs = await datadogService.getLogs(services, { window, level, search, limit });
  return { logs, window, level, search };
}

router.get('/logs', requireAuth, requirePermission('observability:logs:own'), async (req, res) => {
  const resolved = resolveOr403(req, res);
  if (!resolved) return;
  let result = { logs: [], window: windowFrom(req), level: null, search: null };
  let unavailable = false;
  try {
    result = await readLogs(req, resolved.selected, 100);
  } catch (err) {
    console.error('[observability] logs:', err.message);
    unavailable = true;
  }
  const { logs, window, level, search } = result;

  res.render('observability/logs', commonLocals(req, 'Logs — CNP Portal', {
    logs, unavailable, services: resolved.allowed, window,
    selectedService: req.query.service || '', range: window.range, level: level || '', search: search || '',
    levels: datadogService.LEVELS, retentionDays: datadogService.LOGS_RETENTION_DAYS,
    datadogLogsUrl: datadogService.logsExplorerUrl(config.datadog.site, resolved.selected, window),
    csvQuery: new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string' && v)).toString(),
  }));
});

// Téléchargement de la vue en cours (mêmes filtres, mêmes droits), jusqu'à 1 000 lignes.
router.get('/logs.csv', requireAuth, requirePermission('observability:logs:own'), async (req, res) => {
  const resolved = resolveOr403(req, res);
  if (!resolved) return;
  try {
    const { logs } = await readLogs(req, resolved.selected, 1000);
    const name = `logs-${req.query.service || 'mes-apps'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name.replace(/[^a-z0-9._-]/gi, '_')}"`);
    res.send(datadogService.logsToCsv(logs));
  } catch (err) {
    console.error('[observability] logs.csv:', err.message);
    res.status(503).send('Datadog est indisponible pour le moment.');
  }
});

router.get('/metrics', requireAuth, requirePermission('observability:metrics:view'), async (req, res) => {
  const resolved = resolveOr403(req, res);
  if (!resolved) return;
  const window = windowFrom(req);
  let metrics = [];
  let unavailable = false;
  try {
    metrics = await datadogService.getMetrics(resolved.selected, window);
  } catch (err) {
    console.error('[observability] metrics:', err.message);
    unavailable = true;
  }

  res.render('observability/metrics', commonLocals(req, 'Métriques — CNP Portal', {
    metrics, unavailable, services: resolved.allowed, window,
    selectedService: req.query.service || '', range: window.range,
  }));
});

router.get('/alerts', requireAuth, requirePermission('observability:metrics:view'), async (req, res) => {
  const resolved = resolveOr403(req, res);
  if (!resolved) return;
  const alerts = await datadogService.getAlerts(resolved.selected);
  const accessRequests = await accessRequestsFor(req.user);

  res.render('observability/alerts', commonLocals(req, 'Alertes — CNP Portal', {
    alerts, accessRequests, services: resolved.allowed, selectedService: req.query.service || '',
  }));
});

router.post('/alerts/:id/silence', requireAuth, requirePermission('observability:alerts:silence'), async (req, res) => {
  try {
    const services = scope.listObservableServices(req.user).map(s => s.service);
    await datadogService.silenceAlert(req.params.id, services);
    req.flash('success', 'Alerte silencée.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

// Une requête de moniteur ne doit cibler que l'app choisie : sinon l'état de l'alerte révélerait
// les métriques d'une app d'une autre équipe.
function queryTargetsOnly(query, app) {
  const targets = [...String(query).matchAll(/\b(?:service|service_name|servicename):([A-Za-z0-9_.-]+)/g)].map(m => m[1]);
  return targets.length > 0 && targets.every(t => t === app);
}

router.post('/alerts', requireAuth, requirePermission('observability:alerts:create'), async (req, res) => {
  const { name, query, app } = req.body;
  const allowed = scope.listObservableServices(req.user).map(s => s.service);
  if (!allowed.includes(app)) {
    req.flash('error', 'Choisissez une application de votre équipe.');
    return res.redirect('/observability/alerts');
  }
  if (!queryTargetsOnly(query, app)) {
    req.flash('error', `La requête doit filtrer sur cette application uniquement, par exemple {service_name:${app}}.`);
    return res.redirect('/observability/alerts');
  }
  try {
    await datadogService.createAlert({ name, query, app });
    req.flash('success', `Alerte "${name}" créée.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

router.post('/access-request', requireAuth, requirePermission('observability:access:request'), async (req, res) => {
  await datadogService.requestAccess(req.user.id, req.body.reason);
  req.flash('success', 'Demande d\'accès Datadog envoyée au manager.');
  res.redirect('/observability/logs');
});

router.post('/access-request/:id/approve', requireAuth, requirePermission('observability:access:approve'), async (req, res) => {
  try {
    const request = await datadogService.getAccessRequest(req.params.id);
    // Une demande d'une autre équipe se comporte comme une demande inexistante.
    if (!request || !mayApprove(req.user, request)) throw new Error('Demande introuvable.');
    await datadogService.approveAccess(request.id);
    req.flash('success', 'Accès approuvé.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

module.exports = router;
module.exports.queryTargetsOnly = queryTargetsOnly;
