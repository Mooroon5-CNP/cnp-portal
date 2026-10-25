'use strict';

/**
 * Gabarits du tier souveraineté UE (Azure) : les fichiers que le portail écrit dans le config-repo et le
 * workflow qu'il écrit dans le dépôt de l'app.
 *
 * Même architecture que les apps GCP (ex. app4-pixelcam) : un dossier À PLAT `apps/<app>/crossplane/`,
 * repris par l'ApplicationSet `cloudrun-autodiscovery` (chemin `apps/*\/crossplane`, destination crossplane-system).
 * Contenu : un serveur PostgreSQL PAR APP, sa base, un petit Secret pour le NOM du secret de la Container App
 * (la CRD l'exige : nameSecretRef), et la Container App. Les valeurs d'infrastructure viennent de la
 * configuration (config.azure, sortie Terraform `portal_environment` de azure/), jamais écrites ici.
 *
 * Fonctions pures (la configuration est passée en argument) : testables sans réseau.
 */

const yaml = require('js-yaml');

const DUMP = { lineWidth: -1, noRefs: true };
const DB_NAME = 'appdb';
const DB_ADMIN = 'pgadmin';
const SECRET_KEY_NAME = 'db-password'; // nom du secret côté Container App
const CROSSPLANE_NAMESPACE = 'crossplane-system';
const STARTER_IMAGE = 'mcr.microsoft.com/k8se/quickstart:latest';

// Container App : 2 à 32 caractères, minuscules, chiffres et tirets, début par une lettre, pas de « -- ».
const APP_NAME_RE = /^[a-z](?:[a-z0-9]|-(?!-)){0,30}[a-z0-9]$/;

function validateAzureAppName(appName) {
    if (typeof appName !== 'string' || !APP_NAME_RE.test(appName)) {
        throw new Error(
            `Nom d'application invalide pour Azure : "${appName}". ` +
            'Il faut 2 à 32 caractères : minuscules, chiffres et tirets (pas deux tirets de suite), ' +
            'commençant par une lettre et finissant par une lettre ou un chiffre.'
        );
    }
}

/** Noms des ressources d'une app. Le serveur est unique par app et par environnement, avec le suffixe d'abonnement. */
function azureNames(appName, azure) {
    validateAzureAppName(appName);
    const server = `${azure.namePrefix}-${azure.regionKey}-${appName}-dev-${azure.nameSuffix}`;
    if (server.length > 63) {
        throw new Error(`Nom de serveur PostgreSQL trop long (${server.length} > 63) : ${server}`);
    }
    return {
        server,
        database: `${appName}-appdb`,
        passwordSecret: `${appName}-pg-password`,
        nameSecret: `${appName}-containerapp-secretname`,
        containerApp: appName,
        host: `${server}.postgres.database.azure.com`,
    };
}

function header(text) {
    return text.split('\n').map(l => `# ${l}`).join('\n') + '\n';
}

function tplAzureFlexibleServer(appName, azure) {
    const n = azureNames(appName, azure);
    const doc = {
        apiVersion: 'dbforpostgresql.azure.upbound.io/v1beta1',
        kind: 'FlexibleServer',
        metadata: { name: n.server, annotations: { 'argocd.argoproj.io/sync-wave': '0' } },
        spec: {
            forProvider: {
                location: azure.location,
                resourceGroupName: azure.resourceGroup,
                version: '16',
                skuName: 'B_Standard_B1ms',
                storageMb: 32768,
                autoGrowEnabled: false,
                delegatedSubnetId: azure.dbSubnetId,
                privateDnsZoneId: azure.dbDnsZoneId,
                publicNetworkAccessEnabled: false,
                administratorLogin: DB_ADMIN,
                autoGeneratePassword: true,
                administratorPasswordSecretRef: { name: n.passwordSecret, namespace: CROSSPLANE_NAMESPACE, key: 'password' },
                backupRetentionDays: 7,
                geoRedundantBackupEnabled: false,
                tags: {
                    'cnp-role': 'app-db', 'cnp-app': appName, 'cnp-env': 'dev',
                    'managed-by': 'crossplane', project: 'cnp', tier: 'souverainete',
                },
            },
            providerConfigRef: { name: 'default' },
        },
    };
    return header(
        `Serveur PostgreSQL de l'app ${appName} (tier souveraineté, Azure), créé par Crossplane via le portail.\n` +
        'Un serveur par app : son administrateur ne voit que les bases de cette app. Tag cnp-env=dev : non copié en Irlande.\n' +
        `Le mot de passe est généré dans le Secret ${n.passwordSecret} (${CROSSPLANE_NAMESPACE}).`
    ) + yaml.dump(doc, DUMP);
}

