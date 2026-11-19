'use strict';

/**
 * Gabarits du tier cloud privé (k3s sur une VM AWS ; dépôt cnp, Runbook/CLOUD-PRIVE-K3S.md).
 *
 * Même chemin que GCP et Azure : `apps/<app>/crossplane/<env>/`, repris par les ApplicationSet
 * crossplane-autodiscovery-<env> (Argo synchronise dans GKE). La cible étant un cluster Kubernetes et non une API
 * cloud, chaque objet de l'app est ENVELOPPÉ dans un `Object` de provider-kubernetes (ProviderConfig « cnp-prive »),
 * qui l'écrit dans k3s. Un namespace `<app>-<env>` par app et par environnement, isolé (cadrage §6) :
 *   - Pod Security « restricted », ResourceQuota, LimitRange ;
 *   - NetworkPolicy : refus par défaut ; DNS ; Traefik → app ; app ↔ base. Aucune autre sortie (ni Internet, ni IMDS) ;
 *   - comptes de service sans jeton monté ;
 *   - mots de passe générés DANS k3s (générateur « Password » d'External Secrets, une seule fois, jamais régénérés),
 *     comme autoGeneratePassword côté Azure : aucun secret dans Git, rien d'orphelin (ils partent avec le namespace) ;
 *   - PostgreSQL 16 dans le namespace ; l'app se connecte en cnp_runtime, jamais en administrateur.
 * Montée en charge : HPA sur le CPU. Le Deployment n'a JAMAIS de `replicas` (server-side apply : le HPA décide).
 *
 * Fonctions pures (la configuration est passée en argument) : testables sans réseau.
 */

const yaml = require('js-yaml');

const DUMP = { lineWidth: -1, noRefs: true };
const ENVIRONMENTS = ['dev', 'prod'];
const DB_NAME = 'appdb';
const DB_ADMIN = 'pgadmin';
const RUNTIME_USER = 'cnp_runtime';
const DB_PORT = 5432;
// Image officielle, version épinglée (publiée le 06/11/2026). Variante alpine : utilisateur postgres = 70.
const POSTGRES_IMAGE = 'postgres:16.15-alpine';
const POSTGRES_UID = 70;
// Noms réservés : k3s-api.<domaine> est l'API k3s (certificat tls-san), openbao.<domaine> l'OpenBao du cloud privé
// (cnp/aws/private).
const RESERVED_NAMES = ['k3s-api', 'openbao'];
// Variables applicatives (OpenBao du cloud privé) : Secret « variables » produit par External Secrets depuis le magasin
// cnp-openbao. La politique d'admission du cluster n'accepte que apps/<app>/<env> du namespace <app>-<env>.
const VARIABLES_SECRET = 'variables';
const OPENBAO_STORE = 'cnp-openbao';
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Dimensionnement (cadrage §6 et §7). Les quotas laissent la place d'un pod de plus pendant un déploiement progressif
// (maxSurge 1) au nombre maximal de répliques.
const SIZING = {
    dev: { minReplicas: 1, maxReplicas: 3,
        quota: { 'requests.cpu': '500m', 'requests.memory': '1Gi', 'limits.cpu': '1500m', 'limits.memory': '1536Mi',
            pods: '8', persistentvolumeclaims: '1', 'requests.storage': '2Gi' } },
    prod: { minReplicas: 2, maxReplicas: 5,
        quota: { 'requests.cpu': '1', 'requests.memory': '2Gi', 'limits.cpu': '2', 'limits.memory': '2Gi',
            pods: '10', persistentvolumeclaims: '1', 'requests.storage': '5Gi' } },
};
const APP_RESOURCES = { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '250m', memory: '256Mi' } };
const DB_RESOURCES = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } };
const DB_STORAGE = { dev: '1Gi', prod: '2Gi' };

const FILES = ['namespace.yaml', 'policies.yaml', 'secrets.yaml', 'database.yaml', 'app.yaml', 'kustomization.yaml'];

