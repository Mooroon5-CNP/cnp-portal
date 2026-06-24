'use strict';

const yaml = require('js-yaml');
const { config } = require('../config/env');
const githubClient = require('../clients/github');
const githubService = require('./github');
const k8sClient = require('../clients/kubernetes');

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

const IMAGE_REGISTRY = config.gcp.imageRegistry;

function tplBaseDeployment(appName, appPort, persistentStorage = false) {
    // Always mount /data so apps using DATA_DIR start correctly even without a PVC.
    // persistentStorage=true swaps the emptyDir for a PVC (data survives restarts).
    const dataVolumeMount = `\n            - name: data\n              mountPath: /data`;
    const dataVolume = persistentStorage
        ? `\n        - name: data\n          persistentVolumeClaim:\n            claimName: ${appName}-data`
        : `\n        - name: data\n          emptyDir: {}`;
    const dataEnv = `\n          env:\n            - name: DATA_DIR\n              value: /data`;
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
            - containerPort: ${appPort}${dataEnv}
          resources:
            limits:
              cpu: 500m
              memory: 256Mi
            requests:
              cpu: 100m
              memory: 128Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: tmp
              mountPath: /tmp${dataVolumeMount}
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
          emptyDir: {}${dataVolume}
`;
}

function tplOverlayPvc(appName, env) {
    return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${appName}-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
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

function tplOverlayKustomization(appName, env, teamOwner, appPort, persistentStorage = false) {
    const ns = `${appName}-${env}`;
    const configMapName = `${appName}-${env}-config`;
    const patch = env === 'prod'
        ? `\npatches:\n  - target:\n      kind: Deployment\n      name: ${appName}\n    patch: |-\n      apiVersion: apps/v1\n      kind: Deployment\n      metadata:\n        name: ${appName}\n      spec:\n        replicas: 3\n        template:\n          spec:\n            containers:\n              - name: ${appName}\n                envFrom:\n                  - configMapRef:\n                      name: ${configMapName}\n`
        : `\npatches:\n  - target:\n      kind: Deployment\n      name: ${appName}\n    patch: |-\n      apiVersion: apps/v1\n      kind: Deployment\n      metadata:\n        name: ${appName}\n      spec:\n        template:\n          spec:\n            containers:\n              - name: ${appName}\n                envFrom:\n                  - configMapRef:\n                      name: ${configMapName}\n`;

    const pvcLine = persistentStorage ? `\n  - pvc.yaml` : '';
    const resources = `  - ../../base\n  - namespace.yaml\n  - configmap.yaml\n  - ingress.yaml${pvcLine}`;

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

async function tplOverlayIngress(appName, env) {
    // Resolve base domain: explicit config wins, then auto-detect from cluster.
    let baseDomain = config.cluster?.baseDomain || null;
    if (!baseDomain || baseDomain === 'cnp.example.com') {
        const ip = await k8sClient.getIngressControllerIp().catch(() => null);
        baseDomain = ip ? `${ip}.nip.io` : 'cnp.example.com';
    }
    const host = `${appName}-${env}.${baseDomain}`;
    // Only add TLS if cert-manager is available on the cluster.
    const certManagerAvailable = await k8sClient.isCertManagerAvailable().catch(() => false);
    const tlsBlock = certManagerAvailable ? `  tls:
    - hosts:
        - ${host}
      secretName: ${appName}-${env}-tls
` : '';
    const certAnnotation = certManagerAvailable
        ? '    cert-manager.io/cluster-issuer: letsencrypt-prod\n'
        : '';
    return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${appName}
  annotations:
${certAnnotation}    nginx.ingress.kubernetes.io/ssl-redirect: "${certManagerAvailable}"
spec:
  ingressClassName: nginx
${tlsBlock}  rules:
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

const GCP_PROJECT  = config.gcp.project;
const GCP_REGION   = config.gcp.region;
const CLOUD_RUN_SA = config.gcp.cloudRunSa;

function tplCrossplaneV2Service(appName) {
    return `apiVersion: cloudrun.gcp.upbound.io/v1beta2
kind: V2Service
metadata:
  name: ${appName}
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  forProvider:
    project: ${GCP_PROJECT}
    location: ${GCP_REGION}
    template:
      serviceAccount: ${CLOUD_RUN_SA}
      containers:
        - image: ${IMAGE_REGISTRY}/${appName}:placeholder
  providerConfigRef:
    name: default
`;
}

function tplCrossplaneIAM(appName) {
    return `apiVersion: cloudrun.gcp.upbound.io/v1beta2
kind: ServiceIAMMember
metadata:
  name: ${appName}-public
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  forProvider:
    project: ${GCP_PROJECT}
    location: ${GCP_REGION}
    service: ${appName}
    role: roles/run.invoker
    member: allUsers
  providerConfigRef:
    name: default
`;
}

function tplCrossplaneKustomization() {
    return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - cloudrun-claim.yaml
  - cloudrun-iam.yaml
`;
}

