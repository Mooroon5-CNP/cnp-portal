# Instances OpenBao — prérequis de préparation

Ce document sert à préparer les instances nécessaires aux variables d'environnement des applications. Il ne contient ni secret, ni commande d'installation live. Le déploiement de la plateforme est assuré par l'utilisatrice. Les changements d'infrastructure seront de préférence déclarés en Terraform ; aucun `terraform apply` ni push sur `cnp/cluster` avant son accord.

**État du code au 15/11/2026 :** le formulaire accepte désormais des lignes manuelles et l'import local d'un `.env`. Le serveur refuse un déploiement avec variables si les endpoints OpenBao ou identités runtime requis ne sont pas configurés. Les adaptateurs GCP, Azure et AWS et le rendu des références sont testés localement. Aucune instance OpenBao ni aucun droit cloud n'a été installé ou vérifié en conditions réelles ; la recette applicative reste à faire après préparation de ces prérequis.

## Instances nécessaires selon le formulaire actuel

| Mode de déploiement | OpenBao à rendre disponible |
| --- | --- |
| Azure dev/prod | Azure seulement. |
| GCP SQLite dev/prod, GCP PostgreSQL dev | GCP seulement. |
| GCP PostgreSQL prod | GCP **et** AWS, car ce mode conserve le secours AWS obligatoire. |

Le portail est le client qui écrit les valeurs dans ces domaines. Les applications utilisent ensuite les secrets préparés dans leur cloud ; elles ne doivent pas dépendre du portail au démarrage. Les valeurs AWS requises pour le secours doivent être disponibles avant une panne GCP.

**Isolation des applications :** les manifests GCP actuels utilisent `GCP_CLOUD_RUN_SA`, un compte runtime partagé. L'adaptateur GCP donne à ce compte accès à chaque secret qu'il crée ; en l'état, les applications partageant ce compte pourraient lire les secrets des autres si leur code connaît les noms. Une identité runtime propre à l'application, avec droits limités à ses secrets, est nécessaire avant une mise en service multi-tenant. Le même contrôle s'applique aux identités Azure et aux rôles d'exécution ECS AWS.

Pour les nouvelles variables GCP, `cnp/gcp/14-openbao-runtime-identities.tf` prépare un compte par entrée de `openbao_runtime_environments` (`mon-app/dev`, `mon-app/prod`). Avec `CNP_OPENBAO_DERIVED_IDENTITIES=true` et `GCP_PROJECT`, le portail calcule l'adresse de ce compte sans liste JSON par application. Les anciens `CNP_GCP_RUNTIME_IDENTITIES` restent acceptés pour une transition. L'adaptateur accorde `roles/secretmanager.secretAccessor` seulement sur les secrets de l'application. Les déploiements existants sans variables conservent leur compte actuel. L'ajout d'une nouvelle entrée Terraform et son `apply` restent manuels ; aucun contrôleur ne crée encore une identité à la volée.

## État constaté dans les dépôts

- **GCP :** `config-repo/platform/openbao/` contient une Application Argo manuelle et des valeurs Helm OpenBao (chart 0.29.6, image 2.6.3, trois pods Raft, TLS, LoadBalancer interne et auto-unseal GCP KMS). Le dossier n'est découvert automatiquement par aucun ApplicationSet. Il référence encore le projet `cnp-terraform-512313`, le GSA `openbao-seal@cnp-terraform-512313.iam.gserviceaccount.com`, la zone `europe-west9-b` dans le runbook et la branche `fix/cloudrun-environment` dans l'Application. Il faudra les revoir lors du changement de compte. Aucune installation live n'est prouvée par ces fichiers.
- **AWS et Azure :** aucune déclaration d'instance OpenBao n'a été trouvée dans `cnp/{aws,azure}` ou dans `config-repo` lors de l'inventaire du 15/11/2026. Leur architecture de stockage, leur chiffrement d'unseal, leurs endpoints et leur installation restent à préparer.
- **Vault existant :** `cnp/gcp/11-vault.tf` déclare un Vault HashiCorp distinct, à un pod et sans TLS. Il ne remplace pas OpenBao et ne doit pas être supprimé ou migré implicitement.

## Contrat à fournir pour chaque instance

1. **Adresse et confiance :** URL `https://...:8200` joignable depuis le runtime réel du portail, certificat serveur valide et CA fournie si privée. Vérifier DNS, routage et pare-feu depuis le portail.
2. **Stockage et récupération :** volume persistant, sauvegarde/restauration testée et mécanisme d'unseal qui reste disponible selon le scénario de panne prévu. Pour AWS, vérifier l'accès sans GCP.
3. **KV v2 :** montage `cnp-runtime` ou nom communiqué au portail, versionnement activé et écritures CAS exigées. Conserver les versions encore référencées par un déploiement.
4. **Identité du portail :** auth JWT au chemin `jwt`, rôle du portail limité aux chemins `apps/<application>/<dev|prod>`. Le portail demande un jeton d'identité Google à son runtime ; l'instance doit valider son issuer, son audience et le sujet réel du compte de service. Aucun token OpenBao statique dans Git ou dans le portail.
5. **Audit et permissions :** audit sans valeurs, droits de lecture/écriture bornés au portail, pas de droits d'administration ni de lecture croisée pour une application. Autoriser aussi le portail à détruire une **version KV v2 précise** sur `cnp-runtime/destroy/apps/<application>/<dev|prod>` pour nettoyer une préparation partielle ; les versions déjà publiées ne sont pas visées. Préparer une procédure de rotation et de révocation.

