# CNP — Variables au démarrage, OpenBao cible et bucket transitoire

Statut : principe et démarrage du développement validés par le demandeur le 4 novembre 2026.
La mise en production reste conditionnée aux preuves de validation.
Les changements de code locaux sont désormais autorisés ; aucune activation cloud ni preuve de déploiement ne doit être déduite de ce document.
Cette proposition remplace, pour les développements futurs après validation, la cible
Secret Manager de CLOUDRUN_ENVIRONMENT.md ; elle ne décrit pas le code déjà livré.
Aucune promesse de zéro incident : les exigences et portes de validation ci-dessous
conditionnent l’activation, application par application.

## 1. User story unique à valider

**En tant que développeur autorisé sur une application CNP, je souhaite saisir ou
importer mes variables de démarrage depuis un fichier .env ou .txt, les vérifier
puis déployer sans connexion manuelle au cloud, afin que chaque version de mon
application reçoive automatiquement la configuration de son environnement ; la
plateforme doit conserver ces valeurs hors de Git, des images et de la CI, les
stocker temporairement dans un bucket privé puis dans OpenBao sans changer mon
parcours, et permettre un retour arrière complet sans perturber les applications
existantes ni contourner l’approbation de production.**

## 2. Décision d’architecture et pertinence d’OpenBao

OpenBao est pertinent comme gestionnaire de secrets commun à plusieurs clouds :
KV v2 apporte versions et contrôle de concurrence ; JWT apporte l’authentification
machine et les politiques bornent les lectures. Ce choix transfère à l’équipe CNP
l’exploitation du service : réseau, TLS, disponibilité, déverrouillage, stockage,
sauvegardes, restauration, mises à jour et audit. Ce n’est pas un correctif aux droits
GCP manquants : le bucket demande lui aussi une identité et des autorisations.

Décisions proposées :
- Cible : OpenBao KV v2. Première livraison : mêmes contrats et tests avec un
  fournisseur GCS temporaire, explicitement sélectionné par l’opérateur.
- Un bundle immuable de variables par application/environnement/configuration,
  pas une collection de lectures « latest » indépendantes.
- Un chargeur commun au démarrage lit le fournisseur désigné par la référence.
  Il n’appelle pas le portail : une nouvelle instance doit démarrer même si le
  portail est arrêté, tant que son fournisseur est disponible.
- Aucun repli automatique OpenBao → bucket, ni copie permanente vers les deux.
  Le fournisseur par défaut ne s’applique qu’aux nouvelles écritures ; une release
  utilise toujours la référence capturée lors de sa préparation.
- Pas de changement Cloud Run/ArgoCD/Crossplane ni d’autre hébergement.

## 3. Périmètre et invariants de non-régression

Première version : applications Cloud Run GCP, dev/prod, variables au démarrage.
Azure, secrets de build, rotation à chaud et moteurs de secrets dynamiques sont
hors périmètre ; leur ajout fera l’objet d’une autre décision.

N01. Application sans nouvelle variable : workflow, identité, commande, image et
configuration existants conservés ; aucun appel GCS/OpenBao additionnel requis.
N02. Références Secret Manager déjà publiées conservées et lisibles : ne pas les
réinterpréter comme des références bucket/OpenBao et ne pas supprimer leur client.
N03. Une panne du nouveau fournisseur ne modifie pas une release active, ne coupe
pas son trafic et ne déclenche pas de suppression automatique de ressources saines.
N04. Une configuration non chargée intégralement interdit le démarrage du nouveau
processus ; aucun lancement partiel ou substitution silencieuse par une valeur vide.
N05. La production exige l’approbation existante du candidat exact. Changer les
variables, l’image ou le fournisseur invalide l’approbation du candidat précédent.
N06. Une révision et son rollback conservent image par digest, référence de bundle,
identité runtime et version du contrat/chargeur. Un Git SHA seul n’est pas suffisant.
N07. Ne jamais démarrer le portail lui-même en dépendant de son propre endpoint de
variables ; accès fournisseur direct par identité machine, bootstrap opérateur séparé.

