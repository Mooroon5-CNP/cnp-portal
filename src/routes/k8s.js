'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const k8sService = require('../services/k8s');

router.get('/pods', requireAuth, requirePermission('k8s:pods:view-own'), async (req, res) => {
  const [pods, quotas, events] = await Promise.all([
    k8sService.listPods(),
    k8sService.listQuotas(),
    can(req.user, 'k8s:events:view') ? k8sService.listEvents() : [],
  ]);

  res.render('k8s/pods', {
    title: 'Ressources K8s — CNP Portal',
    currentPage: 'k8s',
    pods,
    quotas,
    events,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.post('/pods/:name/delete', requireAuth, requirePermission('k8s:pods:delete'), async (req, res) => {
  const namespace = req.body.namespace;
  if (!namespace) {
    req.flash('error', 'Namespace manquant.');
    return res.redirect('/k8s/pods');
  }
  try {
    await k8sService.deletePod(req.params.name, namespace);
    req.flash('success', `Pod ${req.params.name} supprimé.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/k8s/pods');
});

router.post('/deployments/:name/scale', requireAuth, requirePermission('k8s:pods:scale'), async (req, res) => {
  const replicas = parseInt(req.body.replicas);
  const namespace = req.body.namespace;
  if (!namespace) {
    req.flash('error', 'Namespace manquant.');
    return res.redirect('/k8s/pods');
  }
  try {
    await k8sService.scaleDeployment(req.params.name, replicas, namespace);
    req.flash('success', `Déploiement ${req.params.name} mis à l'échelle: ${replicas} réplica(s).`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/k8s/pods');
});

module.exports = router;