function validatePrivateAppName(appName) {
    // « <app>-prod » est un nom de namespace (63 caractères au plus) ; le portail limite déjà les noms à 40.
    if (typeof appName !== 'string' || !/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(appName) || appName.includes('--')) {
        throw new Error(`Nom d'application invalide pour le cloud privé : "${appName}".`);
    }
    if (RESERVED_NAMES.includes(appName)) {
        throw new Error(`Le nom « ${appName} » est réservé par la plateforme (adresse d'un service du cloud privé).`);
    }
}

function assertEnv(env) {
    if (!ENVIRONMENTS.includes(env)) throw new Error(`Environnement invalide : ${env}`);
}

/** Noms dérivés d'une app : namespace, hôte public, Secrets Kubernetes. */
function privateNames(appName, priv, env) {
    validatePrivateAppName(appName);
    assertEnv(env);
    const namespace = `${appName}-${env}`;
    const host = `${env === 'prod' ? appName : `${appName}-dev`}.${priv.appsDomain}`;
    return { namespace, host, adminSecret: 'db-admin', runtimeSecret: 'db-runtime', tlsSecret: `${appName}-tls` };
}

/** Adresse publique : prod <app>.<domaine>, dev <app>-dev.<domaine> (joker DNS vers l'IP de la VM). */
function privateAppUrl(appName, priv, env) {
    if (!priv?.appsDomain || !ENVIRONMENTS.includes(env)) return null;
    return `https://${privateNames(appName, priv, env).host}`;
}

function labels(appName, env, role) {
    return {
        'app.kubernetes.io/name': appName,
        'app.kubernetes.io/part-of': 'cnp',
        'app.kubernetes.io/managed-by': 'crossplane',
        'cnp.io/environment': env,
        ...(role ? { 'cnp.io/role': role } : {}),
    };
}

/** Labels de l'Object (dans GKE) : le portail retrouve ainsi tous les objets d'un environnement. */
function objectLabels(appName, env) {
    return { 'cnp.io/application': appName, 'cnp.io/environment': env, 'cnp.io/tier': 'prive' };
}

/**
 * Enveloppe un manifeste Kubernetes dans un Object cluster-scoped. La vague Argo ordonne la création (namespace, puis
 * politiques et secrets, puis base, puis app) ; un objet créé trop tôt est de toute façon réessayé par le provider.
 */
function wrap(appName, env, priv, manifest, wave) {
    const name = `${appName}-${env}-${manifest.kind.toLowerCase()}-${manifest.metadata.name}`;
    return {
        apiVersion: 'kubernetes.crossplane.io/v1alpha2',
        kind: 'Object',
        metadata: { name, labels: objectLabels(appName, env), annotations: { 'argocd.argoproj.io/sync-wave': String(wave) } },
        spec: { providerConfigRef: { name: priv.providerConfig }, forProvider: { manifest } },
    };
}

function header(text) {
    return text.split('\n').map(l => `# ${l}`).join('\n') + '\n';
}

function dumpAll(objects) {
    return objects.map(o => yaml.dump(o, DUMP)).join('---\n');
}

function tplNamespace(appName, priv, env) {
    const n = privateNames(appName, priv, env);
    const ns = {
        apiVersion: 'v1', kind: 'Namespace',
        metadata: {
            name: n.namespace,
            labels: {
                ...labels(appName, env),
                'pod-security.kubernetes.io/enforce': 'restricted',
                'pod-security.kubernetes.io/enforce-version': 'latest',
                'pod-security.kubernetes.io/warn': 'restricted',
                'pod-security.kubernetes.io/audit': 'restricted',
            },
        },
    };
    return header(
        `Namespace de ${appName} (${env}) dans le cluster k3s du cloud privé. Pod Security « restricted » : ni root, ni\n` +
        'privilège, ni réseau de l\'hôte. Le supprimer supprime tout l\'environnement, base et mots de passe compris.'
    ) + dumpAll([wrap(appName, env, priv, ns, 0)]);
}