## 4. Expérience et contrat du formulaire

Le parcours reste Application → Variables → Récapitulatif → Déployer.
L’import est facultatif, lu dans le navigateur, .env/.txt, maximum 256 Kio de fichier.
Formats : NOM=valeur, commentaires, export, guillemets simples/doubles, multilignes,
valeurs vides. Aucune évaluation de shell, substitution ${...} ou exécution du fichier.
Les doublons internes sont signalés sans modifier partiellement le formulaire ;
une clé importée remplace la clé déjà présente. Les lignes vides sont retirées.
PORT, HOST, DATA_DIR, DD_ENV, DD_SERVICE, DD_VERSION et LOG_LEVEL sont ignorées à
l’import avec leur nom affiché ; une écriture API de ces noms est rejetée.

Limites conservées : 100 clés, nom portable de 128 caractères maximum,
32 Kio UTF-8 par valeur, 64 Kio au total clés+valeurs, sans NUL. Les sauts de ligne,
Unicode, signes = et valeurs vides doivent rester identiques au chargement.
Les valeurs sont masquées, éditables avant validation, absentes du récapitulatif.
Un retour Précédent conserve la saisie. Fermer/navigation/succès l’effacent.
Aucune valeur dans localStorage, sessionStorage, cookies ou session serveur.

Suivant reste utilisable si les champs sont valides, y compris pendant un contrôle
de stockage ; il ne peut dépasser l’étape 3. Déployer exige une capacité vérifiée
et affiche la cause exploitable si elle manque, avec une commande de revérification.
Un échec conserve les champs et n’annonce pas un déploiement réussi.
Les API refont tous les contrôles de droits, origine/CSRF, HTTPS et limites.
Le détail expose les noms et actions conserver/remplacer/supprimer, jamais les
valeurs déjà stockées. Ni navigateur ni développeur n’ont d’identifiant fournisseur.

## 5. Contrat fournisseur indépendant

Interface logique versionnée, à implémenter dans src/services/variable-store.js :

```text
capability(context) -> {available, code, safeMessage}
writeBundle(scope, bundleId, completeValues, operationId) -> BundleRef
readBundle(BundleRef, machineIdentity) -> completeValues  # runtime/migrateur seulement
verifyMetadata(BundleRef) -> metadata                    # sans payload UI/CI
```

BundleRef v1 contient exclusivement : schemaVersion=1, provider=gcs|openbao,
applicationId interne, environment=dev|prod, bundleId aléatoire, locator structuré
et version obligatoire. Les noms sont des métadonnées séparées ; aucun payload
ni hash de valeur secrète en base/Git/logs. Locator GCS : bucket, object, generation
chaîne décimale. Locator OpenBao : alias de connexion, mount, path, version numérique.
Les URLs d’endpoint et rôles ne sont jamais choisis par un formulaire utilisateur.
Le chargeur n’accepte que les hôtes TLS configurés par l’opérateur et les chemins
validés ; refuse redirections, versions manquantes, inconnu, sortie du scope et TLS
invalide. Ne jamais transformer ces références en variables Cloud Run value=secret.

Le payload est un objet JSON UTF-8 versionné {schemaVersion, applicationId,
environment, bundleId, values:{NOM:chaine}}. JSON évite les ambiguïtés de shell.
Le chargeur vérifie le scope, la structure, la taille et les clés réservées.
La comparaison de copies pour migration se fait en mémoire, sans log ni empreinte
publique calculée sur les secrets. Les fonctions d’erreur ne propagent pas Axios
config/request, corps fournisseur, headers ou tokens.

Conserver les références historiques native-secret-manager dans leur ancien
schéma et chemin de lecture. La base migre de manière additive ; aucun remplacement
destructif de refs_json. Un déploiement ne mélange pas les deux mécanismes pour une
même clé ; tout conflit bloque le candidat avec une erreur de métadonnées sûre.

