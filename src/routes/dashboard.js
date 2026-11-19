'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const k8sService = require('../services/k8s');
const datadogService = require('../services/datadog');
const observabilityScope = require('../services/observability-scope');
const argocdService = require('../services/argocd');
const deploymentModel = require('../models/deployment');
const teamService = require('../services/teams');
const { config } = require('../config/env');
const { readDashboardSources } = require('../services/dashboard-sources');
const applicationAddress = require('../services/application-address');
const failover = require('../services/environment-failover');
const { azureAppUrl } = require('../services/azure-templates');
const { privateAppUrl } = require('../services/private-templates');

router.get('/', requireAuth, async (req, res) => {
  try {
    const sources = await readDashboardSources({
      Kubernetes: () => k8sService.listPods(),
      Datadog: () => datadogService.getAlerts(observabilityScope.listObservableServices(req.user).map(s => s.service)),
      'Argo CD': () => argocdService.listApps(),
    });
    const pods = sources.Kubernetes.data;
    const alerts = sources.Datadog.data;
    const apps = sources['Argo CD'].data;
    const unavailableSources = Object.entries(sources).filter(([, value]) => !value.available).map(([name]) => name);

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
    const podInScope = (pod) => {
      if (isManager) return true;
      return myAppNames.has(pod.app) || myAppNames.has((pod.namespace || '').replace(/-dev$|-prod$/, ''));
    };
    const argoAppInScope = (app) => {
      if (isManager) return true;
      return [...myAppNames].some(n => (app.name || '').startsWith(n));
    };

    const myPods = pods.filter(podInScope);
    const myApps = apps.filter(argoAppInScope);

    const stats = {
      totalPods:    sources.Kubernetes.available ? myPods.length : null,
      runningPods:  sources.Kubernetes.available ? myPods.filter(p => p.status === 'Running').length : null,
      activeAlerts: sources.Datadog.available ? alerts.filter(a => a.status === 'ALERT').length : null,
      syncedApps:   sources['Argo CD'].available ? myApps.filter(a => a.status === 'Synced').length : null,
      totalApps:    sources['Argo CD'].available ? myApps.length : null,
    };

    // Build per-app summary for the "Mes Applications" panel.
    // Même adresse que la page du déploiement (routes/deployments.js) : Azure dev/prod par azureAppUrl (eu.mooroon5.fr),
    // GCP dev/prod par l'adresse applicative (apps.mooroon5.fr), Cloud Run natif et ancien chemin par l'URL enregistrée.
    // Avant le 16/11, seul cloud_run_url était lu : les déploiements dev/prod affichaient « URL en attente » une fois actifs.
    const myAppsList = myDeployments.slice(0, 8).map(row => {
      const dep = deploymentModel.get(row.id) || {};
      const env = ['dev', 'prod'].includes(dep.environment) ? dep.environment : null;
      let url = null;
      try {
        if (dep.targetCluster === 'azure') url = env ? azureAppUrl(dep.appName, config.azure, env) : null;
        else if (dep.targetCluster === 'private-aws') url = env ? privateAppUrl(dep.appName, config.private, env) : null;
        else if (!env || applicationAddress.usesNativeCloudRun(dep)) url = dep.cloudRunUrl || null;
        else url = applicationAddress.url(dep);
      } catch (_) { url = null; }
      const cloud = dep.targetCluster === 'azure' ? 'Azure' : dep.targetCluster === 'private-aws' ? 'Privé (k3s)'
        : (dep.failoverRequested || failover.enabled(dep)) ? 'GCP, secours AWS' : 'GCP';
      return {
        name:   row.app_name,
        environment: env,
        status: row.onboarding_status,
        cloud,
        url,
      };
    });

    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats,
      unavailableSources,
      recentAlerts: alerts.filter(a => a.status !== 'OK').slice(0, 3),
      myAppsList,
      user: req.user,
    });
  } catch (err) {
    console.error('[dashboard]', err.message);
    res.render('dashboard', {
      title: 'Dashboard — CNP Portal',
      currentPage: 'dashboard',
      stats: { totalPods: null, runningPods: null, activeAlerts: null, syncedApps: null, totalApps: null },
      unavailableSources: ['Kubernetes', 'Datadog', 'Argo CD'],
      recentAlerts: [],
      myAppsList: [],
      user: req.user,
    });
  }
});

module.exports = router;
