# SPEC — Statut de déploiement des applications Azure dans le chat MCP

Date : 23 novembre 2026 · Statut : **corrigé et déployé** (commit `53f083a`, image `1b0ea4e`, production le 23/11 à 17:24 UTC)

## 1. Problème constaté

Dans le chat du portail, l'outil **statut du déploiement** (`get_deployment_status`, commande `/deploiement`)
échoue pour une application Azure. Constat du 23/11 sur `testapp09` (dev, Azure, en ligne et saine) :

```
get_deployment_status error ["platform:available","git:unavailable","argo:unavailable"]
```

Pour une application GCP (`app-2-dancingduck`), le même outil répond correctement.

## 2. Cause

Le MCP (`cnp-mcp`, `ADAPTER_MODE=http`) lit les façades `/v1` du portail, qui reposent sur les
adaptateurs natifs `apps/orchestrator/src/sources/native-adapters.cjs`. Leur fonction
`resolveDeployment(id, env)` ne connaît que deux formes de déploiement dans le config-repo :

| Plateforme | Fichier lu | Pris en charge |
| --- | --- | --- |
| GCP Cloud Run | `apps/<app>/crossplane/<env>/cloudrun-claim.yaml` | oui |
| GKE (historique) | `apps/<app>/overlays/<env>/…` | oui |
| **Azure Container Apps** | `apps/<app>/crossplane/<env>/containerapp-claim.yaml` | **non** |

Pour Azure, aucun des deux fichiers attendus n'existe : la source Git renvoie `ENVIRONMENT_NOT_FOUND`
(remontée `SOURCE_UNAVAILABLE` par le MCP), et Argo n'est jamais interrogé. Ce n'est pas une régression :
Azure n'a jamais été branché sur ces adaptateurs.

## 3. Comportement attendu

Pour une application Azure (dev ou prod), `get_deployment_status` renvoie :

- **état souhaité (Git)** : l'image du manifeste `containerapp-claim.yaml`
  (`spec.forProvider.template.container[0].image`), sa version (tag) et sa révision source ;
- **état observé (Argo + Azure)** : synchronisation et santé de l'Application Argo `<app>-<env>`, et l'image
  **réellement servie**, lue dans l'état observé de la Container App Crossplane
  (`status.atProvider.template.container[0].image`), seulement quand la Container App est prête — même règle
  que pour Cloud Run (une spec non appliquée n'est pas une révision servie) ;
- **santé** : `Degraded` si la Container App est en échec, `Progressing` si elle n'est pas encore prête ;
- **dérive** : calculée par le MCP comme pour GCP (souhaité vs observé).

## 4. Contraintes et choix

- **Contrat MCP inchangé** : le champ `workload.platform` n'accepte que `gke` ou `cloud_run`
  (`http-adapters.ts`). Pour Azure, `workload` renvoie `null` (autorisé par le contrat) plutôt qu'une valeur
  fausse. L'ajout d'une valeur `azure_container_apps` demanderait une évolution coordonnée du MCP (Nazim).
- **Kubernetes** : `image-digest` reste réservé aux applications GKE (`SOURCE_NOT_CONFIGURED` pour Azure, comme
  pour Cloud Run).
- **Lecture seule** : uniquement des lectures (config-repo via le jeton existant, objet Crossplane via le client
  Kubernetes du portail, Application Argo). Aucun nouveau droit.
- **Périmètre Datadog** : non touché.

## 5. Mise en œuvre

1. `native-adapters.cjs` : `resolveDeployment` reconnaît `containerapp-claim.yaml` et renvoie
   `{ platform: 'azure_container_apps', runtimeName, image }` ; `workload` renvoie `null` pour cette plateforme ;
   `observed` lit l'état de la Container App par le client d'exécution.
2. `src/clients/kubernetes.js` : `getAzureContainerAppStatus(name)` → `{ ready, image, failure }`, à partir de
   l'objet Crossplane `containerapps.containerapp.azure.upbound.io` (mêmes règles que `azureAppStatusFrom`).
3. Tests : manifeste Azure dev/prod, image observée seulement quand prête, échec → `Degraded`, `workload` null.

## 6. Vérification

- Tests unitaires et suite complète verts, lint propre.
- Après déploiement : depuis le pod du portail, `get_deployment_status` pour `testapp09/dev` renvoie
  `success` ou `partial` avec `git:available` et `argo:available`, l'image `a9bb92b…` et `Healthy`.
- Non-régression : même appel pour `app-2-dancingduck/dev` (GCP) inchangé.

### Résultat en production (23/11, 17:25 UTC)

```
testapp09/dev          partial  platform, git, argo available · souhaité a9bb92b = observé a9bb92b · Synced/Healthy
app-2-dancingduck/dev  partial  platform, git, argo available · souhaité 38060aa = observé 38060aa · Synced/Healthy
```

`partial` uniquement parce que la source `kubernetes` (empreinte d'image) ne s'applique pas hors GKE.

## 7. Hors périmètre (suivi)

- ~~**Cloud privé k3s**~~ : traité le 23/11 (branche `fix/mcp-private-deployment-status`). L'état souhaité vient du
  `Deployment` enveloppé dans l'`Object` provider-kubernetes de `apps/<app>/crossplane/<env>/app.yaml`, l'état observé
  de l'Application Argo `<app>-<env>` et de `getPrivateAppStatus` (image seulement en phase `ready`, `failed` →
  `Degraded`, sinon `Progressing`). `workload` reste `null` et l'empreinte Kubernetes (GKE) ne s'applique pas.
- **Valeur `azure_container_apps` dans le contrat MCP** : à décider avec le MCP.
