# OpenBao sur GKE et premier déploiement depuis cette branche

Statut du 4 novembre 2026 : code local et configuration déclarative préparés.
Aucun OpenBao installé ni déploiement Google validé depuis ce sandbox.
Portail = Mooroon5-CNP/cnp-portal ; Pixel App = Mooroon5-CNP/app4-pixelcalm.
Branches locales portail et config-repo : fix/cloudrun-environment. Main inchangée.

## 1. Architecture préparée

OpenBao sur cnp-cluster-terraform (projet cnp-terraform-512313), namespace openbao,
chart officiel 0.29.6, image 2.6.3, trois pods Raft et PVC, TLS de bout en bout,
LoadBalancer interne, seal KMS par Workload Identity. Ce pin évite de supposer que
le plugin seal externe requis par 2.7 est déjà empaqueté. Les versions seront
scannées puis mises à jour explicitement, avec test du seal et de restauration.
Le cluster doit être Kubernetes >=1.30. Sa capacité et sa topologie ne sont pas
vérifiées dans le sandbox. Un cluster zonal ne devient pas régional avec trois pods.

Fichiers config-repo : platform/openbao/application.yaml, values.yaml,
control-policy.hcl et README.md. Aucun ApplicationSet ne les découvre ; pas de
sync automatique ni de finalizer cascade sur cette Application. Rendu Helm,
certificat, KMS, DNS et routage doivent être validés avant la première sync.

Le portail choisit ses nouvelles écritures par CNP_VARIABLES_PROVIDER :
secret-manager (défaut historique), gcs (transition), openbao (cible). Une référence
conserve son fournisseur et sa version ; aucune bascule sur erreur. GCS utilise
un bucket privé dédié par application/environnement, jamais /data. Le runtime
lit la génération GCS exacte ou la version KV v2 exacte. Le portail n’est pas sur
le chemin de lecture d’une application qui démarre.

Les nouveaux bundles de production sont refusés par défaut.
CNP_VARIABLES_PRODUCTION_ENABLED=true est une activation opérateur réservée à
l’après-pilote/rollback ; elle ne remplace pas l’approbation manager.

La CI partagée a été consultée : pipeline.yml, commit
cb9fd941bc03511998cf7883a28110eb53c6bd73. Elle construit le Dockerfile du dépôt et
supporte node_version et gitops_mode=portal. Pas besoin de lui donner les secrets
runtime ni de modifier son main pour le premier pilote. Le nouveau caller de
branche épingle ce SHA ; les callers existants restent inchangés.

## 2. Prérequis réels, distincts du code

- Compte de contrôle du portail dédié, distinct du GSA partagé des applications.
- Pour GCS : activer Storage/IAM/Resource Manager et attribuer les permissions
  storage.buckets.create/get/getIamPolicy/setIamPolicy, storage.objects.create/get,
  iam.serviceAccounts.create/get/getIamPolicy/setIamPolicy. Contrôler les droits
  hérités des runtimes ; aucun objectViewer/admin global aux applications.
- Crossplane : actAs sur les GSA runtime dédiés. Le backend crée cette liaison.
- Pour OpenBao : suivre platform/openbao/README.md côté config-repo pour KMS,
  TLS, DNS privé, configuration JWT (Google issuer, audience et sub numériques),
  contrôle privilégié et audit. Le portail doit également garder les permissions
  IAM nécessaires à la création des GSA et à la liaison Crossplane.
- CI : WIF_PROVIDER, GCP_SA_EMAIL, REGISTRY_URL, CONFIG_REPO_TOKEN déjà configurés
  dans le dépôt ; autoriser explicitement la branche dans la fédération WIF.
  Aucun élargissement de confiance à tous les forks ou à toutes les organisations.
- Une seule instance writer du portail pour ce premier pilote. Ce chantier ne
  transforme pas SQLite/GCSFuse en base transactionnelle multi-instance.

Le client OpenBao du runtime utilise le JWT du metadata server Google. Un ADC
personnel local ne fournit pas ce JWT ; préparer OpenBao depuis un workload de
contrôle correctement identifié, pas en remplaçant le JWT par un token statique.
Le mode GCS supporte les ADC locaux opérateur pour préparer le premier aperçu.

## 3. Ajouter le chargeur à une application (dont Pixel App)

Le portail embarque déjà le chargeur. Pour Pixel, utiliser une copie locale du
vrai dépôt, sans modifier main ni pousser automatiquement :

```sh
node scripts/platform/install-runtime.cjs /chemin/local/app4-pixelcalm
```

Exécuter cette commande depuis cnp-portal. Elle copie deux modules sans dépendance
npm dans .cnp/runtime et adapte uniquement l’étape finale du Dockerfile. L’image
Node 20 de Pixel conserve /sbin/tini -- node src/index.js, WORKDIR et USER 1000.
Relire le diff puis construire/tester l’image dans sa branche. Le fichier final
porte LABEL io.cnp.variables-contract="1" ; le backend refuse un Dockerfile sans
contrat plutôt que de publier une référence que l’application ignorerait.

