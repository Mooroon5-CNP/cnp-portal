'use strict';

/**
 * Chemin Azure du service d'environnements dev/prod (environment-deployment.js).
 *
 * Même mécanique que GCP : à l'onboarding le portail prépare le dépôt (workflow, secret, variables, registre,
 * ApplicationSet par environnement) ; les CLAIMS ne sont écrits qu'APRÈS une CI réussie, avec la révision exacte
 * (tag de l'image = SHA du commit). Dev : commit direct sur main du config-repo. Prod : PR approuvée par un
 * manager puis mergée par la GitHub App (le garde-fou protect-prod-paths n'accepte qu'elle sous apps/*\/crossplane/prod/).
 *
 * Ce fichier ne contient que ce qui diffère de GCP : variables du dépôt, workflow (pipeline-azure.yml), claims
 * (serveur PostgreSQL privé par app et par environnement, base, secrets, Container App), état de disponibilité lu
 * dans Crossplane, URL par défaut de l'environnement Container Apps. Pas de routage : l'URL personnalisée
 * (<app>.apps.mooroon5.fr) est propre au load balancer GCP.
 */

const yaml = require('js-yaml');
const { config, getMissingAzureVars } = require('../config/env');
const kubernetes = require('../clients/kubernetes');
const azureTemplates = require('./azure-templates');

const isAzure = dep => !!dep && dep.targetCluster === 'azure';

// Messages affichés entre la fin de la CI et la disponibilité réelle de l'application (le serveur PostgreSQL privé
// met 5 à 10 minutes à se créer : sans eux, le portail annoncerait « déployée » bien trop tôt).
const PROGRESS_MESSAGES = {
  'waiting-argocd': 'Pipeline terminé. En attente de la synchronisation d\'Argo CD…',
  server: 'Pipeline terminé. Création du serveur PostgreSQL privé en cours (5 à 10 minutes)…',
  database: 'Serveur PostgreSQL prêt. Création de la base de données…',
  containerapp: 'Base de données prête. Création de la Container App…',
};

function validate(appName) {
  azureTemplates.validateAzureAppName(appName);
  if (appName.length > azureTemplates.MAX_APP_NAME_WITH_ENV) {
    throw new Error(
      `Nom d'application trop long pour Azure (${appName.length} > ${azureTemplates.MAX_APP_NAME_WITH_ENV}) : ` +
      'le nom de la Container App est « <application>-<environnement> », limité à 32 caractères.'
    );
  }
}

/** Échoue AVANT toute écriture si la plateforme n'a pas la configuration Azure (variables AZURE_*). */
function assertConfigured() {
  const missing = getMissingAzureVars(config.azure);
  if (missing.length > 0) {
    throw new Error(`Le déploiement Azure n'est pas configuré sur la plateforme. Variables manquantes : ${missing.join(', ')}.`);
  }
}

/** Variables non secrètes que pipeline-azure.yml lit sur le dépôt de l'app : [nom, valeur]. */
function repoVariables() {
  return azureTemplates.azureRepoVariables(config.azure);
}

/** Workflow de l'app : pipeline-azure.yml en mode portail, sur main (dev) et prod. */
function workflow(dep, workflowRef) {
  const configRepo = config.github.configRepoName || 'Mooroon5-CNP/config-repo';
  return yaml.dump({
    name: `CNP — ${dep.appName}`,
    on: { push: { branches: ['main', 'prod'] } },
    permissions: { contents: 'read', 'id-token': 'write' },
    concurrency: { group: `cnp-${dep.appName}-\${{ github.ref }}`, 'cancel-in-progress': false },
    jobs: {
      pipeline: {
        uses: `Mooroon5-CNP/ci-templates/.github/workflows/pipeline-azure.yml@${workflowRef || 'main'}`,
        with: {
          app_name: dep.appName,
          app_port: String(dep.appPort || 8080),
          config_repo_url: `https://github.com/${configRepo}`,
          gitops_mode: 'portal',
        },
        secrets: { CONFIG_REPO_TOKEN: '${{ secrets.CONFIG_REPO_TOKEN }}' },
      },
    },
  }, { lineWidth: -1 });
}

