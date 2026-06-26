'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const k8sService = require('../services/k8s');
const datadogService = require('../services/datadog');
const argocdService = require('../services/argocd');
const deploymentModel = require('../models/deployment');
const teamService = require('../services/teams');
const { config } = require('../config/env');

router.get('/', requireAuth, async (req, res) => {
  try {
    const [pods, alerts, apps] = await Promise.all([
      k8sService.listPods(),
      datadogService.getAlerts(),
      argocdService.listApps(),
    ]);

    // Get the teams the current user belongs to.
    const userTeams = teamService.getTeamsForUser(req.user.id);
    const teamIds = new Set(userTeams.map(t => t.id));

    // All deployments visible to this user (devops sees all, dev sees team-scoped).
    const allDeployments = deploymentModel.listForUser(req.user);

    // For the dashboard we want MY apps = owned by me or by my teams.
    const isManager = req.user.role === 'manager';
    const myDeployments = isManager
      ? allDeployments
      : allDeployments.filter(d => {
          if (d.owner_user_id === req.user.id) return true;
          if (d.owner_team_id && teamIds.has(d.owner_team_id)) return true;
          return false;
        });

    const myAppNames = new Set(myDeployments.map(d => d.app_name));

    // Filter pods and ArgoCD apps to the user's scope.
    function podInScope(pod) {
      if (isManager) return true;
      return myAppNames.has(pod.app) || myAppNames.has((pod.namespace || '').replace(/-dev$|-prod$/, ''));
    }
    function argoAppInScope(app) {
      if (isManager) return true;
      return [...myAppNames].some(n => (app.name || '').startsWith(n));
    }

    const myPods = pods.filter(podInScope);
    const myApps = apps.filter(argoAppInScope);

    const stats = {
      totalPods:    myPods.length,
      runningPods:  myPods.filter(p => p.status === 'Running').length,
      activeAlerts: alerts.filter(a => a.status === 'ALERT').length,
      syncedApps:   myApps.filter(a => a.status === 'Synced').length,
      totalApps:    myApps.length,
    };

    // Build per-app summary for the "Mes Applications" panel.
    const baseDomain = config.cluster.baseDomain;
    const myAppsList = myDeployments.slice(0, 8).map(dep => {
      const isGcp = (dep.target_cluster || 'gcp') === 'gcp';
      const url = isGcp
        ? (dep.cloud_run_url || null)
        : (baseDomain && baseDomain !== 'cnp.example.com' ? `http://${dep.app_name}-dev.${baseDomain}` : null);
      return {
        name:   dep.app_name,
        status: dep.onboarding_status,
        isGcp,
        url,
      };
    });

    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats,
      recentAlerts: alerts.filter(a => a.status !== 'OK').slice(0, 3),
      myAppsList,
      user: req.user,
    });
  } catch (err) {
    console.error('[dashboard]', err.message);
    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats: { totalPods: 0, runningPods: 0, activeAlerts: 0, syncedApps: 0, totalApps: 0 },
      recentAlerts: [],
      myAppsList: [],
      user: req.user,
    });
  }
});

module.exports = router;