function tplAzureDatabase(appName, azure) {
    const n = azureNames(appName, azure);
    const doc = {
        apiVersion: 'dbforpostgresql.azure.upbound.io/v1beta1',
        kind: 'FlexibleServerDatabase',
        metadata: {
            name: n.database,
            annotations: { 'crossplane.io/external-name': DB_NAME, 'argocd.argoproj.io/sync-wave': '1' },
        },
        spec: {
            forProvider: { charset: 'UTF8', collation: 'en_US.utf8', serverIdRef: { name: n.server } },
            providerConfigRef: { name: 'default' },
        },
    };
    return header(`Base logique (${DB_NAME}) de l'app ${appName} sur son propre serveur.`) + yaml.dump(doc, DUMP);
}

function tplAzureSecretName(appName, azure) {
    const n = azureNames(appName, azure);
    const doc = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: n.nameSecret, namespace: CROSSPLANE_NAMESPACE, annotations: { 'argocd.argoproj.io/sync-wave': '0' } },
        type: 'Opaque',
        stringData: { name: SECRET_KEY_NAME },
    };
    return header(
        'Nom du secret de la Container App. La CRD ContainerApp exige que le NOM d\'un secret vienne lui aussi\n' +
        'd\'un Secret Kubernetes (nameSecretRef) : il n\'existe pas de champ « name » en clair.'
    ) + yaml.dump(doc, DUMP);
}

function tplAzureContainerApp(appName, appPort, azure) {
    const n = azureNames(appName, azure);
    const port = Number.parseInt(appPort, 10) || 8080;
    const env = (name, value) => ({ name, value: String(value) });
    const doc = {
        apiVersion: 'containerapp.azure.upbound.io/v1beta2',
        kind: 'ContainerApp',
        metadata: { name: n.containerApp, annotations: { 'argocd.argoproj.io/sync-wave': '2' } },
        spec: {
            forProvider: {
                resourceGroupName: azure.resourceGroup,
                containerAppEnvironmentId: azure.environmentId,
                revisionMode: 'Single',
                identity: { type: 'UserAssigned', identityIds: [azure.pullIdentityId] },
                registry: [{ server: azure.acrLoginServer, identity: azure.pullIdentityId }],
                secret: [{
                    nameSecretRef: { name: n.nameSecret, namespace: CROSSPLANE_NAMESPACE, key: 'name' },
                    valueSecretRef: { name: n.passwordSecret, namespace: CROSSPLANE_NAMESPACE, key: 'password' },
                }],
                ingress: {
                    externalEnabled: true,
                    targetPort: port,
                    transport: 'auto',
                    trafficWeight: [{ latestRevision: true, percentage: 100 }],
                },
                template: {
                    minReplicas: 1,
                    maxReplicas: 1,
                    container: [{
                        name: 'app',
                        // Image de départ PUBLIQUE et existante, remplacée par la CI (pipeline-azure.yml, yq, premier
                        // conteneur). Elle ne peut pas être une image de l'ACR qui n'existe pas encore : Argo synchronise
                        // la Container App (vague 2) bien avant ou juste après le premier commit d'image de la CI, et
                        // Azure refuse de créer une révision sur une image absente. L'app reste alors en « Failed » et
                        // Crossplane ne s'en remet pas (constaté le 25/10/2026). Cette image écoute sur le port 80, pas
                        // sur celui de l'app : sans importance, Azure crée la révision quand même, et la vraie image la
                        // remplace dès que la CI a promu.
                        image: STARTER_IMAGE,
                        cpu: 0.25,
                        memory: '0.5Gi',
                        env: [
                            env('PORT', port),
                            env('APP_PORT', port),
                            env('DB_HOST', n.host),
                            env('DB_PORT', 5432),
                            env('DB_NAME', DB_NAME),
                            env('DB_USER', DB_ADMIN),
                            { name: 'DB_PASSWORD', secretName: SECRET_KEY_NAME },
                        ],
                    }],
                },
                tags: { project: 'cnp', tier: 'souverainete', 'cnp-env': 'dev' },
            },
            providerConfigRef: { name: 'default' },
        },
    };
    return header(
        `Container App de l'app ${appName}. L'image est mise à jour par la CI (pipeline-azure.yml).\n` +
        'Contrat des variables : PORT/APP_PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (lue dans le secret de l\'app).\n' +
        'La base impose SSL : sslmode=require. L\'app doit exposer /health (200 seulement si sa base est inscriptible).'
    ) + yaml.dump(doc, DUMP);
}