## 6. Fournisseur GCS temporaire

- Bucket dédié aux variables pour chaque application/environnement, séparé du
  bucket /data. Nom dérivé d’identifiants internes et du projet, pas du seul nom UI.
- Uniform bucket-level access, public access prevention enforced, chiffrement au
  repos GCS et TLS obligatoires. Pas d’ACL publique ni URL signée exposée au client.
  Cette protection n’équivaut pas aux fonctions d’un gestionnaire de secrets ; les
  administrateurs stockage autorisés peuvent lire les objets. Aucune clé de
  chiffrement partagée intégrée dans l’image ou le dépôt.
- Objet bundles/<bundleId>.json créé avec ifGenerationMatch=0 ; génération exacte
  conservée en chaîne, lue explicitement. Jamais d’écrasement en place ni latest.
- IAM : identité du portail dédiée, droits de création/contrôle nécessaires dans le
  bucket ; runtime dédié à cette application/environnement, lecture seule de ses
  bundles sans écriture/suppression. Les droits projet globaux objectViewer/admin
  des runtimes sont interdits. Vérifier aussi les droits hérités dans les tests.
- Provisionnement IAM/bucket par l’infrastructure de contrôle CNP ; Crossplane
  actAs borné à l’identité runtime concernée. Le choix du bucket n’élimine pas IAM.
- Pas de montage /data ni de source .env par un shell. Lecture HTTPS authentifiée
  au démarrage, valeurs en mémoire du processus. Pas de valeur dans les arguments.
- Journalisation Data Access configurée sans payload. Toute rétention automatique
  susceptible de supprimer une version encore utilisée est interdite.
- Échec avant activation : bundle orphelin marqué pour nettoyage ultérieur, sans
  modification des références actives ni suppression précipitée du bundle précédent.

## 7. Fournisseur OpenBao cible

OpenBao s’exécute comme service de plateforme, pas comme composant éphémère de
chaque Cloud Run. L’opérateur choisit et documente une version supportée épinglée
et un déploiement durable ; pas de mode dev ni token root dans les applications.
Avant prod : TLS, accès réseau depuis portail et Cloud Run, topologie HA validée,
sauvegarde/restauration de son stockage durable, procédure d’initialisation et
seal/unseal, supervision santé/état scellé et audit sans valeurs. Une mise à jour
ou restauration doit être répétée en préproduction. Les clés de déverrouillage
et l’identité de bootstrap restent sous contrôle opérateur, hors du portail.

Modèle KV v2 proposé : mount cnp-runtime, chemin
apps/<applicationId>/<environment>/bundles/<bundleId>, version exacte, initialement 1.
Chaque nouveau bundle reçoit un nouveau chemin et CAS=0. Pas de mise à jour en
place des bundles publiés. Politiques runtime : read data de son seul scope,
aucun list global, write, delete, destroy ou metadata administrateur. Le contrôle
crée les nouveaux chemins ; il ne détruit pas les versions déployées. Les droits
CAS et create-only doivent être prouvés sur la version OpenBao retenue.

Cloud Run : JWT d’identité obtenu auprès du metadata server, audience dédiée à
OpenBao, validation signature/issuer/audience et liaison au sub stable du compte
runtime exact. Ne pas faire confiance à une adresse email déclarée par le client.
L’échange JWT produit un token OpenBao court (cible 5 minutes), lecture du bundle
puis abandon du token ; aucun token statique dans GitHub, base ou manifeste.
Le portail utilise une identité de contrôle distincte, JWT ou identité Kubernetes
validée selon son hébergement. Aucun auth Kubernetes imposé à un Cloud Run.

Le flux Google JWT → rôle OpenBao sera testé réellement avant activation ; son
support de principe ne prouve pas que le réseau, les claims et les politiques de
notre environnement sont configurés. Aucun fallback AppRole à secret permanent
ou désactivation de TLS pour contourner un échec d’intégration.

## 8. Chargeur runtime et compatibilité des images

