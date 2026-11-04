# Activation opérateur des variables Cloud Run

La configuration suivante concerne l’opérateur de CNP, une fois pour le backend.
Un développeur utilisant le portail ne doit pas s’authentifier auprès de GCP.
Aucune commande ci-dessous n’est exécutée automatiquement par une demande utilisateur.

## 1. Identifier le compte de contrôle

Utiliser un compte Google propre au backend CNP, distinct de GCP_CLOUD_RUN_SA,
qui représente le compte partagé des applications historiques. Ne jamais accorder
les droits de gestion de la plateforme à ce compte partagé. Le contrôle intégré
refuse cette confusion d’identité.

En GKE/Cloud Run : privilégier metadata/Workload Identity lié au backend.
En développement opérateur local : ADC authorized_user ou service_account déjà
configurés. GOOGLE_APPLICATION_CREDENTIALS peut désigner le fichier ADC privé
hors du dépôt. Le client ne supporte pas les fichiers ADC external_account ou
impersonated_service_account ; utiliser le metadata server en environnement partagé.
Un compte personnel ADC est refusé en production. Aucune clé n’entre dans l’image.

Si le portail est lui-même une application Cloud Run gérée par CNP, son compte
runtime isolé peut être son identité de contrôle après configuration opérateur.
Il doit rester propre à ce déploiement du portail ; aucune application ordinaire
ne doit hériter de ses droits. Le nom du compte doit être vérifié sur le service
réel, pas déduit d’un exemple de documentation.

## 2. Activer les API et permissions

Depuis la session administrateur autorisée, renseigner les valeurs vérifiées :

```sh
CNP_PROJECT=cnp-terraform-512313
CNP_BACKEND_SA='ADRESSE_VERIFIEE_DU_COMPTE_DEDIE'
gcloud services enable secretmanager.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com --project="$CNP_PROJECT"
npm run --silent platform:variables:check -- --role-definition > /tmp/cnp-application-variables-role.json
gcloud iam roles create cnpApplicationVariables --project="$CNP_PROJECT" --file=/tmp/cnp-application-variables-role.json
gcloud projects add-iam-policy-binding "$CNP_PROJECT" --member="serviceAccount:$CNP_BACKEND_SA" --role="projects/$CNP_PROJECT/roles/cnpApplicationVariables"
```

Si le rôle existe, utiliser `gcloud iam roles update` à la place de `create`.
La définition est produite depuis la liste réellement utilisée par le code :
permissions Secret Manager de création/métadonnées/IAM/ajout de version,
permissions de gestion des identités runtime, lecture des métadonnées projet et lecture d’état Service Usage.
La lecture des payloads existants n’est pas nécessaire au compte de contrôle.
Ce compte est un composant privilégié de contrôle : le limiter au projet CNP.

Le compte Crossplane est GCP_CROSSPLANE_SERVICE_ACCOUNT, sinon le nom standard
crossplane-gcp-sa@<projet>.iam.gserviceaccount.com. Le backend lui donne actAs
sur chaque identité runtime créée, et donne secretAccessor au runtime sur les
secrets concernés. Les politiques existantes/conditions sont conservées (etag/v3).

## 3. Vérifier dans le contexte réel du backend

```sh
npm run platform:variables:check
```

Dans une image de production sans npm :

```sh
node scripts/platform/check-variables.cjs
```

Le résultat doit contenir available=true et code=READY. Le diagnostic vérifie
l’identité, les permissions effectives et les API activées ; il ne crée aucun
secret ni compte. Un résultat obtenu sur le poste personnel d’un opérateur ne
prouve pas les droits du service cloud : vérifier depuis le backend, ou ouvrir
l’endpoint authentifié `/deployments/variables/capability` du portail déployé.
L’interface utilise cette même vérification avant de permettre une création avec
variables. Une création sans variable reste indépendante de ce diagnostic.

## 4. Essai de bout en bout avant généralisation

Créer un dépôt de démonstration à partir de `test/fixtures/variables-app/` :
Copier les quatre fichiers : Dockerfile, server.cjs, package.json et package-lock.json.
Les manifests npm sont nécessaires à la détection de la pile par la CI CNP. Déployer en dev avec une variable non sensible
CNP_TEST_VAR à une valeur quelconque, depuis les trois étapes du portail.
Après CI et synchronisation GitOps, `/healthz` doit retourner :

```json
{"ok":true,"variableConfigured":true}
```

La valeur n’est jamais renvoyée. Vérifier la référence numérique dans GitOps,
la révision Cloud Run Ready et ses logs sans valeur secrète. Remplacer la variable
via le panneau Variables, puis vérifier la nouvelle révision. Tester le parcours
prod séparément : aucune application de configuration avant approbation manager,
et le candidat antérieur doit être refusé après changement de configuration.

Le stockage des métadonnées utilise la base du portail. Les verrous coordonnent
les processus partageant une base SQLite fonctionnelle ; ils ne rendent pas un
montage objet/GCSFuse transactionnel. Pour un backend partagé, utiliser un stockage
adapté et une architecture de base compatible, ou conserver un seul écrivain.
Les applications déployées gardent leur propre politique de scaling.

Le sandbox actuel ne permet pas les accès réseau GCP : ces essais réels restent
à effectuer par l’opérateur. Aucun IAM, service, secret ou déploiement cloud n’a
été modifié pendant l’implémentation locale.