function tplPolicies(appName, priv, env) {
    const n = privateNames(appName, priv, env);
    const ns = n.namespace;
    const size = SIZING[env];
    const role = r => ({ matchLabels: { 'app.kubernetes.io/name': appName, 'cnp.io/role': r } });
    const objects = [
        { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name: 'quota', namespace: ns, labels: labels(appName, env) },
            spec: { hard: size.quota } },
        { apiVersion: 'v1', kind: 'LimitRange', metadata: { name: 'defauts', namespace: ns, labels: labels(appName, env) },
            spec: { limits: [{ type: 'Container', default: APP_RESOURCES.limits, defaultRequest: APP_RESOURCES.requests }] } },
        // Refus par défaut, entrée ET sortie : ni Internet, ni l'IMDS (169.254.169.254), ni les autres namespaces.
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'refus-par-defaut', namespace: ns },
            spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'dns', namespace: ns },
            spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{
                to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
                    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
                ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }] } },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'traefik-vers-app', namespace: ns },
            spec: { podSelector: role('app'), policyTypes: ['Ingress'], ingress: [{
                from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
                    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } } }],
                ports: [{ protocol: 'TCP', port: 'http' }] }] } },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'app-vers-base', namespace: ns },
            spec: { podSelector: role('app'), policyTypes: ['Egress'], egress: [{
                to: [{ podSelector: role('db') }], ports: [{ protocol: 'TCP', port: DB_PORT }] }] } },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'base-depuis-app', namespace: ns },
            spec: { podSelector: role('db'), policyTypes: ['Ingress'], ingress: [{
                from: [{ podSelector: role('app') }], ports: [{ protocol: 'TCP', port: DB_PORT }] }] } },
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'app', namespace: ns, labels: labels(appName, env, 'app') },
            automountServiceAccountToken: false },
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'db', namespace: ns, labels: labels(appName, env, 'db') },
            automountServiceAccountToken: false },
    ];
    return header(
        `Isolation de ${appName} (${env}) : quotas, valeurs par défaut des conteneurs, réseau en refus par défaut, comptes\n` +
        'de service sans jeton. Seules ouvertures : DNS, Traefik vers l\'app, l\'app vers SA base.'
    ) + dumpAll(objects.map(o => wrap(appName, env, priv, o, 1)));
}

function tplSecrets(appName, priv, env) {
    const n = privateNames(appName, priv, env);
    const ns = n.namespace;
    const generator = {
        apiVersion: 'generators.external-secrets.io/v1alpha1', kind: 'Password',
        metadata: { name: 'mot-de-passe', namespace: ns },
        spec: { length: 32, digits: 6, symbols: 0, noUpper: false, allowRepeat: true },
    };
    // CreatedOnce : généré une seule fois. Le régénérer changerait le mot de passe sans changer celui de la base.
    const external = name => ({
        apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret',
        metadata: { name, namespace: ns },
        spec: {
            refreshPolicy: 'CreatedOnce',
            target: { name, creationPolicy: 'Owner' },
            dataFrom: [{ sourceRef: { generatorRef: {
                apiVersion: 'generators.external-secrets.io/v1alpha1', kind: 'Password', name: 'mot-de-passe' } } }],
        },
    });
    return header(
        `Mots de passe de la base de ${appName} (${env}), générés dans k3s par External Secrets (clé « password ») :\n` +
        `${n.adminSecret} pour l'administrateur ${DB_ADMIN}, ${n.runtimeSecret} pour le rôle applicatif ${RUNTIME_USER}.\n` +
        'Ni Git, ni coffre externe : ils disparaissent avec le namespace, comme la base qu\'ils protègent.'
    ) + dumpAll([generator, external(n.adminSecret), external(n.runtimeSecret)].map(o => wrap(appName, env, priv, o, 1)));
}

