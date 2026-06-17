'use strict';

const yaml = require('js-yaml');
const { config } = require('../config/env');
const githubClient = require('../clients/github');
const githubService = require('./github');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConfigRepoName() {
    const name = config.github.configRepoName || 'Mooroon5-CNP/config-repo';
    const [owner, repo] = name.split('/');
    return { owner, repo };
}

// ---------------------------------------------------------------------------
// Config-repo file template generators
// All K8s resource names use appName directly to keep things consistent.
// Image registry matches what pipeline.yml actually builds and pushes to.
// ---------------------------------------------------------------------------

const IMAGE_REGISTRY = 'europe-west9-docker.pkg.dev/cnp-terraform/cnp-registry';

function tplBaseDeployment(appName, appPort) {
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}
  namespace: ${appName}
  labels:
    app.kubernetes.io/name: ${appName}
spec:
  replicas: 1
  progressDeadlineSeconds: 600
  selector:
    matchLabels:
      app.kubernetes.io/name: ${appName}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${appName}
    spec:
      containers:
        - name: ${appName}
          image: ${IMAGE_REGISTRY}/${appName}:latest
          ports:
            - containerPort: ${appPort}
          resources:
            limits:
              cpu: 500m
              memory: 256Mi
            requests:
              cpu: 100m
              memory: 128Mi
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          livenessProbe:
            httpGet:
              path: /healthz
              port: ${appPort}
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /ready
              port: ${appPort}
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: tmp
          emptyDir: {}
`;
}

function tplBaseKustomization() {
    return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml
  - netpol-default-deny.yaml
  - netpol-allow-dns.yaml
  - netpol-allow-ingress-ctrl.yaml
`;
}

function tplBaseService(appName, appPort) {
    return `apiVersion: v1
kind: Service
metadata:
  name: ${appName}
  namespace: ${appName}
  labels:
    app.kubernetes.io/name: ${appName}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: ${appName}
  ports:
    - name: http
      port: 80
      targetPort: ${appPort}
      protocol: TCP
`;
}

function tplNetpolDefaultDeny(appName) {
    return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ${appName}
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
`;
}

function tplNetpolAllowDns(appName) {
    return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: ${appName}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${appName}
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
`;
}

function tplNetpolAllowIngress(appName, appPort) {
    return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-from-ingress-controller
  namespace: ${appName}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${appName}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: ${appPort}
`;
}

function tplOverlayKustomization(appName, env, teamOwner, appPort) {
    const ns = `${appName}-${env}`;
    const configMapName = `${appName}-${env}-config`;
    const patch = env === 'prod'
        ? `\npatches:\n  - target:\n      kind: Deployment\n      name: ${appName}\n    patch: |-\n      apiVersion: apps/v1\n      kind: Deployment\n      metadata:\n        name: ${appName}\n      spec:\n        replicas: 3\n        template:\n          spec:\n            containers:\n              - name: ${appName}\n                envFrom:\n                  - configMapRef:\n                      name: ${configMapName}\n`
        : `\npatches:\n  - target:\n      kind: Deployment\n      name: ${appName}\n    patch: |-\n      apiVersion: apps/v1\n      kind: Deployment\n      metadata:\n        name: ${appName}\n      spec:\n        template:\n          spec:\n            containers:\n              - name: ${appName}\n                envFrom:\n                  - configMapRef:\n                      name: ${configMapName}\n`;

    const resources = env === 'dev'
        ? `  - ../../base\n  - namespace.yaml\n  - configmap.yaml\n  - ingress.yaml`
        : `  - ../../base\n  - namespace.yaml\n  - configmap.yaml\n  - ingress.yaml`;

    return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
${resources}

namespace: ${ns}

labels:
  - pairs:
      app.kubernetes.io/name: ${appName}
      app.kubernetes.io/version: "1.0.0"
      app.kubernetes.io/owner: ${teamOwner}
      cost-center: projet-epita
    includeSelectors: false

images:
  - name: ${IMAGE_REGISTRY}/${appName}
    newTag: "placeholder"
${patch}`;
}

function tplOverlayNamespace(appName, env) {
    return `apiVersion: v1
kind: Namespace
metadata:
  name: ${appName}-${env}
  labels:
    pod-security.kubernetes.io/enforce: baseline
`;
}