function imageRef(dep, revision) {
  return `${config.azure.acrLoginServer}/${dep.appName}:${revision}`;
}

/** Fichiers du claim d'un environnement : { 'apps/<app>/crossplane/<env>/<fichier>': contenu }. */
function manifests(dep, revision) {
  assertConfigured();
  const dir = `apps/${dep.appName}/crossplane/${dep.environment}`;
  const files = azureTemplates.azureCrossplaneFiles(dep.appName, dep.appPort, config.azure, dep.environment, revision);
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`${dir}/${name}`, content]));
}

/** Noms de fichiers d'un environnement (suppression). */
function fileNames() {
  return ['containerapp-secretname.yaml', 'flexibleserver.yaml', 'flexibleserver-database.yaml', 'containerapp-claim.yaml', 'kustomization.yaml'];
}

/**
 * Disponibilité réelle après une CI réussie : on lit l'état observé de Crossplane (serveur, base, Container App) et on
 * n'annonce « déployée » que si la Container App est prête SUR LA RÉVISION attendue. Un échec de création asynchrone
 * remonte avec sa cause ; une simple ReconcileError passagère n'est pas un échec.
 */
async function readiness(dep, revision) {
  const names = azureTemplates.azureNames(dep.appName, config.azure, dep.environment);
  const url = azureTemplates.azureAppUrl(dep.appName, config.azure, dep.environment);
  let status;
  try {
    status = await kubernetes.getAzureAppStatus(dep.appName, {
      serverName: names.server, databaseName: names.database, containerAppName: names.containerApp,
    });
  } catch (_) {
    return { phase: 'deploying', message: 'CI terminée ; vérification de l\'état des ressources Azure indisponible, nouvelle tentative…', cloudRunUrl: null };
  }
  if (status.phase === 'failed') return { phase: 'failed', message: `Azure : ${status.failure}`, cloudRunUrl: null };
  if (status.phase === 'ready') {
    if (status.observedImage === imageRef(dep, revision)) {
      return { phase: 'success', message: 'Application déployée.', cloudRunUrl: url, applicationUrl: url };
    }
    return { phase: 'deploying', message: `Container App prête ; attente de la révision ${String(revision).slice(0, 7)}.`, cloudRunUrl: null };
  }
  return { phase: 'deploying', message: PROGRESS_MESSAGES[status.phase] || 'CI terminée ; création des ressources Azure en cours.', cloudRunUrl: null };
}

/**
 * Confirme qu'un démontage a réellement démarré : après la suppression de l'Application Argo en cascade, au moins
 * une ressource Crossplane doit être en cours de suppression (ou déjà partie). Sans cette preuve, on ne déclare
 * pas la suppression réussie : l'ApplicationSet dev a preserveResourcesOnDeletion et retire le finalizer d'une
 * Application encore présente dans Git ; les ressources Azure resteraient alors orphelines (et facturées).
 */
async function confirmTeardown(dep, { attempts = 10, delayMs = 3000 } = {}) {
  const names = azureTemplates.azureNames(dep.appName, config.azure, dep.environment);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const status = await kubernetes.getAzureAppStatus(dep.appName, {
      serverName: names.server, databaseName: names.database, containerAppName: names.containerApp,
    });
    if (!status.exists) return 'gone';
    if (status.deleting) return 'deleting';
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(
    'La suppression en cascade n\'a pas démarré : les ressources Azure de cet environnement existent toujours et ne sont ' +
    'pas en cours de suppression. Réessayez la suppression ; sinon, supprimez l\'Application Argo CD ' +
    `${dep.appName}-${dep.environment} avec le finalizer resources-finalizer.argocd.argoproj.io.`
  );
}

module.exports = {
  confirmTeardown,
  isAzure, PROGRESS_MESSAGES, validate, assertConfigured, repoVariables, workflow, imageRef, manifests, fileNames, readiness,
};