Livrable proposé : binaire cnp-env-exec autonome, versionné, linux amd64/arm64,
sans dépendance Node/Python/shell dans l’image cible. Fournisseurs GCS et OpenBao
supportés dans le même binaire dès la première version ; version de contrat et
digest du chargeur tracés. Runtimes non-root et distroless à tester explicitement.

Sans référence : exécuter la commande d’origine sans appel réseau fournisseur.
Avec référence : identité workload → lecture bundle exact → validation complète →
construction de l’environnement → exec du processus initial. Conserver cwd, UID,
arguments et limites ; signaux SIGTERM/SIGINT et code de sortie identiques.
Les variables de la plateforme priment ; aucune injection d’une clé réservée.
Les variables gérées priment sur les ENV de l’image pour les clés non réservées.
Ne pas exécuter une commande reconstituée avec eval ou shell non prévu.

Budget : récupération complète au plus 15 s, requête au plus 3 s, trois tentatives
maximum avec backoff dans le budget ; 401/403, mauvais scope ou payload invalide
échouent immédiatement. Après échec : code stable CONFIG_* et correlationId,
aucun payload. Ne pas ouvrir le port de l’application avant configuration complète.
Une panne après chargement ne modifie pas le processus existant ; rotation =
nouveau bundle et nouveau rollout, pas de modification silencieuse à chaud.

Ne pas convertir automatiquement tout Dockerfile arbitraire. Image générée : le
modèle intègre le chargeur en conservant ENTRYPOINT+CMD au format exec. Dockerfile
utilisateur : contrat explicite opt-in et diagnostic de compatibilité avant stockage
ou CI. Un ENTRYPOINT shell, un tini existant, les arguments Cloud Run command/args
et un CMD surchargé font partie de la matrice. Une image non compatible ne doit
pas recevoir une référence qu’elle ignore ; refuser uniquement l’ajout de variables
avec explication, garder le déploiement historique disponible sans nouvelles variables.

## 9. CI, GitOps et candidat atomique

La CI construit une image générique et ne lit jamais le fournisseur. Aucun payload,
token runtime, fichier .env, secret dans cache, artifact, argument de build ou log.
GitHub OIDC utilisé pour le build existant ne doit pas donner les droits runtime.
Le fournisseur choisi n’altère pas le Dockerfile applicatif à chaque migration.

Une release capture dans une seule transaction : deploymentId, sourceRevision,
imageDigest, BundleRef ou snapshot des références historiques, noms, runtimeAccount,
loaderVersion/schemaVersion et identifiant de candidat. Toutes les comparaisons et
approbations portent sur ce candidat, pas sur les métadonnées globales actuelles.
Ajouter/supprimer une variable pendant une CI crée un autre candidat ; la CI
ancienne ne peut publier les nouvelles valeurs ni réutiliser l’ancienne approbation.
Les verrous sont partagés par toutes les instances. Ne pas valider du multi-instance
sur un SQLite monté via GCSFuse : démontrer la transaction partagée ou limiter
explicitement le portail à un seul writer avant ce chantier.

Phases : DRAFT → STAGED → CI_PENDING → CI_PASSED → APPROVAL_PENDING (prod)
→ PUBLISHING → VERIFYING → ACTIVE ; échecs distincts CONFIG_FAILED/CI_FAILED/
ROLLOUT_FAILED, reprise idempotente. Dev omet uniquement l’approbation manager.
Un operationId relie répétitions et bundle ; un même POST rejoué ne crée pas des
configurations concurrentes. Une modification de contenu est une nouvelle opération.
Timeout navigateur : endpoint de statut par operationId, sans payload, afin de
retrouver l’opération au lieu de relancer aveuglément. Les versions préparées non
publiées n’apparaissent pas actives dans le détail.