Le contrat ne filtre pas les noms d’applications. Le chargeur démarre tout processus
présent dans l’image, y compris Python, mais cette première livraison nécessite
Node >=20 pour exécuter le chargeur. L’installation automatique accepte les images
finales Node et commandes exec explicites ; un Dockerfile shell ou un autre runtime
requiert une intégration explicite. Le binaire autonome est un travail ultérieur,
avec les mêmes BundleRef. Ne pas affirmer un support universel de Dockerfiles.
Les images sans nouvelles variables peuvent continuer leur déploiement historique.

Node avec process.execve : remplacement du processus. Node 20 : superviseur qui
transmet les signaux et restitue le code de sortie, sans shell. Les tests CI de
contrat couvrent Node 20 et 24, commande Node/Python, arguments, SIGTERM et exit 23.
Le sandbox a exécuté ces scénarios sur Node 26 ; Node 20/24 et Docker restent à
confirmer dans la CI. Aucune valeur n’est un argument du processus.

## 4. Préparer un aperçu isolé du portail avec le bucket

Cette étape écrit réellement dans GCP quand l’opérateur l’exécute. Le script ne
publie pas de manifeste ni de branche Git et ne modifie pas les applications
existantes. Choisir un fichier applicatif privé ; corriger les URLs/callbacks
locaux et les paramètres de production avant l’import. Le .env local n’est pas
nécessairement la configuration correcte du portail Cloud Run.

```sh
cd /home/maiabuc/SIGL/CNP/cnp-portal
CNP_VARIABLES_PROVIDER=gcs node scripts/platform/check-variables.cjs
CNP_VARIABLES_PROVIDER=gcs node scripts/platform/prepare-preview.cjs /chemin/prive/portal.env /tmp/cnp-preview.json
```

Vérifier GCP_PROJECT=cnp-terraform-512313 et GCP_REGION=europe-west9 dans la
configuration opérateur (.env.cloud existant prioritaire). Le compte Crossplane
est GCP_CROSSPLANE_SERVICE_ACCOUNT ou crossplane-gcp-sa@<projet>. Le script génère
un GSA et bucket privés propres au preview, puis un bundle immuable. Le fichier
/tmp/cnp-preview.json contient seulement des références et noms, sans valeurs.
Sa création est exclusive : un fichier existant n’est pas écrasé. Une nouvelle
préparation produit un nouveau bundle, conservant l’ancien pour rollback.
Ne pas placer les ADC, le fichier applicatif ou le résultat d’un init OpenBao dans Git.

Le profil pourra être préparé avec CNP_VARIABLES_PROVIDER=openbao une fois le
service réellement opérationnel. Pour ce fournisseur, compléter le profil de
références avec network.network et network.subnetwork (noms complets GCP vérifiés)
pour Direct VPC egress. Le rendu refuse un profil OpenBao sans réseau privé.
Le certificat d’OpenBao doit être reconnu dans l’image ; pour une CA privée,
embarquer uniquement son certificat public et configurer NODE_EXTRA_CA_CERTS
hors du bundle applicatif. Ne jamais désactiver TLS pour réussir le pilote.

## 5. Construire cette branche, sans publication main

Le workflow .github/workflows/cnp-preview.yml s’exécute au push de
fix/cloudrun-environment ; workflow_dispatch permet de le relancer lorsque GitHub
connaît le workflow. Il refuse une autre branche, vérifie le contrat sur Node
20/24, lance la CI partagée épinglée, puis construit/scanne l’image avec le SHA
réel de cette branche. Il ne déploie rien et n’écrit pas dans config-repo.
portal-validation.yml valide également cette branche.

Après push de cette branche uniquement et réussite du pipeline, retrouver le
digest de l’image construite, sans utiliser latest :

```sh
gcloud artifacts docker images describe europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal:SHA_COMPLET_DU_COMMIT --project=cnp-terraform-512313 --format='value(image_summary.digest)'
```

Remplacer SHA_COMPLET_DU_COMMIT par le commit du run réussi. Vérifier l’étiquette
de contrat sur l’image tirée et le scan. Rendre le manifeste (référence complète
avec @sha256: et 64 chiffres hexadécimaux) :

```sh
node scripts/platform/render-preview.cjs /tmp/cnp-preview.json europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal@sha256:DIGEST_VERIFIE > /tmp/cnp-portal-preview.json
```

Le rendu refuse un tag flottant, un nom autre que cnp-portal-preview ou un compte
runtime incohérent. Pas de liaison allUsers, pas de réutilisation de cnp-portal-dev.
Aucune valeur secrète dans le manifeste. L’opérateur inspecte puis peut appliquer
cet unique service dans son contexte GKE vérifié :

```sh
kubectl -n crossplane-system apply -f /tmp/cnp-portal-preview.json
kubectl -n crossplane-system get v2services.cloudrun.gcp.upbound.io cnp-portal-preview -o yaml
```

