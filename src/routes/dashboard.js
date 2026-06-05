'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const k8sService = require('../services/k8s');
const datadogService = require('../services/datadog');
const argocdService = require('../services/argocd');

router.get('/', requireAuth, async (req, res) => {
  try {
    const pods = await k8sService.listPods();
    const alerts = await datadogService.getAlerts();
    const apps = await argocdService.listApps();

    const stats = {
      totalPods: pods.length,
      runningPods: pods.filter(p => p.status === 'Running').length,
      activeAlerts: alerts.filter(a => a.status === 'ALERT').length,
      syncedApps: apps.filter(a => a.status === 'Synced').length,
      totalApps: apps.length,
    };

    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats,
      recentAlerts: alerts.filter(a => a.status !== 'OK').slice(0, 3),
      user: req.user,
    });
  } catch (err) {
    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats: { totalPods: 0, runningPods: 0, activeAlerts: 0, syncedApps: 0, totalApps: 0 },
      recentAlerts: [],
      user: req.user,
    });
  }
});

module.exports = router;
