# Failover GCP → AWS — modèles de profil

Ces modèles servent de base au profil failover qu'enregistre le portail CNP pour une application de production
(`createProfile`). Ils ne sont référencés par aucun Kustomization ni ApplicationSet : aucun déploiement ne découle de leur
présence dans `docs/`.

- `postgres/` : application avec base PostgreSQL. Seul le nom de la base se déclare (`{"database": "appdb"}`) ; le schéma
  est lu dans la base de l'application une fois démarrée sur GCP, puis restauré sur AWS et répliqué.
- `stateless/` : application sans base (runtimes GCP et AWS, DNS de bascule).

Le parcours complet (secrets, bases, runtimes, réplication, DNS, worker, bascule, retour vers GCP, suppression) est piloté par
le portail ; les manifestes sont produits par `prepare_failover_phase1.py` (dossier `engine/`) et ses générateurs, puis publiés par le bot
du portail (seul compte autorisé sous `apps/*/crossplane/prod/`).

La première version du failover (pilote `app4-pixelcam`, contrats de schéma écrits à la main, profils `recipe`/`pixelcalm`,
worker et Terraform par application) a été retirée le 07/11/2026.