Pour les **nouvelles variables Azure**, la livraison doit utiliser Azure Key Vault : le chemin Crossplane existant pour le mot de passe PostgreSQL passe par un Secret Kubernetes du cluster GCP. Prévoir une identité fédérée d'écriture pour le portail et une identité de lecture propre à l'application (ou des droits équivalents bornés par application) pour Container Apps. Cette adaptation peut être préparée en Terraform sans toucher au secret PostgreSQL existant.

### Préparation Azure Key Vault pour les nouvelles variables

Le coffre existant dans `cnp/azure/9-key-vault.tf` utilise Azure RBAC. L'adaptateur du portail échange un jeton Kubernetes projeté contre un jeton Entra, écrit une version de secret dans ce coffre et ajoute sa référence au manifest Container App après une CI réussie. Les points suivants sont nécessaires avant une recette Azure :

1. Déclarer en Terraform une identité managée **distincte de celle de Crossplane** pour le service account Kubernetes `cnp-portal`, avec fédération sur l'issuer OIDC du cluster GKE et l'audience `api://AzureADTokenExchange`. Monter dans le pod un jeton projeté avec cette audience. Donner à cette identité le droit de créer et lire les secrets du coffre, sans rôle Azure Resource Manager global.
2. Fournir au portail `CNP_AZURE_TENANT_ID`, `CNP_AZURE_PORTAL_CLIENT_ID` (sortie Terraform), `CNP_AZURE_FEDERATED_TOKEN_FILE`, `AZURE_SUBSCRIPTION_ID` et `CNP_AZURE_RUNTIME_RESOURCE_GROUP` (nom du groupe partagé) après installation. Ce sont des paramètres d'identité et d'adresse, pas des clés statiques. `CNP_AZURE_VAULT_URL` n'est utilisé que pour l'ancien mode à coffre commun.
3. `cnp/azure/14-openbao-runtime-identities.tf` prépare pour chaque entrée de `openbao_runtime_environments` une identité managée et un **coffre dédié à cet environnement**, avec `Key Vault Secrets User` borné à ce coffre ; le portail seul reçoit `Key Vault Secrets Officer`. L'identité ACR commune ne lit aucun de ces coffres. Avec `CNP_OPENBAO_DERIVED_IDENTITIES=true`, le portail calcule les noms des coffres et des identités depuis l'abonnement, le groupe partagé, l'application et l'environnement ; `CNP_AZURE_RUNTIME_IDENTITIES` reste accepté temporairement pour les applications existantes. Le coffre de mots de passe PostgreSQL actuel est séparé et inchangé.
4. Vérifier que la version de `provider-azure-containerapp` installée accepte `secret[].keyVaultSecretId` et `secret[].identity` ; le portail émet déjà ces champs. Conserver `DB_PASSWORD` et ses `nameSecretRef`/`valueSecretRef` actuels.

L'écriture dans Key Vault crée une nouvelle version et renvoie une URL versionnée. Aucun secret applicatif n'est transmis au dépôt GitOps. Le formulaire est disponible, mais le serveur refuse la préparation si les paramètres d'instance ou d'identité requis manquent ; les droits et le schéma du provider restent à valider en réel. Ajouter l'environnement dans les variables Terraform et appliquer avant de déployer une application avec variables.

### Préparation AWS Secrets Manager pour le secours

L'adaptateur AWS du portail crée `cnp/failover/<application>/env-<hash>` et retourne une référence ECS épinglée à une version. Il réutilise le SDK Python déjà présent dans l'image du portail et transmet les valeurs au sous-processus par son entrée standard. `environment-failover.js` et le moteur de rendu ECS/GCP consomment désormais ces références après une CI réussie ; leur fonctionnement cloud reste à vérifier.

