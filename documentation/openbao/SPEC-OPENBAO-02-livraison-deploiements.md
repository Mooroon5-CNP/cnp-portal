# SPEC-OPENBAO-02 — Livraison des variables dans les déploiements existants

**Ordre : 2/3.** Dépend de SPEC-OPENBAO-01. Ne modifie pas la génération ni la publication de l'image CI.

## Résultat fonctionnel

Après une CI réussie, le portail prépare les variables de la version choisie pour le runtime et publie le déploiement par les chemins GitOps existants. L'application reçoit ses variables au démarrage et au redémarrage sans appeler le portail. Le portail indisponible empêche les changements et nouveaux déploiements, mais ne rend pas indisponible une application déjà provisionnée.

| Mode actuel | Adaptation minimale |
| --- | --- |
| GCP Cloud Run, SQLite/GCS ou Cloud SQL | Utiliser des versions de Secret Manager et des références `valueSource.secretKeyRef` dans le claim Cloud Run. Préserver `DB_*`, les références `runtime-secrets.yaml` existantes et les valeurs gérées par l'opérateur. |
| Azure Container Apps | Livrer les valeurs par le mécanisme de secrets et références d'environnement de Container Apps/Crossplane, sans ajouter les valeurs dans les manifests Git. Préserver les secrets PostgreSQL existants. |
| GCP PostgreSQL prod, avec son secours AWS obligatoire | Préparer les valeurs dans le domaine OpenBao AWS et dans le mécanisme de secrets AWS requis par le runtime de secours **avant** de rendre la version publiable. Tester un redémarrage AWS sans portail ni OpenBao GCP. |

GCP SQLite, y compris en production, et GCP PostgreSQL dev ne provisionnent aucune variable sur AWS. Leur mode actuel ne promet pas de reprise AWS.

## Préservation du flux existant

- Garder les branches `main`/`prod`, le workflow CI, l'image identifiée par SHA, la publication après CI et la validation manager en production. Les variables sont injectées dans la phase runtime, après la réussite CI et avant de déclarer l'application prête.
- Le choix `GCP PostgreSQL` en production conserve le secours AWS imposé par `src/routes/deployments.js`. Ne pas ajouter d'option de secours indépendante ni ouvrir le chemin GCP PostgreSQL prod sans secours ; préserver le formulaire et les validations de déploiement actuels.
- Pas de valeur secrète dans le config-repo, les PR, les logs CI, les URLs, les messages d'erreur ou les artefacts. Les manifests contiennent seulement des références et versions.
- Une mise à jour de variables doit produire une nouvelle révision de configuration contrôlée sans reconstruire l'image si le code ne change pas. Les changements de valeur ne doivent pas être considérés comme une CI réussie sur un nouveau SHA de code.
- Le retrait d'une variable, la suppression d'un environnement et le retour arrière ne suppriment que les versions possédées par cet environnement, avec une politique de conservation compatible avec un runtime encore actif.

## Critères d'acceptation

1. Une application témoin GCP SQLite et une GCP Cloud SQL lisent la même variable de test après démarrage et redémarrage ; les déploiements sans variable continuent à fonctionner.
2. Une application témoin Azure lit sa variable sans valeur en clair dans Git et sans casser son secret de base PostgreSQL.
3. GCP PostgreSQL prod prépare les deux côtés ; GCP SQLite et GCP PostgreSQL dev ne touchent pas AWS. Une panne GCP après préparation ne bloque pas la lecture des variables déjà livrées à AWS.
4. CI échouée, refus manager, échec de livraison ou version divergente empêchent toute nouvelle publication ; une application précédemment prête reste sur sa configuration précédente.
5. Les tests de régression couvrent le déploiement, la mise à jour, la suppression et le failover avec et sans variables.

## Pipeline et infrastructure

Aucune modification de pipeline n'est prévue pour des variables d'exécution : il continue à construire l'image. Vérifier par test qu'il ne réécrit pas les références ajoutées au runtime ; si c'est le cas, corriger cette interaction ciblée. Les identifiants cloud, permissions ou réseaux nécessaires sont paramétrés et, si besoin, déclarés de préférence en Terraform. Aucune application Terraform ni push sur `cnp/cluster` dans ce travail sans accord de l'utilisatrice.
