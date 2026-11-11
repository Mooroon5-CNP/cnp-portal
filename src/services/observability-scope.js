'use strict';

// Périmètre d'observabilité d'un utilisateur : les services Datadog qu'il a le droit de lire.
//
// Règle métier : on ne voit les logs, métriques et alertes que des apps de son équipe.
// La source de vérité est la même que la page Déploiements (deploymentModel.listForUser) :
//   - dev / devops : apps dont il est propriétaire, dont son équipe est propriétaire,
//     ou auxquelles son équipe a reçu un accès ;
//   - manager : toutes les apps (comme partout ailleurs dans le portail).
//
// Le nom du service Datadog est le nom de ressource de l'app : `<app>-<env>` (ou `<app>` pour un
// déploiement historique). C'est ce nom que portent les logs Cloud Run (`service:`), les métriques
// Cloud Run (`service_name:`), les services ECS (`servicename:`) et le préfixe des flux de logs ECS.

const deploymentModel = require('../models/deployment');

// Un nom de service sert à construire des requêtes Datadog : on n'accepte que ce format.
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function serviceNameOf(row) {
  const env = row.deployment_environment;
  return env && env !== 'legacy' ? `${row.app_name}-${env}` : row.app_name;
}

// [{ service, appName, environment, cloud, deploymentId }] triés par nom, sans doublon.
function listObservableServices(user) {
  if (!user) return [];
  const byService = new Map();
  for (const row of deploymentModel.listForUser(user)) {
    const service = serviceNameOf(row);
    if (!SERVICE_NAME.test(service) || byService.has(service)) continue;
    byService.set(service, {
      service,
      appName: row.app_name,
      environment: row.deployment_environment || 'legacy',
      cloud: row.target_cluster || 'gcp',
      // Une prod avec failover tourne sur GCP (Cloud Run) et peut basculer sur AWS (ECS).
      failover: !!row.failover_requested,
      deploymentId: row.id,
    });
  }
  return [...byService.values()].sort((a, b) => a.service.localeCompare(b.service));
}

class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
  }
}

// Services à interroger pour une requête : celui demandé s'il est dans le périmètre, sinon tous.
// Un service demandé hors périmètre est refusé (jamais ignoré silencieusement).
function resolveServices(user, requested) {
  const allowed = listObservableServices(user);
  if (!requested) return { allowed, selected: allowed.map(s => s.service) };
  if (!allowed.some(s => s.service === requested)) {
    throw new ScopeError('Accès refusé : cette application n\'appartient pas à votre équipe.');
  }
  return { allowed, selected: [requested] };
}

module.exports = { listObservableServices, resolveServices, serviceNameOf, ScopeError, SERVICE_NAME };