function tplOverlayConfigMap(appName, env) {
    return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${appName}-${env}-config
data:
  LOG_LEVEL: "INFO"
  DD_ENV: "${env}"
  DD_SERVICE: "${appName}"
  DD_VERSION: "1.0.0"
`;
}

function tplOverlayIngress(appName, env, appPort) {
    const host = `${appName}-${env}.cnp.example.com`;
    return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${appName}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - ${host}
      secretName: ${appName}-${env}-tls
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${appName}
                port:
                  number: 80
`;
}

function tplCiWorkflow(appName, appPort, configRepoUrl) {
    return `name: CI

on:
  push:
    branches: [main, prod]

permissions:
  contents: read
  id-token: write

jobs:
  pipeline:
    uses: Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@main
    with:
      app_name: "${appName}"
      app_port: "${appPort}"
      config_repo_url: "${configRepoUrl}"
    secrets:
      CONFIG_REPO_TOKEN: \${{ secrets.CONFIG_REPO_TOKEN }}
`;
}

// ---------------------------------------------------------------------------
// Config-repo write helpers (via PAT)
// ---------------------------------------------------------------------------

async function writeConfigRepoFile(owner, repo, path, content, token) {
    const sha = await githubService.getFileSha(owner, repo, path, token);
    await githubService.createOrUpdateFileWithToken(
        owner, repo, path, content,
        `chore: add ${path} via CNP Portal`,
        token,
        sha,
    );
}

async function updateRegistry(owner, repo, appName, appPort, repoUrl, teamOwner, token) {
    const path = 'apps/registry.yaml';
    const sha = await githubService.getFileSha(owner, repo, path, token);
    let doc = { version: '1.0', apps: [] };
    if (sha) {
        const raw = await githubService.getFileContent(owner, repo, path, token);
        if (raw) {
            try { doc = yaml.load(raw) || doc; } catch (_) {}
        }
    }
    if (!Array.isArray(doc.apps)) doc.apps = [];

    // Skip if already registered.
    if (doc.apps.some(a => a.app_name === appName)) return;

    doc.apps.push({
        app_name: appName,
        team_owner: teamOwner,
        app_port: appPort,
        repo_url: repoUrl,
        clusters: ['local'],
        environments: ['dev', 'prod'],
        description: `Application deployed via CNP Portal`,
    });

    const newContent = yaml.dump(doc, { lineWidth: -1, noRefs: true });
    await githubService.createOrUpdateFileWithToken(
        owner, repo, path, newContent,
        `chore(registry): register ${appName} via CNP Portal`,
        token,
        sha,
    );
}

// ---------------------------------------------------------------------------
// Main onboarding function
// ---------------------------------------------------------------------------

/**
 * Provisions everything needed to deploy an app through the CNP platform:
 *   1. Creates the K8s manifest structure in config-repo (base + overlays).
 *   2. Registers the app in config-repo/apps/registry.yaml.
 *   3. Creates .github/workflows/ci.yml in the app repo (GitHub App).
 *   4. Injects CONFIG_REPO_TOKEN as an Actions secret in the app repo (GitHub App).
 *   5. Creates the `prod` branch in the app repo (GitHub App).
 *
 * Committing ci.yml to main counts as a push and automatically triggers the
 * first CI run — no extra dispatch step is needed.
 *
 * @param {object} opts
 * @param {string} opts.appName        - App name (matches config-repo directory).
 * @param {string} opts.githubRepoUrl  - HTTPS URL of the application repository.
 * @param {number} opts.appPort        - Container port.
 * @param {string} [opts.teamOwner]    - Team slug (default: team-cnp).
 * @param {Function} opts.updateStatus - Callback(status, error?) to persist progress.
 */