function tplAzureKustomization() {
    return yaml.dump({
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        resources: [
            'containerapp-secretname.yaml',
            'flexibleserver.yaml',
            'flexibleserver-database.yaml',
            'containerapp-claim.yaml',
        ],
    }, DUMP);
}

/** Fichiers écrits dans le config-repo : { chemin relatif à apps/<app>/crossplane : contenu }. */
function azureCrossplaneFiles(appName, appPort, azure) {
    return {
        'containerapp-secretname.yaml': tplAzureSecretName(appName, azure),
        'flexibleserver.yaml': tplAzureFlexibleServer(appName, azure),
        'flexibleserver-database.yaml': tplAzureDatabase(appName, azure),
        'containerapp-claim.yaml': tplAzureContainerApp(appName, appPort, azure),
        'kustomization.yaml': tplAzureKustomization(),
    };
}

/** Chemins du config-repo créés pour une app Azure (suppression à l'offboarding). */
function azureConfigRepoPaths(appName) {
    const cp = `apps/${appName}/crossplane`;
    return [
        `${cp}/containerapp-secretname.yaml`,
        `${cp}/flexibleserver.yaml`,
        `${cp}/flexibleserver-database.yaml`,
        `${cp}/containerapp-claim.yaml`,
        `${cp}/kustomization.yaml`,
    ];
}

/** ci.yml de l'app : appelle le pipeline Azure (séparé de pipeline.yml, qui sert GCP et AWS). */
function tplAzureCiWorkflow(appName, appPort, configRepoUrl) {
    return `name: CI

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  pipeline:
    uses: Mooroon5-CNP/ci-templates/.github/workflows/pipeline-azure.yml@main
    with:
      app_name: "${appName}"
      app_port: "${Number.parseInt(appPort, 10) || 8080}"
      config_repo_url: "${configRepoUrl}"
    secrets:
      CONFIG_REPO_TOKEN: \${{ secrets.CONFIG_REPO_TOKEN }}
`;
}

/** Variables GitHub (non secrètes) que le pipeline Azure lit : [nom, valeur]. */
function azureRepoVariables(azure) {
    return [
        ['AZURE_CLIENT_ID', azure.ciClientId],
        ['AZURE_TENANT_ID', azure.tenantId],
        ['AZURE_SUBSCRIPTION_ID', azure.subscriptionId],
        ['AZURE_ACR_LOGIN_SERVER', azure.acrLoginServer],
    ];
}

/** URL publique d'une app Azure (domaine par défaut de l'environnement Container Apps). */
function azureAppUrl(appName, azure) {
    return azure.environmentDomain ? `https://${appName}.${azure.environmentDomain}` : null;
}

module.exports = {
    validateAzureAppName, azureNames, azureCrossplaneFiles, azureConfigRepoPaths,
    tplAzureCiWorkflow, azureRepoVariables, azureAppUrl,
    tplAzureFlexibleServer, tplAzureDatabase, tplAzureSecretName, tplAzureContainerApp, tplAzureKustomization,
};