function tplCrossplaneArgocdApplication(appName, configRepoUrl) {
    return {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: `${appName}-cloudrun`, namespace: 'argocd' },
        spec: {
            project: 'default',
            source: {
                repoURL: `${configRepoUrl}.git`,
                targetRevision: 'main',
                path: `apps/${appName}/crossplane`,
            },
            destination: {
                server: 'https://kubernetes.default.svc',
                namespace: 'crossplane-system',
            },
            syncPolicy: {
                automated: { selfHeal: true, prune: true },
                syncOptions: ['CreateNamespace=true'],
            },
        },
    };
}

function tplArgocdOverlayKustomization(appName, teamOwner) {
    return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../bases/applicationset

patches:
  - target:
      group: argoproj.io
      version: v1alpha1
      kind: ApplicationSet
      name: APP_NAME-dev
    patch: |-
      - op: replace
        path: /metadata/name
        value: ${appName}-dev
      - op: replace
        path: /spec/template/metadata/name
        value: "${appName}-dev-{{cluster}}"
      - op: replace
        path: /spec/template/spec/source/path
        value: apps/${appName}/overlays/dev
      - op: replace
        path: /spec/template/spec/destination/namespace
        value: ${appName}-dev
      - op: replace
        path: /spec/template/spec/project
        value: ${teamOwner}

  - target:
      group: argoproj.io
      version: v1alpha1
      kind: ApplicationSet
      name: APP_NAME-prod
    patch: |-
      - op: replace
        path: /metadata/name
        value: ${appName}-prod
      - op: replace
        path: /spec/template/metadata/name
        value: "${appName}-prod-{{cluster}}"
      - op: replace
        path: /spec/template/spec/source/path
        value: apps/${appName}/overlays/prod
      - op: replace
        path: /spec/template/spec/destination/namespace
        value: ${appName}-prod
      - op: replace
        path: /spec/template/spec/project
        value: ${teamOwner}

labels:
  - pairs:
      app: ${appName}
      team: ${teamOwner}
    includeSelectors: false
`;
}

// Returns the in-memory ApplicationSet manifests (dev + prod) so they can be
// applied directly to the cluster without needing to run kustomize CLI.
function buildApplicationSetManifests(appName, teamOwner, configRepoUrl) {
    const repoURL = `${configRepoUrl}.git`;
    const dev = {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'ApplicationSet',
        metadata: { name: `${appName}-dev`, namespace: 'argocd' },
        spec: {
            generators: [{ list: { elements: [{ cluster: 'local', url: 'https://kubernetes.default.svc', env: 'dev' }] } }],
            template: {
                metadata: { name: `${appName}-dev-{{cluster}}` },
                spec: {
                    project: teamOwner,
                    source: { repoURL, targetRevision: 'main', path: `apps/${appName}/overlays/dev` },
                    destination: { server: '{{url}}', namespace: `${appName}-dev` },
                    syncPolicy: {
                        automated: { selfHeal: true, prune: true },
                        syncOptions: ['CreateNamespace=true'],
                        retry: { limit: 3, backoff: { duration: '10s', factor: 2, maxDuration: '3m' } },
                    },
                },
            },
        },
    };
    const prod = {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'ApplicationSet',
        metadata: { name: `${appName}-prod`, namespace: 'argocd' },
        spec: {
            generators: [{ list: { elements: [{ cluster: 'local', url: 'https://kubernetes.default.svc', env: 'prod' }] } }],
            template: {
                metadata: { name: `${appName}-prod-{{cluster}}` },
                spec: {
                    project: teamOwner,
                    source: { repoURL, targetRevision: 'main', path: `apps/${appName}/overlays/prod` },
                    destination: { server: '{{url}}', namespace: `${appName}-prod` },
                    syncPolicy: {
                        syncOptions: ['CreateNamespace=true'],
                        retry: { limit: 3, backoff: { duration: '10s', factor: 2, maxDuration: '3m' } },
                    },
                },
            },
        },
    };
    return { dev, prod };
}

function tplCiWorkflow(appName, appPort, configRepoUrl, targetCluster = 'gcp') {
    // GCP apps deploy via Crossplane Cloud Run — update cloudrun-claim.yaml on every main push
    // so ArgoCD picks up the new image and Crossplane reconciles the Cloud Run service.
    const cloudRunJob = targetCluster === 'gcp' ? `
  update-cloudrun-claim:
    needs: pipeline
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: Mooroon5-CNP/config-repo
          token: \${{ secrets.CONFIG_REPO_TOKEN }}
      - name: Update Cloud Run image tag
        run: |
          sed -i "s|image: ${IMAGE_REGISTRY}/${appName}:.*|image: ${IMAGE_REGISTRY}/${appName}:\${{ github.sha }}|" \\
            apps/${appName}/crossplane/cloudrun-claim.yaml
          git config user.email "ci-bot@cnp"
          git config user.name "CI Bot"
          git add apps/${appName}/crossplane/cloudrun-claim.yaml
          git diff --staged --quiet && exit 0
          git commit -m "ci(${appName}): cloud run → \${{ github.sha }}"
          for i in 1 2 3; do
            git pull --rebase && git push && break || sleep 5
          done
` : '';

    return `name: CI

on:
  push:
    branches: [main]

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
      target_cloud: "${targetCluster === 'aws' ? 'aws' : 'gcp'}"
    secrets:
      CONFIG_REPO_TOKEN: \${{ secrets.CONFIG_REPO_TOKEN }}
${cloudRunJob}`;
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
async function onboardApp({ appName, githubRepoUrl, appPort, teamOwner = 'platform', targetCluster = 'gcp', persistentStorage = false, updateStatus }) {
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

    let appSetWarning = null;
    try {
        // ------------------------------------------------------------------
        // Pre-check: verify GitHub App can access Actions secrets on app repo.
        // Returns 404 when Actions is disabled on the repo (repo settings →
        // Actions → General must be set to "Allow all actions").
        // ------------------------------------------------------------------
        try {
            await githubClient.checkActionsEnabled(appOwner, appRepo);
        } catch (e) {
            await updateStatus('failed',
                `GitHub Actions est désactivé sur le dépôt ${appOwner}/${appRepo}. ` +
                `Allez dans Settings → Actions → General et activez "Allow all actions".`
            );
            return;
        }

        // ------------------------------------------------------------------
        // Step 1: Create config-repo base manifests
        // ------------------------------------------------------------------
        const base = `apps/${appName}/base`;
        await writeConfigRepoFile(crOwner, crRepo, `${base}/deployment.yaml`, tplBaseDeployment(appName, appPort, persistentStorage), configRepoToken);
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
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/kustomization.yaml`, tplOverlayKustomization(appName, env, teamOwner, appPort, persistentStorage), configRepoToken);
            if (persistentStorage) {
                await writeConfigRepoFile(crOwner, crRepo, `${overlay}/pvc.yaml`, tplOverlayPvc(appName, env), configRepoToken);
            }
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/namespace.yaml`, tplOverlayNamespace(appName, env), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/configmap.yaml`, tplOverlayConfigMap(appName, env), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${overlay}/ingress.yaml`, await tplOverlayIngress(appName, env), configRepoToken);
        }

        // ------------------------------------------------------------------
        // Step 3: Register app in registry.yaml
        // ------------------------------------------------------------------
        await updateRegistry(crOwner, crRepo, appName, appPort, githubRepoUrl, teamOwner, configRepoToken);

        // ------------------------------------------------------------------
        // Step 3.5: Create ArgoCD ApplicationSet overlay in config-repo and
        // apply the ApplicationSets to the cluster (AWS/non-GCP only).
        // GCP apps deploy via Crossplane Cloud Run — no GKE ApplicationSets needed.
        // ------------------------------------------------------------------
        if (targetCluster !== 'gcp') {
            await writeConfigRepoFile(
                crOwner, crRepo,
                `argocd/overlays/${appName}/kustomization.yaml`,
                tplArgocdOverlayKustomization(appName, teamOwner),
                configRepoToken,
            );

            const { dev: devAppSet, prod: prodAppSet } = buildApplicationSetManifests(appName, teamOwner, configRepoUrl);
            try {
                await k8sClient.applyApplicationSet(devAppSet);
                await k8sClient.applyApplicationSet(prodAppSet);
            } catch (e) {
                console.warn(`[onboarding] Could not apply ApplicationSets to cluster: ${e.message}`);
                appSetWarning = `⚠️ ApplicationSets non appliqués : ${e.message}`;
            }
        }

        // ------------------------------------------------------------------
        // Step 3.6: Create Crossplane Cloud Run resources in config-repo and
        // apply the ArgoCD Application that watches them (GCP only).
        // ------------------------------------------------------------------
        if (targetCluster === 'gcp') {
            const cpBase = `apps/${appName}/crossplane`;
            await writeConfigRepoFile(crOwner, crRepo, `${cpBase}/cloudrun-claim.yaml`, tplCrossplaneV2Service(appName), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${cpBase}/cloudrun-iam.yaml`, tplCrossplaneIAM(appName), configRepoToken);
            await writeConfigRepoFile(crOwner, crRepo, `${cpBase}/kustomization.yaml`, tplCrossplaneKustomization(), configRepoToken);

            const argoApp = tplCrossplaneArgocdApplication(appName, configRepoUrl);
            const argoAppYaml = yaml.dump(argoApp, { lineWidth: -1, noRefs: true });
            await writeConfigRepoFile(crOwner, crRepo, `${cpBase}/application.yaml`, argoAppYaml, configRepoToken);
        }

        // ------------------------------------------------------------------
        // Step 4: Create ci.yml in the app repo (GitHub App)
        // Committing this file to main automatically triggers the first CI run.
        // ------------------------------------------------------------------
        const ciContent = tplCiWorkflow(appName, appPort, configRepoUrl, targetCluster);
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
        try {
            await githubClient.setRepoSecret(appOwner, appRepo, 'CONFIG_REPO_TOKEN', configRepoToken);
        } catch (e) {
            // Surface clearly — CI will fail without this secret
            throw new Error(
                `Impossible d'injecter CONFIG_REPO_TOKEN sur ${appOwner}/${appRepo}: ${e.message}. ` +
                `Vérifiez que le GitHub App a la permission "secrets: write" sur ce dépôt.`
            );
        }

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

        await updateStatus('ready', appSetWarning);
    } catch (err) {
        await updateStatus('failed', err.message);
    }
}

