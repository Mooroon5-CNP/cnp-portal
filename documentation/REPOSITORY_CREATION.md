# Création de dépôts indépendante du déploiement

Depuis Déploiements, deux actions distinctes : « Créer un dépôt » et « Déployer
une application ». La création propose deux modèles Python / Flask : SQLite
(fichier persistant, peu d'écritures simultanées) et PostgreSQL (serveur séparé,
écritures concurrentes, possibilité de secours configurée au déploiement).
L'aide recommande un modèle ; l'utilisateur confirme explicitement sa sélection.

Les modèles sont livrés dans `src/templates/repositories`, donc disponibles dans
l'image existante du portail. Aucune dépendance à une branche externe de modèles.
Ils contiennent un Dockerfile, un exemple de persistance et les instructions de
configuration. Aucun workflow CI ni ressource cloud n'est créé par ce parcours.

La GitHub App existante crée un dépôt **public** dans l'organisation définie par
`GITHUB_CONFIG_REPO_NAME`, écrit le modèle et crée les branches `main` et `prod`.
L'App doit avoir la permission de dépôt Administration: write pour créer un dépôt,
Contents: write pour écrire le code, et accès aux nouveaux dépôts (installation
sur tous les dépôts recommandée). Les identifiants existants de l'App sont utilisés.
La création doit être permise par les règles de l'organisation.

Le client et la validation sont adaptés du travail de
`feat/create-github-repo-from-templates`. Son intégration dans l'onboarding n'est
pas reprise. L'accès `config-repo` par PAT reste inchangé, comme les opérations
existantes de déploiement, de failover et de nettoyage.

Un échec partiel conserve le dépôt et indique son URL : corriger le dépôt avant
de le déployer ; ne pas relancer aveuglément la création. Un nom existant n'est
jamais écrasé. La confirmation de visibilité publique est obligatoire.

La page de succès propose « Déployer ce dépôt ». Ce lien remplit uniquement les
champs dépôt, nom et port du formulaire existant. L'utilisateur doit encore
choisir les options compatibles SQLite/PostgreSQL et soumettre le déploiement.
Créer un dépôt ne crée pas de base de données et ne déclenche pas de déploiement.

Validation locale : tests du client GitHub, du service avec les vrais fichiers
des modèles, des routes et des déploiements existants. Avant utilisation en
production, vérifier avec un dépôt d'essai les permissions réelles de l'App et
les règles de l'organisation ; les tests simulés ne prouvent pas ces permissions.