// Crée le rôle applicatif au PREMIER démarrage de la base (script d'initialisation de l'image officielle) : propriétaire
// de la base et du schéma public, sans aucun droit d'administration. Le mot de passe passe par une variable psql, jamais
// par la ligne de commande.
const INIT_SCRIPT = `#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$CNP_RUNTIME_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE ${DB_NAME} OWNER TO ${RUNTIME_USER};
ALTER SCHEMA public OWNER TO ${RUNTIME_USER};
EOSQL
`;

function restrictedContainer() {
    return { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };
}

function tplDatabase(appName, priv, env) {
    const n = privateNames(appName, priv, env);
    const ns = n.namespace;
    const secretEnv = (name, secret) => ({ name, valueFrom: { secretKeyRef: { name: secret, key: 'password' } } });
    const objects = [
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'db-init', namespace: ns, labels: labels(appName, env, 'db') },
            data: { '10-cnp-runtime.sh': INIT_SCRIPT } },
        { apiVersion: 'v1', kind: 'Service', metadata: { name: 'db', namespace: ns, labels: labels(appName, env, 'db') },
            spec: { selector: { 'app.kubernetes.io/name': appName, 'cnp.io/role': 'db' },
                ports: [{ name: 'postgres', port: DB_PORT, targetPort: 'postgres' }] } },
        { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'db', namespace: ns, labels: labels(appName, env, 'db') },
            spec: {
                serviceName: 'db',
                replicas: 1,
                selector: { matchLabels: { 'app.kubernetes.io/name': appName, 'cnp.io/role': 'db' } },
                template: {
                    metadata: {
                        labels: labels(appName, env, 'db'),
                        // PostgreSQL écrit TOUS ses messages sur stderr : sans source, Datadog classe chaque ligne
                        // (« checkpoint complete »…) en erreur (35 fausses erreurs par jour constatées le 18/11). La
                        // source postgresql active le pipeline Datadog qui lit le vrai niveau (LOG, WARNING, ERROR).
                        // Même service que l'app (`<app>-<env>`) : l'utilisateur voit tous les logs de son app au même
                        // endroit, comme Cloud SQL sur GCP et RDS sur AWS ; `source:postgresql` isole la base au besoin.
                        annotations: { 'ad.datadoghq.com/postgres.logs': JSON.stringify([{
                            source: 'postgresql', service: `${appName}-${env}` }]) },
                    },
                    spec: {
                        serviceAccountName: 'db',
                        automountServiceAccountToken: false,
                        securityContext: { runAsNonRoot: true, runAsUser: POSTGRES_UID, runAsGroup: POSTGRES_UID,
                            fsGroup: POSTGRES_UID, seccompProfile: { type: 'RuntimeDefault' } },
                        containers: [{
                            name: 'postgres',
                            image: POSTGRES_IMAGE,
                            ports: [{ name: 'postgres', containerPort: DB_PORT }],
                            env: [
                                { name: 'POSTGRES_USER', value: DB_ADMIN },
                                { name: 'POSTGRES_DB', value: DB_NAME },
                                // Sous-dossier : la racine d'un volume peut contenir lost+found, que initdb refuse.
                                { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                                secretEnv('POSTGRES_PASSWORD', n.adminSecret),
                                secretEnv('CNP_RUNTIME_PASSWORD', n.runtimeSecret),
                            ],
                            securityContext: restrictedContainer(),
                            resources: DB_RESOURCES,
                            readinessProbe: { exec: { command: ['pg_isready', '-U', DB_ADMIN, '-d', DB_NAME] },
                                periodSeconds: 10, failureThreshold: 3 },
                            volumeMounts: [
                                { name: 'data', mountPath: '/var/lib/postgresql/data' },
                                { name: 'init', mountPath: '/docker-entrypoint-initdb.d', readOnly: true },
                            ],
                        }],
                        volumes: [{ name: 'init', configMap: { name: 'db-init', defaultMode: 0o555 } }],
                    },
                },
                volumeClaimTemplates: [{
                    metadata: { name: 'data' },
                    spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'local-path',
                        resources: { requests: { storage: DB_STORAGE[env] } } },
                }],
            } },
    ];
    return header(
        `Base PostgreSQL de ${appName} (${env}) : ${POSTGRES_IMAGE}, un volume local sur le disque de la VM (sauvegarde\n` +
        'quotidienne vers S3 par la VM, voir cnp/aws/private). Joignable seulement depuis les pods de l\'app (NetworkPolicy).'
    ) + dumpAll(objects.map(o => wrap(appName, env, priv, o, 2)));
}

