'use strict';

// Le formulaire existant impose le secours AWS pour GCP PostgreSQL en prod.
// Le routage des variables suit le déploiement réellement enregistré ; il ne
// déduit jamais une destination AWS du seul nom de l'application.
function domainsForDeployment(deployment) {
  if (!deployment || !['dev', 'prod'].includes(deployment.environment)) {
    throw new Error('Environnement de déploiement OpenBao invalide.');
  }
  if (deployment.targetCluster === 'azure') {
    if (deployment.failoverRequested) throw new Error('Secours AWS indisponible pour Azure.');
    return ['azure'];
  }
  if (deployment.targetCluster !== 'gcp') {
    throw new Error('Hébergement OpenBao indisponible pour ce déploiement.');
  }
  if (!deployment.failoverRequested) return ['gcp'];
  if (deployment.environment !== 'prod' || deployment.persistentStorage) {
    throw new Error('Secours AWS incompatible avec ce déploiement GCP.');
  }
  return ['gcp', 'aws'];
}

module.exports = { domainsForDeployment };
