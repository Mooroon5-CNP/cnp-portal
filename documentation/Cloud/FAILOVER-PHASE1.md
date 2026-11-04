# Failover CNP — phase 1

Le failover est une capacité par application de production GCP. PostgreSQL est
le seul moteur de base pris en charge pour le moment ; les applications sans
base conservent un parcours stateless. Pixelcalm n'est qu'un ancien pilote.

## Parcours manager

Le déploiement demande `Activer le failover GCP → AWS` et publie une même image
par digest dans GAR et ECR. Le portail vérifie la provenance CI et la révision
courante avant publication et avant approbation du runtime.

Depuis `/failover?app=<nom>`, la création du profil lance une préparation
persistante. Un profil non encore initialisé peut aussi utiliser **Démarrer la
préparation automatique**. La plateforme enchaîne :

1. Plan des conteneurs de secrets, puis initialisation sans rotation implicite.
2. Proposition GitOps des bases ; attente des ressources et collecte des CA.
3. Plan de la tâche bootstrap, copie initiale et preuve d'une écriture rejouée.
4. Proposition des runtimes, contrôle de la nouvelle révision GCP et du secours
   ECS/ALB, puis proposition DNS et observation des contrôles réellement créés.
5. Plan du worker, configuration en pause, vérification du profil exact,
   nouvelle preuve SQL, plan d'activation, activation et santé opérationnelle.

Chaque proposition GitOps et chaque plan Terraform modifiant le cloud attend
sa revue manager. L'automate ne fabrique aucune approbation humaine. La revue
GitOps porte sur le SHA et la baseline exacts ; un apply porte sur un plan
sauvegardé et scellé. Destruction et remplacement sont refusés.

L'état et les identifiants des opérations sont conservés dans SQLite. Après
interruption, **Reprendre après correction** utilise les tâches ECS suivies et
leur journal. Un apply incertain exige un nouveau plan et une nouvelle revue.
La convergence des fournisseurs est observée pendant une heure au maximum,
sans rejouer l'initialisation SQL. Un manager révoqué ne poursuit pas le parcours.
Une préparation SQL déjà engagée manuellement n'est jamais réinitialisée par
la création implicite d'un nouvel automate.

Après mise en service, les contrôles de santé continuent périodiquement.
Une ancienne preuve, une preuve liée à un autre profil ou une date future ne
permettent pas d'annoncer l'application prête. La santé SQL contrôle aussi le
profil du worker et les cibles EventBridge réellement activées.

## Bascule pendant une panne

Une fois activé, le worker AWS assure la bascule sans action manager pendant la
panne. Il exige plusieurs signaux, une panne publique confirmée et la source
SQL privée inaccessible. Une panne du seul frontend avec PostgreSQL encore
accessible reste en attente de confirmation ; elle ne suffit pas à ouvrir un
second écrivain. Le worker promeut RDS, aligne les séquences et ouvre le verrou
DNS. Il ne réalise aucun failback automatique. La réplication asynchrone ne
promet pas zéro perte lors d'une panne totale.

## Installation actuelle

Utiliser Node 22 et conserver `.env`, `.env.cloud`, SQLite et les comptes
existants. Les opérations locales utilisent les dépôts frères `cnp` et
`config-repo`, Python avec leurs dépendances, Terraform, kubectl et gcloud.
`CNP_FAILOVER_OPERATOR_PYTHON` désigne l'interpréteur opérateur.

`CNP_FAILOVER_SETTINGS` référence des documents locaux expurgés : profil,
références Terraform, résultat d'initialisation et observations. Les paramètres
partagés incluent les images opérateur et les varfiles déjà appliqués. Ils ne
sont pas committés. `exposeLegacyApplication=false` masque l'ancien pilote sans
supprimer ses ressources. Le paquet opérateur rassemble les profils publiés et
conserve aussi les applications/générations déjà présentes dans le state.

Le portail cloud standard ne contient pas encore ce paquet opérateur et ses
outils. Ne pas déduire d'un build de son image que ce parcours local est installé
dans Cloud Run. Les tests CI du portail utilisent une révision explicite des
générateurs du dépôt privé `config-repo`, lue avec `CONFIG_REPO_TOKEN`.

Les applications PostgreSQL doivent utiliser les variables `DB_*` injectées,
le rôle runtime dédié et la vérification de CA. Fournir une sonde de vie AWS
indépendante de la disponibilité SQL : le standby SQL reste fermé avant
promotion. Les applications sans base ne doivent pas dépendre de fichiers ou
sessions locaux pour assurer leur continuité.

## Préservation et limites restantes

Les buckets, objets, configurations et applications existants sont conservés.
Les ressources générées utilisent `Orphan` ; aucune sélection ApplicationSet
existante n'est retirée. Aucun changement de VM, IP, clé ou WireGuard.
Cloud SQL reste en `ENCRYPTED_ONLY`, applications et administration vérifient la
CA. L'exception `wireguard-tls` concerne uniquement le subscriber natif RDS.

Le contrat PostgreSQL actuel décrit manuellement plusieurs tables `public`,
avec des types limités, une clé primaire simple et des séquences identity
positives. **Il ne couvre pas encore tous les schémas ou migrations PostgreSQL.**
La préparation générique du schéma et les migrations DDL restent à terminer ;
la réplication logique ne réplique pas ces migrations.

Les tests de l'automate et de ses contrôles ne remplacent pas la recette d'un
nouveau déploiement par le portail. Cette recette complète et le test de panne
réservé à Thomas restent nécessaires avant de déclarer la phase 1 terminée.
Le portail ne coupe ni GCP ni WireGuard pour sa recette.