function tplApp(appName, appPort, priv, env, revision) {
    if (!/^[a-f0-9]{40}$/.test(String(revision))) throw new Error('Révision CI invalide.');
    if (!priv.ecrRegistry) throw new Error('Registre du cloud privé non configuré.');
    const n = privateNames(appName, priv, env);
    const ns = n.namespace;
    const port = Number.parseInt(appPort, 10) || 8080;
    const size = SIZING[env];
    const value = (name, v) => ({ name, value: String(v) });
    // Service Datadog = `<app>-<env>`, comme le service Cloud Run (GCP), le service ECS (AWS) et la Container App
    // (Azure) : c'est ce nom que cherche la page Logs du portail (observability-scope.serviceNameOf). Avec le seul
    // nom de l'app, les logs du dev et de la prod se mélangeaient et le portail ne les trouvait pas (constaté le 18/11).
    const appLabels = { ...labels(appName, env, 'app'),
        'tags.datadoghq.com/env': env, 'tags.datadoghq.com/service': `${appName}-${env}`,
        'tags.datadoghq.com/version': revision };
    const deployment = {
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: ns, labels: appLabels },
        // Pas de `replicas` : le HPA décide (le provider applique en server-side apply et ne revendique pas ce champ).
        spec: {
            selector: { matchLabels: { 'app.kubernetes.io/name': appName, 'cnp.io/role': 'app' } },
            strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
            revisionHistoryLimit: 3,
            template: {
                // Le label seul ne suffit pas : l'agent pose aussi le service déduit de l'image (`<app>`, sans
                // l'environnement) et Datadog retient celui-là comme service du log ; `<app>-<env>` n'est qu'un tag
                // secondaire, invisible pour une recherche `service:` (constaté le 18/11). L'annotation de logs du
                // conteneur fixe le service du log ; la source reste le nom de l'app (aucun pipeline à déclencher).
                metadata: { labels: appLabels, annotations: { 'ad.datadoghq.com/app.logs': JSON.stringify([{
                    source: appName, service: `${appName}-${env}` }]) } },
                spec: {
                    serviceAccountName: 'app',
                    automountServiceAccountToken: false,
                    securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
                    containers: [{
                        name: 'app',
                        image: `${priv.ecrRegistry}/${appName}:${revision}`,
                        ports: [{ name: 'http', containerPort: port }],
                        env: [
                            value('PORT', port), value('APP_PORT', port),
                            value('DB_HOST', 'db'), value('DB_PORT', DB_PORT), value('DB_NAME', DB_NAME),
                            value('DB_USER', RUNTIME_USER),
                            { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: n.runtimeSecret, key: 'password' } } },
                            // Base dans le même namespace, isolée par NetworkPolicy : pas de TLS vers elle.
                            value('DB_SSLMODE', 'disable'),
                            value('CNP_CLOUD', 'Privé | k3s'),
                            value('DD_ENV', env), value('DD_SERVICE', appName), value('DD_VERSION', revision),
                        ],
                        securityContext: restrictedContainer(),
                        resources: APP_RESOURCES,
                        // Contrat commun aux tiers : /health ne répond 200 que si la base est joignable et inscriptible.
                        readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, failureThreshold: 3 },
                        livenessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 20, periodSeconds: 20 },
                    }],
                },
            },
        },
    };
    const service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'app', namespace: ns, labels: labels(appName, env, 'app') },
        spec: { selector: { 'app.kubernetes.io/name': appName, 'cnp.io/role': 'app' }, ports: [{ name: 'http', port: 80, targetPort: 'http' }] } };
    const redirect = { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name: 'vers-https', namespace: ns },
        spec: { redirectScheme: { scheme: 'https', permanent: true } } };
    const ingress = {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
        metadata: { name: 'app', namespace: ns, labels: labels(appName, env, 'app'), annotations: {
            'cert-manager.io/cluster-issuer': priv.certIssuer,
            'traefik.ingress.kubernetes.io/router.middlewares': `${ns}-vers-https@kubernetescrd`,
        } },
        spec: {
            ingressClassName: 'traefik',
            tls: [{ hosts: [n.host], secretName: n.tlsSecret }],
            rules: [{ host: n.host, http: { paths: [{ path: '/', pathType: 'Prefix',
                backend: { service: { name: 'app', port: { name: 'http' } } } }] } }],
        },
    };
    const hpa = {
        apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: 'app', namespace: ns, labels: labels(appName, env, 'app') },
        spec: {
            scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app' },
            minReplicas: size.minReplicas, maxReplicas: size.maxReplicas,
            metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
        },
    };
    return header(
        `Application ${appName} (${env}) : image ${priv.ecrRegistry}/${appName}:${revision} (ECR, tirée par le kubelet).\n` +
        `Adresse https://${n.host} (Traefik, certificat ${priv.certIssuer}). ${size.minReplicas} à ${size.maxReplicas} répliques selon le CPU.\n` +
        'Contrat des variables : PORT/APP_PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE ; /health obligatoire.'
    ) + dumpAll([deployment, service, redirect, ingress, hpa].map(o => wrap(appName, env, priv, o, 3)));
}

