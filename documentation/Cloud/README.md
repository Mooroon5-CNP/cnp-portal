# GCP → portail → Argo CD

Ce fichier est le guide unique pour le Terraform GCP, la connexion du portail à
Argo CD et les vérifications après changement de projet ou de région. Le Terraform
se trouve dans `../Cloud/cnp/gcp` depuis la racine de ce dépôt.

**`cloud:import` ne suffit pas à créer un nouveau cloud ni à migrer les apps.**
Il lit l’output `portal_environment` du state Terraform sélectionné, puis configure
le portail local. Il ne lance ni `terraform init`, ni `plan`, ni `apply` et ne vérifie
pas que le state appartient au projet souhaité. Les changements Terraform doivent
avoir été appliqués avec succès avant l’import. Aucun push n’est nécessaire pour
importer un state déjà disponible.

| Élément | Automatisé par les changements actuels | Action encore nécessaire |
|---|---|---|
| Cluster, IAM, registry et WIF | Provisionnement Terraform | Authentification opérateur, entrées et backend du nouveau projet, plan/apply |
| Argo CD pour le portail | Compte, mot de passe, droits et LoadBalancer HTTPS | Apply, import local et redémarrage ; vérifier la connexion |
| Paramètres des prochains onboardings | Projet, région, registry et variables CI lus par le portail | Importer le bon state avant d’onboarder |
| Authentification GCP de Crossplane | Bindings IAM Terraform | Mettre à jour les références GCP encore fixes dans config-repo |
| Applications, données, domaines et anciens dépôts CI | Pas de migration automatique | Adapter les manifests/variables, republier les images et migrer les données |
| Comptes humains Argo CD | Création via le portail | Régénérer les accès approuvés sur l’ancien cluster |

Le parcours complet sur un compte/projet/région neuf n’a pas encore été exécuté.
La validation locale du Terraform et le contrôle du cluster actuel ne prouvent
pas à eux seuls cette installation complète.

## Installation future ou changement de projet/région

1. Préparer les prérequis et appliquer l’infrastructure selon la section suivante.
   Corriger aussi les références Crossplane décrites plus bas, avant de considérer
   les déploiements applicatifs prêts. Pour une installation existante, conserver
   le bon backend et la zone réelle : changer de zone peut remplacer le cluster.
2. Terraform crée le compte Argo CD `cnp-portal`, son mot de passe généré,
   son LoadBalancer HTTPS, les credentials Kubernetes et les permissions du portail.
   Il écrit le contrat complet dans le Secret `cnp-portal-cloud-env` et dans
   l’output sensible `portal_environment`.
3. Pour le portail local :

   ```bash
   npm run cloud:import -- --terraform-dir ../Cloud/cnp/gcp
   npm start
   ```

   Arrêter l’ancien processus avant de le redémarrer. L’import ne modifie pas le
   cloud : il capture l’output sans l’afficher et écrit `.env.cloud` en mode `0600`.
   Ce fichier remplace seulement les variables cloud de `.env`, dont l’ancien token
   Argo CD. Il conserve GitHub, Datadog, la base SQLite et `SESSION_SECRET`.
   `cloud:onboard` est un alias de cette même commande d’import.
4. Pour le Deployment Kubernetes du portail : le manifeste charge automatiquement
   le Secret via `envFrom`. Le redémarrer après un changement de Secret. Terraform
   ne construit pas l’image et ne fournit pas les autres secrets applicatifs.
   Pour un portail Cloud Run, transférer le contrat vers son mécanisme de secrets
   et redéployer : ce dépôt Terraform ne gère pas ce déploiement applicatif.
5. Vérifier depuis l’environnement du portail :

   ```bash
   npm run cloud:check
   ```

   Cette commande vérifie une liste d’applications Argo CD, la lecture des namespaces
   et les deux patchs Kubernetes de création de comptes avec `dryRun=All`.
   Elle ne crée pas d’utilisateur et n’affiche aucun credential.

Le portail accepte soit `ARGOCD_TOKEN`, soit `ARGOCD_USERNAME` et `ARGOCD_PASSWORD`.
Les sessions du second mode sont renouvelées après expiration. L’output Terraform
vide explicitement `ARGOCD_TOKEN` pour éviter qu’un token d’ancien cluster prenne
le pas sur les nouveaux credentials.