// Known config-repo file paths for an app (mirrors what onboardApp creates).
function configRepoPaths(appName) {
    const base = `apps/${appName}/base`;
    const paths = [
        `${base}/deployment.yaml`,
        `${base}/kustomization.yaml`,
        `${base}/service.yaml`,
        `${base}/netpol-default-deny.yaml`,
        `${base}/netpol-allow-dns.yaml`,
        `${base}/netpol-allow-ingress-ctrl.yaml`,
    ];
    for (const env of ['dev', 'prod']) {
        const ov = `apps/${appName}/overlays/${env}`;
        paths.push(`${ov}/kustomization.yaml`, `${ov}/namespace.yaml`, `${ov}/configmap.yaml`, `${ov}/ingress.yaml`, `${ov}/pvc.yaml`);
    }
    paths.push(`argocd/overlays/${appName}/kustomization.yaml`);
    const cp = `apps/${appName}/crossplane`;
    paths.push(`${cp}/cloudrun-claim.yaml`, `${cp}/cloudrun-iam.yaml`, `${cp}/kustomization.yaml`, `${cp}/application.yaml`);
    return paths;
}

async function removeFromRegistry(owner, repo, appName, token) {
    const path = 'apps/registry.yaml';
    const sha = await githubService.getFileSha(owner, repo, path, token);
    if (!sha) return;
    const raw = await githubService.getFileContent(owner, repo, path, token);
    if (!raw) return;
    let doc;
    try { doc = yaml.load(raw); } catch (_) { return; }
    if (!doc || !Array.isArray(doc.apps)) return;
    const before = doc.apps.length;
    doc.apps = doc.apps.filter(a => a.app_name !== appName);
    if (doc.apps.length === before) return; // wasn't there
    const newContent = yaml.dump(doc, { lineWidth: -1, noRefs: true });
    await githubService.createOrUpdateFileWithToken(
        owner, repo, path, newContent,
        `chore(registry): remove ${appName} via CNP Portal`,
        token, sha,
    );
}