Le V2Service a deletionPolicy=Orphan pour prévenir la destruction automatique
pendant le pilote. Son retrait n’efface donc pas le service Google : nettoyage
opérateur explicite après inventaire. Cette ressource preview est hors des chemins
auto-découverts GitOps ; ne pas la confondre avec une promotion prod par ArgoCD.
Le chemin GitOps normal des autres applications reste inchangé.

Le service est privé. Pour tester avec une session opérateur autorisée :

```sh
gcloud run services proxy cnp-portal-preview --project=cnp-terraform-512313 --region=europe-west9 --port=8090
```

Ouvrir http://localhost:8090/healthz puis /login. L’authentification Google ici
concerne le test opérateur d’un service privé, pas l’utilisation future du portail
par les développeurs. L’authentification du portail reste active ; le test OAuth
requiert une URL publique/callback configurée séparément.

## 6. Vérifications et rollback

Le preview utilise /tmp pour sa base : données et sessions non durables, au plus
une instance. Ce n’est pas une base persistante de production. Fournir un
ADMIN_INITIAL_PASSWORD fort via le bundle pour pouvoir tester le login admin ;
aucun mot de passe de secours n’est imprimé dans les logs. La connexion aux vrais
services externes nécessite les identifiants applicatifs et réseaux corrects.

Vérifier : dernière révision créée = dernière prête, digest attendu, healthz,
login, une variable canari via une app témoin qui expose seulement sa présence,
refus d’un autre runtime/dev→prod, scale-to-zero/redémarrage sans portail,
refus d’un bundle inaccessible et retour au profil précédent. Ne jamais appeler
un endpoint qui retourne toutes les variables de processus.

Conserver les manifests de références de chaque preview. Rollback = réappliquer
ensemble ancien digest ET ancien BundleRef ; ne pas supprimer les anciens bundles
avant la fenêtre de rollback. Le preview ne change pas le trafic du service actuel.
Le pilote prod/canari géré intégralement par ArgoCD, la restauration OpenBao et le
binaire universel restent des portes distinctes avant généralisation.

## 7. État de validation local

Tests unitaires et d’intégration simulée : parsing, fidélité des valeurs, GCS
ifGenerationMatch=0 et génération chaîne, KV v2 CAS/version, pas de fallback,
isolation des chemins, IAM bucket privé, contrats Dockerfile, modèles et rollback.
Le lecteur startup refuse HTTP externe et une référence invalide avant de lancer
l’application. Les tests locaux ne prouvent pas IAM GCP, JWT Google↔OpenBao,
réseau privé, image Docker, quorum ou restauration réelle.

Limitations du sandbox constatées : Docker socket interdit, gcloud ne peut écrire
ses fichiers de credentials, résolution DNS externe de shell indisponible. Aucun
push, changement de main, secret cloud, bucket ou service GCP créé depuis ici.
Exécuter les preuves d’infrastructure depuis le terminal opérateur/CI autorisé,
sans affaiblir ces contrôles et sans annoncer leur réussite à l’avance.

## 8. Autoriser le portail preview comme plan de contrôle

Le GSA créé pour le preview lit d’abord son propre bundle. Cela suffit au démarrage,
mais ne lui donne pas le droit de créer les configurations des autres applications.
Le manifeste définit CNP_VARIABLES_PROVIDER selon le profil, sans transmettre
ces paramètres de contrôle dans l’import utilisateur. Pour utiliser le wizard
du portail preview en mode GCS, l’opérateur attribue une fois le rôle dédié à ce
GSA du portail uniquement (jamais à Pixel ou aux autres applications) :

```sh
CNP_VARIABLES_PROVIDER=gcs node scripts/platform/check-variables.cjs --role-definition > /tmp/cnp-bundle-control-role.json
gcloud iam roles create cnpBundleControl --project=cnp-terraform-512313 --file=/tmp/cnp-bundle-control-role.json
CNP_PORTAL_CONTROL_SA=$(node -p 'JSON.parse(require("fs").readFileSync("/tmp/cnp-preview.json", "utf8")).runtimeAccount')
gcloud projects add-iam-policy-binding cnp-terraform-512313 --member="serviceAccount:$CNP_PORTAL_CONTROL_SA" --role=projects/cnp-terraform-512313/roles/cnpBundleControl
```

Si le rôle existe, employer iam roles update. Le compte opérateur qui exécute
prepare-preview doit déjà avoir les permissions de préparation ; ce rôle n’accorde
pas à un développeur le droit de s’auto-attribuer des permissions. En OpenBao,
générer la définition avec CNP_VARIABLES_PROVIDER=openbao pour le volet IAM, puis
lier le sub de ce même GSA dédié au rôle OpenBao cnp-control. Ne pas donner ces
droits au GSA partagé cloud-run-sa.

Depuis le preview authentifié, /deployments/variables/capability doit confirmer
la disponibilité du fournisseur. Ce test doit être suivi d’une vraie écriture et
lecture sur une application témoin ; available=true ne remplace pas cette preuve.