Le nouveau LoadBalancer Argo CD utilise HTTPS avec son certificat auto-signé
initial (`ARGOCD_INSECURE=true`). Le navigateur peut demander d’accepter ce
certificat. Un domaine/certificat de confiance doit remplacer cette configuration
pour utiliser `ARGOCD_INSECURE=false`. nginx reste indépendant pour les apps.

## Préparer Terraform sur le nouveau projet

Disposer de Terraform, `gcloud`, du plugin GKE, de `kubectl`, de Bash et de `curl`.
Le poste qui exécute l’apply doit joindre l’API Kubernetes et accéder au dépôt privé.
S’authentifier avec le compte opérateur autorisé sur le nouveau projet et fournir
les credentials attendus par le provider Google.

Créer le bucket de state au préalable et autoriser l’opérateur : ce bootstrap du
backend n’est pas effectué par ce Terraform. Dans un fichier local `backend.hcl` :

```hcl
bucket = "BUCKET_STATE_DU_NOUVEAU_PROJET"
prefix = "terraform/state"
```

Renseigner les variables requises dans un fichier `.tfvars` non versionné :
`project_id`, `region`, `zone`, les entrées GitHub (`github_org`, `github_username`,
`config_repo_token`), Datadog, le mot de passe DB et les entrées VPN existantes.
La zone vaut `<region>-a` si elle est omise. `cluster_location` permet de définir
une zone ou une région pour GKE ; la VM VPN reste zonale. Garder ces valeurs
cohérentes avec la région du réseau et du registry.

Depuis `Cloud/cnp/gcp`, après avoir vérifié les valeurs et le bucket :

```bash
terraform init -reconfigure -backend-config=backend.hcl
terraform plan
terraform apply
```

Ces commandes sont à exécuter par l’opérateur ; elles ne sont pas lancées par
`cloud:import`. `-reconfigure` sélectionne le backend et ne migre pas les ressources
de l’ancien compte. Ne pas appliquer les paramètres du nouveau projet contre le
state de l’ancien. Pour le cluster existant, garder le bucket/prefix utilisés
jusqu’ici et effectuer les imports ci-dessous avant le plan.

Le bootstrap Terraform utilise son propre kubeconfig, vérifie les téléchargements
et attend la création des providers. `config_repo_project_path` vaut
`argocd/projects/default-project.yaml` ; ce manifeste doit définir `platform`.
`config_repo_revision` vaut `main`. L’application d’exemple n’est déployée que si
`bootstrap_example_app=true`. `argocd_chart_version` permet de fixer la version :
pour un cluster existant, renseigner la version déjà déployée avant une mise à jour.

## Adoption du cluster actuel avant le premier apply

Les objets créés manuellement doivent être importés dans le bon state au lieu
d’être recréés. Après initialisation du backend du cluster existant, importer
uniquement les objets qui existent et ne sont pas encore gérés à ces adresses :

```bash
terraform import kubernetes_namespace_v1.cnp_portal cnp-portal
terraform import kubernetes_service_account_v1.cnp_portal cnp-portal/cnp-portal
terraform import kubernetes_secret_v1.cnp_portal_token cnp-portal/cnp-portal-token
terraform import kubernetes_role_v1.cnp_portal_argocd argocd/cnp-portal-argocd
terraform import kubernetes_role_binding_v1.cnp_portal_argocd argocd/cnp-portal-argocd
terraform import kubernetes_cluster_role_v1.cnp_portal_runtime cnp-portal-runtime
terraform import kubernetes_cluster_role_binding_v1.cnp_portal_runtime cnp-portal-runtime
```

Si le Secret cloud existe déjà :

```bash
terraform import kubernetes_secret_v1.cnp_portal_cloud_env cnp-portal/cnp-portal-cloud-env
```

Relire ensuite le plan. Le premier apply configurera aussi le login généré et le
LoadBalancer ; il ne faut pas accepter un remplacement involontaire du cluster.
Ces imports ne sont pas nécessaires pour les objets absents d’un cluster neuf.

## Installation actuelle avec un tunnel local

Le diagnostic du 19 octobre 2026 a trouvé un cluster actif dans
`cnp-terraform-500015-508716`, zone `europe-west9-b`. L’API Kubernetes répondait,
mais `.env` pointait vers `https://localhost:8080` sans tunnel actif. Les permissions
de patch du service account `cnp-portal` étaient également absentes.

Le tunnel a depuis été rétabli et le manifeste de permissions a été appliqué :
`cloud:check` voit 13 applications et valide les patchs de provisioning en dry-run.
Cette réparation ne déploie pas le futur LoadBalancer ni le login généré par Terraform.

