'use strict';

/**
 * Chemin cloud privé (k3s sur une VM AWS) du service d'environnements dev/prod (environment-deployment.js).
 *
 * Même mécanique que GCP et Azure : à l'onboarding le portail prépare le dépôt (workflow, secret, ApplicationSet par
 * environnement) ; les manifestes ne sont écrits qu'APRÈS une CI réussie, avec la révision exacte (tag de l'image = SHA
 * du commit). Dev : commit direct sur main du config-repo. Prod : PR approuvée par un manager puis mergée par la GitHub
 * App (protect-prod-paths couvre apps/*\/crossplane/prod/).
 *
 * Ce fichier ne contient que ce qui diffère : workflow (pipeline.yml, cible « aws » = image dans l'ECR, aucune variable
 * de dépôt), manifestes (Object de provider-kubernetes, private-templates.js), état lu sur les Object, adresse publique
 * sous le domaine du cloud privé. Aucun mot de passe à préparer côté portail : ils sont générés dans k3s.
 */

const yaml = require('js-yaml');
const { config, getMissingPrivateVars } = require('../config/env');
const kubernetes = require('../clients/kubernetes');
const templates = require('./private-templates');

const TARGET = 'private-aws';
const isPrivate = dep => !!dep && dep.targetCluster === TARGET;

const PROGRESS_MESSAGES = {
  'waiting-argocd': 'Pipeline terminé. En attente de la synchronisation d\'Argo CD…',
  applying: 'Pipeline terminé. Création de l\'environnement dans le cloud privé (namespace, base, application)…',
  rollout: 'Objets en place. Démarrage de la nouvelle version (base PostgreSQL au premier déploiement : ~1 min)…',
};

function validate(appName) {
  templates.validatePrivateAppName(appName);
}

/** Échoue AVANT toute écriture si la plateforme n'a pas la configuration du cloud privé (variables PRIVATE_*). */
function assertConfigured() {
  const missing = getMissingPrivateVars(config.private);
  if (missing.length > 0) {
    throw new Error(`Le cloud privé n'est pas configuré sur la plateforme. Variables manquantes : ${missing.join(', ')}.`);
  }
}

/**
 * Pipeline commun (pipeline.yml) avec target_cloud « aws » : construit, scanne et pousse l'image dans l'ECR
 * (<registre>/<app>:<sha>), rôle OIDC github-ecr-push-role. Aucune variable de dépôt nécessaire.
 */
function workflow(dep, workflowRef) {
  const configRepo = config.github.configRepoName || 'Mooroon5-CNP/config-repo';
  return yaml.dump({
    name: `CNP — ${dep.appName}`,
    on: { push: { branches: ['main', 'prod'] }, workflow_dispatch: {} },
    permissions: { contents: 'read', 'id-token': 'write' },
    concurrency: { group: `cnp-${dep.appName}-\${{ github.ref }}`, 'cancel-in-progress': false },
    jobs: {
      pipeline: {
        uses: `Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@${workflowRef || 'main'}`,
        with: {
          app_name: dep.appName,
          target_cloud: 'aws',
          config_repo_url: `https://github.com/${configRepo}`,
          gitops_mode: 'portal',
          app_port: String(dep.appPort || 8080),
        },
        secrets: { CONFIG_REPO_TOKEN: '${{ secrets.CONFIG_REPO_TOKEN }}' },
      },
    },
  }, { lineWidth: -1 });
}

function imageRef(dep, revision) {
  return `${config.private.ecrRegistry}/${dep.appName}:${revision}`;
}

/** Fichiers d'un environnement : { 'apps/<app>/crossplane/<env>/<fichier>': contenu }. */
function manifests(dep, revision) {
  assertConfigured();
  const dir = `apps/${dep.appName}/crossplane/${dep.environment}`;
  const files = templates.privateCrossplaneFiles(dep.appName, dep.appPort, config.private, dep.environment, revision);
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`${dir}/${name}`, content]));
}

/** Noms de fichiers d'un environnement (suppression). */
function fileNames() {
  return [...templates.FILES];
}

function appUrl(dep) {
  return templates.privateAppUrl(dep.appName, config.private, dep.environment);
}

/**
 * L'adresse publique répond-elle ? Toute réponse HTTP prouve que DNS, Traefik et certificat sont en place (certificat
 * vérifié par fetch) ; une erreur réseau ou TLS non. Le certificat Let's Encrypt est demandé à la création de l'Ingress.
 */
async function publicAddressAnswers(url) {
  try {
    await fetch(`${url}/health`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Disponibilité réelle après une CI réussie : tous les Object appliqués, Deployment observé dans k3s sur l'image
 * attendue et déploiement progressif terminé (les sondes /health des pods ont réussi), puis adresse HTTPS joignable.
 * Une ReconcileError passagère n'est pas un échec ; un délai de déploiement dépassé, si.
 */
async function readiness(dep, revision) {
  const url = appUrl(dep);
  let status;
  try {
    status = await kubernetes.getPrivateAppStatus(dep.appName, dep.environment, { expectedImage: imageRef(dep, revision) });
  } catch (_) {
    return { phase: 'deploying', message: 'CI terminée ; vérification de l\'état du cloud privé indisponible, nouvelle tentative…', cloudRunUrl: null };
  }
  if (status.phase === 'failed') return { phase: 'failed', message: `Cloud privé : ${status.failure}`, cloudRunUrl: null };
  if (status.phase === 'ready') {
    if (url && !(await publicAddressAnswers(url))) {
      return { phase: 'deploying', message: 'Application démarrée ; certificat HTTPS en cours d\'obtention (moins d\'une minute).', cloudRunUrl: null };
    }
    return { phase: 'success', message: 'Application déployée.', cloudRunUrl: url, applicationUrl: url };
  }
  if (status.phase === 'rollout' && status.observedImage && status.observedImage !== imageRef(dep, revision)) {
    return { phase: 'deploying', message: `Attente de la révision ${String(revision).slice(0, 7)} dans le cloud privé.`, cloudRunUrl: null };
  }
  const detail = status.phase === 'applying' && status.detail ? ` (${status.detail})` : '';
  return { phase: 'deploying', message: `${PROGRESS_MESSAGES[status.phase] || 'CI terminée ; déploiement en cours.'}${detail}`, cloudRunUrl: null };
}

/**
 * Confirme qu'un démontage a réellement démarré, comme pour Azure : après la cascade de l'Application Argo, les Object
 * doivent être en cours de suppression ou partis (le provider supprime alors le namespace dans k3s, base comprise).
 */
async function confirmTeardown(dep, { attempts = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const status = await kubernetes.getPrivateAppStatus(dep.appName, dep.environment);
    if (!status.exists) return 'gone';
    if (status.deleting) return 'deleting';
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(
    'La suppression en cascade n\'a pas démarré : les objets de cet environnement existent toujours dans le cloud privé et ne ' +
    'sont pas en cours de suppression. Réessayez la suppression ; sinon, supprimez l\'Application Argo CD ' +
    `${dep.appName}-${dep.environment} avec le finalizer resources-finalizer.argocd.argoproj.io.`
  );
}

module.exports = {
  TARGET, isPrivate, PROGRESS_MESSAGES, validate, assertConfigured, workflow, imageRef, manifests, fileNames, appUrl,
  readiness, confirmTeardown,
};