async function onboardApp({ appName, githubRepoUrl, appPort, teamOwner = 'team-cnp', updateStatus }) {
    const configRepoToken = config.github.configRepoToken;
    if (!configRepoToken) {
        await updateStatus('failed', 'GITHUB_CONFIG_REPO_TOKEN is not configured on the platform.');
        return;
    }

    const { owner: crOwner, repo: crRepo } = parseConfigRepoName();
    const configRepoUrl = `https://github.com/${crOwner}/${crRepo}`;

    const parsed = githubService.parseRepoUrl(githubRepoUrl);
    if (!parsed) {
        await updateStatus('failed', `Invalid GitHub repository URL: ${githubRepoUrl}`);
        return;
    }
    const { owner: appOwner, repo: appRepo } = parsed;

    try {
        // ------------------------------------------------------------------
        // Step 1: Create config-repo base manifests
        // ------------------------------------------------------------------
        const base = `apps/${appName}/base`;
        await writeConfigRepoFile(crOwner, crRepo, `${base}/deployment.yaml`, tplBaseDeployment(appName, appPort), configRepoToken);
        await writeConfigRepoFile(crOwner, crRepo, `${base}/kustomization.yaml`, tplBaseKustomization(), configRepoToken);
        await writeConfigRepoFile(crOwner, crRepo, `${base}/service.yaml`, tplBaseService(appName, appPort), configRepoToken);
        await writeConfigRepoFile(crOwner, crRepo, `${base}/netpol-default-deny.yaml`, tplNetpolDefaultDeny(appName), configRepoToken);
        await writeConfigRepoFile(crOwner, crRepo, `${base}/netpol-allow-dns.yaml`, tplNetpolAllowDns(appName), configRepoToken);
        await writeConfigRepoFile(crOwner, crRepo, `${base}/netpol-allow-ingress-ctrl.yaml`, tplNetpolAllowIngress(appName, appPort), configRepoToken);

        // ------------------------------------------------------------------
        // Step 2: Create config-repo overlay manifests (dev + prod)
        // ------------------------------------------------------------------
        for (const env of ['dev', 'prod']) {
            const overlay = `apps/${appName}/overlays/${env}`;
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/kustomization.yaml`, tplOverlayKustomization(appName, env, teamOwner, appPort), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/namespace.yaml`, tplOverlayNamespace(appName, env), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/configmap.yaml`, tplOverlayConfigMap(appName, env), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/ingress.yaml`, tplOverlayIngress(appName, env, appPort), configRepoToken);
        }

        // ------------------------------------------------------------------
        // Step 3: Register app in registry.yaml
        // ------------------------------------------------------------------
        await updateRegistry(crOwner, crRepo, appName, appPort, githubRepoUrl, teamOwner, configRepoToken);

        // ------------------------------------------------------------------
        // Step 4: Create ci.yml in the app repo (GitHub App)
        // Committing this file to main automatically triggers the first CI run.
        // ------------------------------------------------------------------
        const ciContent = tplCiWorkflow(appName, appPort, configRepoUrl);
        const ciPath = '.github/workflows/ci.yml';
        const ciSha = await githubClient.getFileSha(appOwner, appRepo, ciPath);
        await githubClient.createOrUpdateFile(
            appOwner, appRepo, ciPath, ciContent,
            `ci: add CNP pipeline via CNP Portal [ci skip]`,
            ciSha,
        );

        // ------------------------------------------------------------------
        // Step 5: Inject CONFIG_REPO_TOKEN secret into app repo (GitHub App)
        // ------------------------------------------------------------------
        await githubClient.setRepoSecret(appOwner, appRepo, 'CONFIG_REPO_TOKEN', configRepoToken);

        // ------------------------------------------------------------------
        // Step 6: Create prod branch if it doesn't already exist (GitHub App)
        // ------------------------------------------------------------------
        const mainSha = await githubClient.getRef(appOwner, appRepo, 'main');
        await githubClient.createBranch(appOwner, appRepo, 'prod', mainSha);

        // ------------------------------------------------------------------
        // Done — trigger an actual CI run by committing an empty trigger commit
        // to main. The ci.yml commit above may have had [ci skip] so this
        // ensures the pipeline starts immediately.
        // ------------------------------------------------------------------
        const triggerPath = '.cnp-platform';
        const triggerSha = await githubClient.getFileSha(appOwner, appRepo, triggerPath);
        await githubClient.createOrUpdateFile(
            appOwner, appRepo, triggerPath,
            `Managed by CNP Portal. Do not delete.\nOnboarded: ${new Date().toISOString()}\n`,
            `chore: trigger initial CNP pipeline run`,
            triggerSha,
        );

        await updateStatus('ready', null);
    } catch (err) {
        await updateStatus('failed', err.message);
    }
}

module.exports = { onboardApp };
