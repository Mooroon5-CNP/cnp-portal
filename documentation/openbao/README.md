# Variables d'environnement avec OpenBao — ordre de réalisation

Branche de travail : `feat/OpenBao-Vault`. Ces spécifications décrivent les variables **des applications déployées**, pas la migration de la base SQLite du portail. Le déploiement des instances OpenBao et de la plateforme est pris en charge séparément par l'utilisatrice. Aucune opération `terraform apply`, déploiement live ou push de `cnp/cluster` n'est impliquée.

| Ordre | Spécification | Résultat attendu |
| --- | --- | --- |
| 0, plateforme sous responsabilité de l'utilisatrice | [SPEC-OPENBAO-00](SPEC-OPENBAO-00-instances-et-prerequis.md) | Instances OpenBao et contrats d'accès nécessaires sur Azure, GCP et AWS, sans appliquer l'infrastructure depuis cette branche. |
| 1 | [SPEC-OPENBAO-01](SPEC-OPENBAO-01-contrat-et-routage.md) | Écriture et lecture versionnées, isolées par application/environnement, dans les domaines OpenBao appropriés. |
| 2 | [SPEC-OPENBAO-02](SPEC-OPENBAO-02-livraison-deploiements.md) | Livraison des références et valeurs aux runtimes GCP, Azure et, seulement si choisi, au secours AWS, sans changer la construction des images. |
| 3, **en dernier** | [SPEC-OPENBAO-03](SPEC-OPENBAO-03-formulaire-variables.md) | Saisie manuelle ou import `.env` dans le formulaire, puis déploiement d'une application témoin qui lit réellement ses variables. |

Le choix du cloud et du secours existant détermine automatiquement le ou les domaines OpenBao. L'utilisateur n'a aucun choix « serveur OpenBao » supplémentaire à faire. La production GCP doit proposer explicitement le secours AWS au lieu de l'imposer par le seul choix PostgreSQL.

Le pipeline CI continue à construire et publier l'image immuable. Les variables sont des **données d'exécution** prises en charge lors de la publication du déploiement après succès CI. Aucune modification du workflow de build n'est prévue par ces trois SPEC ; si un essai démontre qu'un workflow réécrit le manifeste de runtime ou supprime ses références, corriger cette seule interaction et ajouter un test ciblé. Les variables nécessaires à la construction de l'image restent hors de ce périmètre.

Les comptes cloud, projets, régions, zones, identifiants OpenBao et ARN ne doivent pas être figés dans le code. Les paramètres d'identité, réseau et destination qui relèvent de l'infrastructure sont déclarés par environnement, de préférence via Terraform quand un changement est nécessaire. Aucune valeur secrète n'est fournie dans Git ni dans un plan Terraform.

## Séquence de vérification

1. Vérifier les prérequis de SPEC-OPENBAO-00 ; tests locaux avec faux OpenBao pour l'isolation et le routage, sans appel cloud.
2. Test pilote GCP, puis Azure, puis GCP avec secours AWS ; vérifier la valeur lue par l'application après démarrage et redémarrage.
3. Tester refus d'accès croisé, absence d'OpenBao, échec de livraison, reprise et suppression sans régression des déploiements sans variables.
4. Terminer par le formulaire et le scénario utilisateur complet décrit dans SPEC-OPENBAO-03.
