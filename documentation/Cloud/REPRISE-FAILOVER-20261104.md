# Point de reprise — phase 1, 4 novembre 2026

## Publication

À la demande de Thomas, les développements sont publiés uniquement sur ses
branches de travail. Aucune PR créée ni fusion dans main pendant cette reprise.

- cnp-portal : `feat/failover-phase1`, premier lot `b422dd7`.
- config-repo : `feat/generic-failover`, `3708842` (main intégré localement puis
  branche poussée ; générateurs génériques dans `48d77db`).
- ci-templates : `feat/generic-failover-images`, `c51ce20`.
- cnp : aucun changement fonctionnel ni apply pendant cette reprise.

## Changements livrés sur la branche portail

Préparation persistante par application depuis le portail : secrets, proposition
bases, observation, bootstrap, preuve SQL, runtimes, disponibilité, DNS, worker
en pause, nouvelle preuve SQL, activation et santé. Les plans et propositions
attendent toujours leur approbation manager exacte. L'automate ne les approuve
pas. Une préparation existante ne peut pas implicitement réinitialiser les bases.

Reprise du même journal de tâches après échec ; un apply incertain impose un
nouveau plan. Contrôle du rôle manager lors de la poursuite. Attente bornée de
la convergence. Renouvellement de la preuve SQL après une longue revue.

Correction des plans sans changements : les références Terraform existantes
sont récupérées même lorsqu'aucun apply n'est nécessaire. Le contrôle du worker
exige pause, état DISABLED et hash du profil exact. La santé contrôle les cibles
EventBridge activées, refuse les preuves obsolètes/étrangères/futures et continue
à être observée après la mise en service. Les nouvelles révisions GCP/ECS sont
contrôlées avant publication DNS.

Node 22 pour les tests, la validation CI et l'image portail. Validation de branche
activée ; les tests CI lisent les générateurs privés à une révision explicite.
Le secret CONFIG_REPO_TOKEN doit autoriser cette lecture.

## Vérifications réalisées

- 371 tests portail, 51 suites : passent sous Node 22.22.2.
- Lint JavaScript : passe.
- 3 tests opérateur Python avec fournisseurs simulés : passent.
- 56 tests générateurs et 7 tests ci-templates : passent.
- Portail local rechargé, PID observé 62940, port 3001.
- Santé HTTP 200 ; connexion existante valide ; Déploiements et Failover HTTP 200.
- Zéro déploiement local et zéro opération cloud en cours lors de la reprise.
- Sauvegarde SQLite avant rechargement, fichiers privés et comptes conservés.

Ces contrôles ne sont pas une recette cloud d'un nouveau déploiement. Aucun
apply cloud, aucune panne GCP/tunnel, aucun failback ou nettoyage cloud exécuté.
Le processus local est géré par la session d'exécution ; vérifier son état avant
utilisation ou arrêt, ne pas réutiliser aveuglément le PID ci-dessus.

## Restant avant clôture de la phase 1 générique

1. Remplacer la description manuelle et limitée des tables par un parcours
   commun pour le schéma PostgreSQL et ses migrations. Le contrat actuel
   n'accepte pas tous les schémas PostgreSQL ; PostgreSQL seul ne résout pas
   automatiquement la réplication DDL.
2. Valider un nouveau déploiement depuis le portail jusqu'aux deux runtimes,
   à la réplication fraîche, au DNS et au worker effectivement activé. Le
   parcours de provisionnement ajouté a été testé avec fournisseurs simulés,
   pas exécuté de bout en bout sur une nouvelle application cloud.
3. Réaliser avec Thomas la recette de panne. Aucune coupure globale de GCP ou
   du tunnel n'est autorisée dans l'automate de préparation.
4. Pour utiliser ce parcours depuis le portail cloud, empaqueter les dépôts
   opérateur, les outils et les paramètres de plateforme ; l'image standard
   n'inclut pas encore cet environnement local.

La phase 1 générique ne doit donc pas encore être annoncée terminée ou validée
pour toute application PostgreSQL. Le pilote historique ne remplace pas cette
recette. La liste locale vide ne prouve pas la suppression de ses ressources
cloud, qui n'a pas été effectuée pendant cette reprise.