/**
 * Variables applicatives publiées dans l'OpenBao du cloud privé ({ version, names }) : ajoute l'ExternalSecret qui lit
 * CETTE version (secrets.yaml) et une entrée secretKeyRef par nom dans le conteneur (app.yaml). Liste explicite plutôt
 * qu'envFrom : le Secret contient aussi le marqueur de génération du portail, qui ne doit pas devenir une variable.
 * L'annotation de version relance les pods quand seule la version change (le contenu d'un Secret ne le fait pas).
 * Modifie `files` (clés : noms de fichiers ou chemins complets se terminant par ces noms).
 */
function applyPrivateVariables(files, appName, env, priv, prepared) {
    if (!prepared || !prepared.names?.length) return files;
    const { version, names } = prepared;
    if (!Number.isInteger(version) || version < 1 || names.some(name => !VARIABLE_NAME.test(name))) {
        throw new Error('Variables OpenBao du cloud privé invalides.');
    }
    const n = privateNames(appName, priv, env);
    const key = suffix => Object.keys(files).find(k => k === suffix || k.endsWith(`/${suffix}`));
    const secretsPath = key('secrets.yaml');
    const appPath = key('app.yaml');
    if (!secretsPath || !appPath) throw new Error('Manifestes du cloud privé incomplets pour les variables.');
    const external = {
        apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret',
        metadata: { name: VARIABLES_SECRET, namespace: n.namespace },
        spec: {
            refreshInterval: '1h',
            secretStoreRef: { kind: 'ClusterSecretStore', name: OPENBAO_STORE },
            target: { name: VARIABLES_SECRET, creationPolicy: 'Owner' },
            dataFrom: [{ extract: { key: `apps/${appName}/${env}`, version: String(version) } }],
        },
    };
    files[secretsPath] = files[secretsPath].replace(/\n*$/, '\n') + '---\n' + yaml.dump(wrap(appName, env, priv, external, 1), DUMP);
    const text = files[appPath];
    const head = (text.match(/^(#[^\n]*\n)*/) || [''])[0];
    const objects = yaml.loadAll(text).filter(Boolean);
    const deployment = objects.find(o => o.spec?.forProvider?.manifest?.kind === 'Deployment')?.spec.forProvider.manifest;
    const container = deployment?.spec?.template?.spec?.containers?.[0];
    if (!container || !Array.isArray(container.env)) throw new Error('Deployment du cloud privé inattendu pour les variables.');
    const occupied = new Set(container.env.map(item => item.name));
    for (const name of names) {
        if (occupied.has(name)) throw new Error(`Variable « ${name} » en conflit avec une variable de la plateforme.`);
        container.env.push({ name, valueFrom: { secretKeyRef: { name: VARIABLES_SECRET, key: name } } });
    }
    deployment.spec.template.metadata.annotations = { ...deployment.spec.template.metadata.annotations,
        'cnp.io/variables-version': String(version) };
    files[appPath] = head + dumpAll(objects);
    return files;
}

/** Fichiers écrits dans le config-repo : { nom de fichier : contenu } (dossier apps/<app>/crossplane/<env>). */
function privateCrossplaneFiles(appName, appPort, priv, env, revision) {
    assertEnv(env);
    return {
        'namespace.yaml': tplNamespace(appName, priv, env),
        'policies.yaml': tplPolicies(appName, priv, env),
        'secrets.yaml': tplSecrets(appName, priv, env),
        'database.yaml': tplDatabase(appName, priv, env),
        'app.yaml': tplApp(appName, appPort, priv, env, revision),
        'kustomization.yaml': yaml.dump({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization',
            resources: FILES.filter(f => f !== 'kustomization.yaml') }, DUMP),
    };
}

/**
 * État d'un environnement à partir de ses Object (lus dans GKE) : « ready » seulement si tous sont appliqués ET que le
 * Deployment observé dans k3s tourne sur l'image attendue, déploiement progressif terminé. « Ready » d'un Object
 * signifie seulement « appliqué » : la disponibilité vient de l'état observé du Deployment (status.atProvider.manifest).
 */
function privateAppStatusFrom(objects, { expectedImage } = {}) {
    const list = Array.isArray(objects) ? objects : [];
    const exists = list.length > 0;
    const deleting = list.some(o => !!o.metadata?.deletionTimestamp);
    const condition = (o, type) => (o.status?.conditions || []).find(c => c.type === type) || {};
    const base = { exists, deleting, observedImage: null, failure: null };
    if (!exists) return { ...base, phase: 'waiting-argocd' };
    const notSynced = list.filter(o => condition(o, 'Synced').status !== 'True' || condition(o, 'Ready').status !== 'True');
    const deployment = list.find(o => o.spec?.forProvider?.manifest?.kind === 'Deployment');
    const observed = deployment?.status?.atProvider?.manifest;
    const observedImage = observed?.spec?.template?.spec?.containers?.[0]?.image || null;
    const progressing = (observed?.status?.conditions || []).find(c => c.type === 'Progressing');
    if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
        return { ...base, observedImage, phase: 'failed', failure: 'la nouvelle version ne démarre pas (délai de déploiement dépassé). Vérifiez /health et les journaux.' };
    }
    if (notSynced.length > 0) {
        const message = condition(notSynced[0], 'Synced').message;
        return { ...base, observedImage, phase: 'applying', pending: notSynced.length,
            detail: message ? String(message).slice(0, 200) : null };
    }
    const status = observed?.status || {};
    const generationDone = (status.observedGeneration || 0) >= (observed?.metadata?.generation || 0);
    const rolledOut = generationDone && status.replicas > 0 && status.updatedReplicas === status.replicas
        && status.availableReplicas === status.replicas;
    if (expectedImage && observedImage !== expectedImage) return { ...base, observedImage, phase: 'rollout' };
    if (!rolledOut) return { ...base, observedImage, phase: 'rollout' };
    return { ...base, observedImage, phase: 'ready' };
}

module.exports = {
    ENVIRONMENTS, FILES, RESERVED_NAMES, POSTGRES_IMAGE, SIZING,
    validatePrivateAppName, privateNames, privateAppUrl, objectLabels,
    privateCrossplaneFiles, privateAppStatusFrom, applyPrivateVariables, VARIABLES_SECRET, OPENBAO_STORE,
    tplNamespace, tplPolicies, tplSecrets, tplDatabase, tplApp,
};