Avant le premier apply Terraform, les permissions nécessaires ont été réparées
avec le manifeste `scripts/cloud/portal-rbac.yaml`, strictement équivalent aux règles
`portal-rbac.json` déclarées dans Terraform. Les objets ainsi créés devront ensuite
être importés dans le state : voir la procédure d’adoption ci-dessus.
Ne pas rejouer d’ancien bootstrap nginx/HTTP en parallèle : Terraform gère désormais
la configuration Argo CD.

Pour un Argo CD encore en ClusterIP, lancer :

```bash
npm run argocd:connect
```

Cette commande vérifie que le contexte kubectl cible l’endpoint du portail, puis
maintient un tunnel local. Garder ce terminal ouvert et lancer le portail dans un
autre. Elle ne change aucun objet cloud et nécessite l’accès opérateur kubectl.
Elle n’est pas nécessaire avec le LoadBalancer fourni par le futur apply.
Si `.env.cloud` existe, il est prioritaire : ne pas importer le contrat d’un autre
cluster et ne pas conserver des paramètres localhost dans un déploiement distant.

## Comptes existants et vérification finale

Sur un nouveau cluster, les comptes humains de l’ancien Argo CD n’existent plus.
Conserver la base SQLite et `SESSION_SECRET`, puis utiliser « Régénérer les
identifiants » pour chaque utilisateur approuvé et tester une vraie connexion.
Une nouvelle demande doit être approuvée par un manager. Les échecs de provisioning
bloquent désormais l’approbation et la sauvegarde d’un nouveau mot de passe.

`GET /api/health` contrôle les intégrations. Les résultats `argocd` et `kubernetes`
doivent être `ok` ; un HTTP 207 peut aussi provenir de GitHub, Datadog ou Crossplane.
Vérifier ensuite le bouton « Ouvrir ArgoCD », une connexion utilisateur et une sync
sur une app de test. Le contrôle cloud ne prouve pas à lui seul ce parcours navigateur.

## Préparer Crossplane et les déploiements applicatifs

Le checkout local de config-repo contient encore les références fixes suivantes :

| Fichier dans config-repo | Référence à adapter au nouveau projet |
|---|---|
| `infra/crossplane/config/providerconfig-gcp.yaml` | `spec.projectID: cnp-terraform-500015` |
| `infra/crossplane/providers/deployment-runtime-config.yaml` | Annotation `iam.gke.io/gcp-service-account` |
| `infra/crossplane/providers/provider-gcp-storage-runtime.yaml` | Même annotation |
| `infra/crossplane/providers/provider-gcp-sql-runtime.yaml` | Même annotation |

Le compte cible est `crossplane-gcp-sa@<NOUVEAU_PROJET>.iam.gserviceaccount.com`.
Ces fichiers sont réconciliés par Argo CD depuis Git : une correction manuelle dans
le cluster peut être écrasée par la synchronisation. Les adapter dans la source
GitOps et les rendre disponibles à la révision utilisée par les Applications avant
la validation des déploiements. Le bootstrap Terraform actuel ne réécrit pas ces
fichiers. Il reste donc une étape hors de `cloud:import` ; la migration complète
vers n’importe quel nouveau projet n’est pas encore entièrement automatique.

Vérifier les `ProviderConfig` Crossplane, annotations Workload Identity, claims,
images et workflows dans config-repo/ci-templates. Les dépôts applicatifs déjà
onboardés doivent recevoir les nouvelles variables `WIF_PROVIDER`, `GCP_SA_EMAIL`
et `REGISTRY_URL`. Le contrat du portail concerne automatiquement les prochains
onboardings ; il ne migre pas les apps, bases de données ou domaines existants.
Les images des overlays Kubernetes doivent aussi être republiées dans le nouveau
registry. `CLUSTER_BASE_DOMAIN=cnp.example.com` est le marqueur permettant au
portail de découvrir l’IP ingress ; un domaine personnalisé nécessite son propre DNS.

La sortie Terraform contient des secrets, même marquée `sensitive`. Protéger le
backend et ne versionner ni `.env.cloud`, ni les exports JSON, ni les variables
sensibles. `CLOUD_ENV_FILE` permet de charger un autre chemin local explicitement.

Références : [comptes locaux Argo CD](https://argo-cd.readthedocs.io/en/stable/operator-manual/user-management/),
[RBAC Argo CD](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/),
[tokens Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/).