GitOps ne contient que références, noms et identités. Le contrôleur ne copie pas
les valeurs dans un Secret Kubernetes ou le manifeste Cloud Run. Rollout canari
sans transfert initial de trafic ; vérifier la bonne révision/digest/configuration,
son démarrage puis le health check avant transfert. Le mécanisme Cloud Run de
trafic doit être testé avec Crossplane/ArgoCD : ne pas supposer que Ready d’une
ancienne révision valide la nouvelle. Si le contrôle GitOps ne peut maintenir le
trafic précédent, bloquer la mise en prod de cette fonctionnalité.
Un échec du nouveau rollout conserve le dernier service sain, affiché séparément
de l’état du candidat échoué. Cleanup CI ne détruit pas la release saine.

## 10. Changements de dépôts prévus

| Dépôt/fichier | Changement après validation |
|---|---|
| cnp-portal/src/services/application-variables.js | Préparation d’un bundle complet, snapshots et idempotence |
| Nouveau src/services/variable-store.js | Contrat commun, choix explicite des écritures ; lectures par référence |
| Nouveaux src/clients/gcs-variable-store.js et openbao-variable-store.js | Fournisseurs et erreurs normalisées |
| src/clients/secret-manager.js | Compatibilité existante conservée ; pas de migration automatique |
| src/models/deployment-environment.js et modèle de releases | Schéma additif, références et snapshots de candidats |
| src/services/environment-deployment.js | Références runtime, identité, publication du candidat capturé, santé/traffic |
| src/routes/deployments.js, public/js/* et vues | Capacité du fournisseur choisi, diagnostic précis ; parcours conservé |
| scripts/platform/ | Diagnostic sans payload, migration dry-run/reprise, inventaire de rétention |
| Nouveau composant runtime cnp-env-exec | Binaire autonome et tests de démarrage multi-images |
| cnp-portal/Dockerfile | Opt-in du portail après preuve du chargeur et du bootstrap |
| src/services/onboarding.js | Génération du contrat CI avec version épinglée |
| Mooroon5-CNP/ci-templates | Packaging du chargeur dans images générées, validation Dockerfile, tests/scan |
| config-repo | Provisionnement bucket/IAM/OpenBao et références GitOps ; aucune valeur |

ci-templates est un dépôt partagé distant, absent du workspace actuel. Lire ses
instructions et workflows avant de figer ses chemins internes. Pas d’affirmation
sur son contenu non inspecté. Publier une version testée et référencer un commit
SHA immuable pour l’opt-in ; ne pas modifier @main globalement pour expérimenter.
Les autres applications restent sur leur workflow actuel jusqu’à leur migration.
Un interrupteur opérateur peut arrêter les nouvelles inscriptions et écritures,
mais ne retire jamais le chargeur, les références ou les droits des releases actives.

## 11. Migration bucket → OpenBao et retours arrière

1. Déployer le chargeur compatible avec les deux fournisseurs ; prouver le bucket
   en dev sur application démo avant d’activer de nouvelles applications.
2. Installer/valider OpenBao, identités, politiques, restauration et connectivité.
   Tester sans lui donner de trafic de production applicatif.
3. Inventorier références bucket actives, candidates, historiques encore supportées
   et images sans chargeur. Dry-run sans payload ; aucune suppression de source.
4. Un worker opérateur à accès temporaire lit une version GCS précise et crée un
   nouveau bundle OpenBao ; comparaison exacte en mémoire, manifeste de correspondance
   source/destination sans valeurs. Reprise idempotente sur operationId.
5. Créer un nouveau candidat conservant le digest image compatible. Approbation prod,
   canari, lecture version exacte, test santé puis transfert de trafic. Pas de
   modification en place des anciennes releases ni d’approbation implicite.
6. Après preuve, choisir OpenBao pour les nouvelles écritures. Ne pas basculer les
   anciennes références globalement et ne pas synchroniser en arrière-plan.
7. Rollback : restaurer ensemble digest et référence bucket d’origine conservée.
   Une version déjà supprimée n’est pas un rollback possible ; le vérifier avant.
8. Après 30 jours minimum et seulement si aucune référence active/pending/rollback
   ne l’utilise, nettoyage opérateur explicite, audité. Aucun lifecycle bucket
   générique ne décide seul de la suppression. Documenter la fenêtre de rollback.

Les références historiques Secret Manager suivent une migration séparée explicite ;
elles continuent de fonctionner jusque-là. Suppression d’une application : arrêter
le service, révoquer les droits runtime puis appliquer la rétention ; ne pas
supprimer immédiatement les valeurs nécessaires aux autres candidats.

## 12. Critères d’acceptation et preuves obligatoires

| ID | Scénario | Résultat exigé |
|---|---|---|
| A01 | Déployer une app existante sans variable, fournisseurs arrêtés | Parcours et démarrage historiques fonctionnels |
| A02 | Import .env/.txt complet avec PORT, multilignes, vide, Unicode | Valeurs exactes, réservées signalées, noms seuls au récapitulatif |
| A03 | 20 clics Suivant, Précédent, fermer/réouvrir, Entrée | 1..3 uniquement, actions visibles correctes, aucun POST involontaire |
| A04 | Stockage absent, 403, sealed OpenBao, TLS invalide, timeout | Cause sûre visible, pas de faux succès ni publication partielle |
| A05 | Runtime app A tente app B et dev tente prod | Refus effectif GCS et OpenBao, même si chemin deviné |
| A06 | Création/remplacement/suppression avec CI concurrentes | Snapshot exact ; candidat obsolète ne publie pas |
| A07 | Prod déjà approuvée puis modification d’une variable | Nouvelle approbation du nouveau candidat nécessaire |
| A08 | CI échoue puis retry/suppression demandée | Release active préservée, retry idempotent, nettoyage isolé |
| A09 | Mauvaise configuration au démarrage/canari | Ancienne révision garde le trafic ; erreur du bon candidat |
| A10 | Rollback après rotation et migration de fournisseur | Même digest et mêmes valeurs que release sélectionnée |
| A11 | Rechercher une valeur canari dans Git/base/logs/cache/image/CI | Aucune occurrence hors mémoire runtime et stockage prévu |
| A12 | Metadata Google/JWT role : mauvais sub, aud, issuer, token expiré | Refus ; bon runtime lit seulement son bundle |
| A13 | Commandes Node/Python/binaire, non-root, tini, distroless, architectures | Arguments/cwd/signaux/code sortie conservés ; aucun shell ajouté |
| A14 | Redémarrer/scale-to-zero puis démarrer sans portail | Lecture directe fournisseur et démarrage dans le budget |
| A15 | Référence native Secret Manager préexistante | Aucun changement de valeur, identité ou mécanisme de lecture |
| A16 | Migration interrompue et reprise, puis rollback | Pas d’écrasement source ni référence orpheline publiée |
| A17 | Double POST, timeout navigateur, plusieurs writers | Une opération logique ; statut récupérable ; contrôle transactionnel |
| A18 | Mise à jour/restauration/OpenBao indisponible | Procédure répétée ; service actif préservé, cold start échoue clairement |

Tests unitaires contrat/parsing puis intégration réelle GCS/OpenBao et Docker,
ensuite préproduction via les vrais workflows partagés et Crossplane. Un mock ne
prouve pas IAM, claims JWT, signaux Linux ni trafic Cloud Run. Conserver les preuves
sans valeurs : versions d’outils, commit SHAs, IDs de runs, candidats/révisions,
codes d’erreur et résultats, avec date et opérateur.

Portes de livraison :
G0 validation de cette user story/spec ; G1 contrats/snapshots/compatibilité testés ;
G2 chargeur et CI épinglée sur app démo, aucun changement global ; G3 bucket réel +
rollback démontré en dev ; G4 canari prod approuvé et ancien trafic préservé ;
G5 mêmes preuves OpenBao + restauration ; G6 migration progressive et rétention.
Aucune généralisation avant les preuves correspondantes. Retour en arrière par
référence/release, pas par suppression du contrôle de sécurité ou droits publics.

## 13. Conditions opérateur à renseigner avant développement d’intégration

Le développement des contrats/tests peut commencer après validation ; l’activation
reste bloquée jusqu’à inventaire explicite : projet/buckets, identité du portail,
identités runtime, droits Crossplane, réseau Cloud Run↔OpenBao, emplacement durable
OpenBao, version/digest, méthode unseal et responsables de restauration, version
ci-templates de référence, writer DB réel, applications pilotes et fenêtre rollback.
Ces informations ne sont pas des demandes de mots de passe ou de tokens utilisateur.

## 14. Sources primaires vérifiées le 4 novembre 2026

- [OpenBao KV v2 : versions et concurrence](https://openbao.org/docs/secrets/kv/kv-v2/).
- [OpenBao JWT : validation et rôles](https://openbao.org/docs/auth/jwt/).
- [OpenBao agent/proxy : authentification initiale et accès applicatif](https://openbao.org/docs/agent-and-proxy/).
- [Cloud Run : identité de service](https://docs.cloud.google.com/run/docs/securing/service-identity).
- [GCS : préconditions et générations](https://docs.cloud.google.com/storage/docs/request-preconditions).
- [Cloud Run : références natives Secret Manager](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

Les faits de ces sources fondent le choix ; l’adaptation CNP, les budgets et les
portes de validation sont des décisions de conception proposées, pas des garanties
fournies par les produits.


## 15. Premier incrément sur fix/cloudrun-environment

Le demandeur confirme cnp-platform = portail actuel et demande la compatibilité
avec les autres applications, notamment Pixel App (Mooroon5-CNP/app4-pixelcalm).
Aucune liste blanche de noms d’applications n’est admise. La compatibilité dépend
du contrat io.cnp.variables-contract=1 dans l’image, pas du produit ou langage.

Premier chargeur livré : module sans dépendance npm pour images disposant de
Node >=20. Il lance n’importe quel processus (dont Python), utilise execve sur
Node qui l’expose, sinon un superviseur avec transmission des signaux. Cette
première livraison remplace provisoirement la proposition de binaire autonome de
la section 8 ; une image dépourvue de Node doit intégrer un runtime compatible ou
attendre le futur binaire. Ne pas déclarer toutes les images arbitraires supportées.
Pixel App dispose de Node 20 et tini : un installateur conserve leurs arguments,
le WORKDIR, l’UID et les étapes de build ; il refuse un shell non analysable.
L’installateur ne pousse rien et ne modifie pas le dépôt distant automatiquement.

Le portail embarque ce chargeur ; sans référence il n’effectue aucun appel au
fournisseur. Le mode par défaut reste secret-manager pour compatibilité. Le mode
gcs/openbao est explicite par CNP_VARIABLES_PROVIDER. Les bundles existants
conservent leur fournisseur de lecture. Les clés CNP_VARIABLES_* et CNP_OPENBAO_*
sont réservées au contrôle plateforme et ne peuvent être injectées par l’import.

Un marqueur de référence versionnée est capturé dans le commit applicatif qui
lance la CI ; la publication refuse une CI qui ne correspond pas au bundle courant
et revérifie cette référence avant la publication GitOps. Les références ne
contiennent aucune valeur. La préparation de l’aperçu de branche utilise un profil
opérateur distinct sans modifier la base du portail ni les déploiements existants.

La preuve visée pour cette branche est un service privé cnp-portal-preview, digest
scanné de la branche et bundle versionné, distinct du service existant. Le workflow
cnp-preview.yml construit/scanne avec un SHA ci-templates épinglé. Il ne pousse pas
main et ne publie pas de ressources live. Le rendu preview produit un V2Service
isolé ; l’opérateur l’applique après prérequis IAM/réseau et vérifie le démarrage.
Guide exact : OPENBAO_GKE_BRANCH_DEPLOYMENT.md. Cette livraison ne prétend pas
avoir validé le canari prod G4, les snapshots de tous les mécanismes historiques,
la restauration G5 ou le binaire portable multi-images de la cible finale.