/**
 * Removes everything the platform created for an app:
 *   1. Deletes all K8s manifests from config-repo (including argocd overlay).
 *   2. Removes the app from registry.yaml.
 *   3. Deletes ArgoCD ApplicationSets from the cluster.
 *   4. Deletes .github/workflows/ci.yml from the app repo (GitHub App).
 *   5. Deletes CONFIG_REPO_TOKEN secret from the app repo (GitHub App).
 */
async function offboardApp({ appName, githubRepoUrl }) {
    const configRepoToken = config.github.configRepoToken;
    const { owner: crOwner, repo: crRepo } = parseConfigRepoName();
    const parsed = githubService.parseRepoUrl(githubRepoUrl);

    const errors = [];

    // Step 1 & 2: config-repo cleanup via PAT
    if (configRepoToken) {
        const paths = configRepoPaths(appName);
        for (const path of paths) {
            try {
                const sha = await githubService.getFileSha(crOwner, crRepo, path, configRepoToken);
                if (sha) {
                    await githubService.deleteFileWithToken(
                        crOwner, crRepo, path, sha,
                        `chore: remove ${path} (app deleted via CNP Portal)`,
                        configRepoToken,
                    );
                }
            } catch (e) {
                errors.push(`config-repo ${path}: ${e.message}`);
            }
        }
        try {
            await removeFromRegistry(crOwner, crRepo, appName, configRepoToken);
        } catch (e) {
            errors.push(`registry.yaml: ${e.message}`);
        }
    }

    // Step 3: delete ArgoCD ApplicationSets and Applications from the cluster
    for (const env of ['dev', 'prod']) {
        try {
            await k8sClient.deleteApplicationSet(`${appName}-${env}`);
        } catch (e) {
            errors.push(`applicationset ${appName}-${env}: ${e.message}`);
        }
        try {
            await k8sClient.deleteArgocdApplication(`${appName}-${env}-local`);
        } catch (e) {
            errors.push(`argocd application ${appName}-${env}-local: ${e.message}`);
        }
    }
    // Delete Cloud Run ArgoCD Application (GCP apps using Crossplane).
    try {
        await k8sClient.deleteArgocdApplication(`${appName}-cloudrun`);
    } catch (e) {
        errors.push(`argocd application ${appName}-cloudrun: ${e.message}`);
    }

    // Step 3.5: delete K8s namespaces (removes all pods, services, ingresses, configmaps)
    for (const env of ['dev', 'prod']) {
        try {
            await k8sClient.deleteNamespace(`${appName}-${env}`);
        } catch (e) {
            errors.push(`namespace ${appName}-${env}: ${e.message}`);
        }
    }

    // Step 4 & 5: app repo cleanup via GitHub App
    if (parsed) {
        const { owner: appOwner, repo: appRepo } = parsed;
        try {
            const ciSha = await githubClient.getFileSha(appOwner, appRepo, '.github/workflows/ci.yml');
            if (ciSha) {
                await githubClient.deleteFile(
                    appOwner, appRepo, '.github/workflows/ci.yml', ciSha,
                    'chore: remove CNP pipeline (app deleted via CNP Portal)',
                );
            }
        } catch (e) {
            errors.push(`ci.yml: ${e.message}`);
        }
        try {
            await githubClient.deleteSecret(appOwner, appRepo, 'CONFIG_REPO_TOKEN');
        } catch (e) {
            errors.push(`secret: ${e.message}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(`Partial cleanup — some resources could not be removed:\n${errors.join('\n')}`);
    }
}

/**
 * Rewrite ingress.yaml in config-repo for an already-onboarded app so that the
 * hostname uses the real ingress controller IP instead of the placeholder domain.
 * Called automatically when the detail page detects a placeholder URL.
 */
async function healIngressHostname(appName) {
    const configRepoToken = config.github.configRepoToken;
    if (!configRepoToken) return;

    let baseDomain = config.cluster?.baseDomain || null;
    if (!baseDomain || baseDomain === 'cnp.example.com') {
        const ip = await k8sClient.getIngressControllerIp().catch(() => null);
        if (!ip) return;
        baseDomain = `${ip}.nip.io`;
    }

    const { owner: crOwner, repo: crRepo } = parseConfigRepoName();

    for (const env of ['dev', 'prod']) {
        const ingressYaml = await tplOverlayIngress(appName, env);
        const path = `apps/${appName}/overlays/${env}/ingress.yaml`;
        try {
            await writeConfigRepoFile(crOwner, crRepo, path, ingressYaml, configRepoToken);
        } catch (e) {
            console.warn(`[healIngress] Could not update ${path}: ${e.message}`);
        }
    }
}

module.exports = { onboardApp, offboardApp, healIngressHostname };