- Vérifier que l'identité AWS effective du portail dispose des permissions `DescribeSecret`, `CreateSecret`, `PutSecretValue` et `TagResource` sur ce préfixe. La politique Terraform actuelle dans `cnp/deployment/failover-phase1/platform/main.tf` couvre déjà `cnp/failover/*`, mais elle est liée à l'ancien compte et n'est pas une preuve de droits actifs.
- `cnp/aws/18-openbao-runtime-identities.tf` prépare un rôle d'exécution ECS par application dans `openbao_failover_apps`. Il lit seulement les secrets `env-*` et le secret SQL `runtime-*` de cette application ; le rôle partagé n'obtient pas ces droits. Utiliser Terraform pour les droits et les paramètres de compte/région, sans `apply` ici.
- Fournir au portail `CNP_AWS_ACCOUNT_ID` et `CNP_AWS_REGION`. Avec `CNP_OPENBAO_DERIVED_IDENTITIES=true`, il calcule le rôle d'exécution depuis ces paramètres et l'application, puis vérifie que le rôle et l'image ECS appartiennent au même compte. `CNP_AWS_RUNTIME_EXECUTION_ROLES` reste accepté pendant la transition. Le profil failover doit aussi référencer dès sa création le compte GCP runtime dédié, afin que le mot de passe SQL existant reste lisible.
- Fournir `CNP_AWS_REGION` au portail et une identité AWS effective. Éviter de réutiliser la clé statique `aws-creds` de Crossplane pour l'écriture des variables. Les nouvelles valeurs doivent être livrées sur AWS avant de rendre publiable la révision GCP PostgreSQL prod.

**Changement de comptes :** la provenance CI exige maintenant `CNP_AWS_ACCOUNT_ID` et `CNP_AWS_REGION`. Les scripts de rendu et d'opération acceptent `GCP_PROJECT`, `GCP_REGION`, `CNP_AWS_ACCOUNT_ID`, `CNP_AWS_REGION`, `CNP_AWS_ROUTE53_ZONE_ID`, `APPLICATIONS_BASE_DOMAIN`, `CNP_AWS_ALB_DNS_NAME`, `CNP_AWS_ALB_ZONE_ID`, `CNP_AWS_VPC_ID`, `CNP_AWS_PUBLIC_SUBNET_IDS`, `CNP_AWS_ECS_SECURITY_GROUP_ID` et `CNP_AWS_HTTPS_LISTENER_ARN`. Les scripts conservent des valeurs par défaut de l'ancien compte pour ne pas modifier la plateforme en service avant la bascule ; **renseigner toutes les valeurs du nouveau compte dans l'environnement du portail et du worker avant d'utiliser le failover sur les nouveaux comptes**. Les autres déclarations Terraform et les démonstrations historiques doivent être relues avant migration ; aucune bascule n'est faite ici.

La pile `cnp/deployment/failover-phase1/platform/` demande désormais `aws_account_id` et `ecs_cluster_arn` dans son `terraform.tfvars` non versionné. Pour un nouveau compte, y remplacer aussi le groupe de sécurité, les sous-réseaux, les images du worker/bootstrap et toute sortie réseau encore liée à l'ancien compte. Son backend S3 se fournit au `terraform init -backend-config=backend.hcl` avec `bucket`, `key`, `region`, `encrypt` et `use_lockfile` du nouveau compte. Les trois nouveaux fichiers `cnp/{gcp,azure,aws}/*openbao-runtime-identities.tf` attendent un inventaire d'applications et un plan Terraform revu avant tout `apply`. Aucun fichier Terraform de cette branche n'a été appliqué ni poussé.

## Paramètres attendus par le code du portail

Pour chaque domaine `GCP`, `AZURE`, `AWS` réellement utilisé :

| Variable non secrète du portail | Exemple / sens |
| --- | --- |
| `CNP_OPENBAO_<DOMAINE>_ADDR` | URL HTTPS de l'instance. |
| `CNP_OPENBAO_<DOMAINE>_AUDIENCE` | Audience JWT configurée dans cette instance ; par défaut, son URL. |
| `CNP_OPENBAO_<DOMAINE>_ROLE` | Rôle JWT du portail ; par défaut `cnp-control`. |
| `CNP_OPENBAO_<DOMAINE>_MOUNT` | Mount KV v2 ; par défaut `cnp-runtime`. |
| `CNP_OPENBAO_<DOMAINE>_CA_FILE` | Chemin local de la CA privée, si nécessaire. |

Les URLs, audiences et noms de rôle ne sont pas des secrets. Ne transmettre ni recovery keys, ni root token, ni valeurs applicatives dans un message ou un plan Terraform.

## Validation manuelle avant recette applicative

- Vérifier l'état `initialized`, `unsealed` et l'accès HTTPS de chaque instance ; ne pas publier la sortie d'une commande qui expose un token.
- Depuis l'identité réelle du portail, tester une lecture/écriture KV v2 sur une application fictive dans le bon environnement, puis un refus sur un autre périmètre.
- Pour GCP PostgreSQL prod, vérifier la même génération de variables sur GCP et AWS, puis lire les valeurs AWS pendant une simulation d'indisponibilité GCP.
- Transmettre au développement **uniquement** les URLs, les CA publiques nécessaires, les mounts, les rôles et les audiences validés. La recette de déploiement finale utilisera des variables fictives.

Références produit : [KV v2](https://openbao.org/docs/secrets/kv/kv-v2/), [authentification JWT](https://openbao.org/docs/api/auth/jwt/).
