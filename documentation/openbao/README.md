# Variables d'environnement avec OpenBao — ordre de réalisation

Branche de travail : `feat/OpenBao-Vault`. Ces spécifications décrivent les variables **des applications déployées**, pas la migration de la base SQLite du portail. Le déploiement des instances OpenBao et de la plateforme est pris en charge séparément par l'utilisatrice. Aucune opération `terraform apply`, déploiement live ou push de `cnp/cluster` n'est impliquée.

La [liste opérationnelle des prérequis des instances](instances_openBao.md) précise ce qui est déjà préparé et ce qui reste à installer sur chaque cloud.

| Ordre | Spécification | Code sur `feat/OpenBao-Vault` | Acceptation complète |
| --- | --- | --- | --- |
| 0, plateforme | [SPEC-OPENBAO-00](SPEC-OPENBAO-00-instances-et-prerequis.md) | Contrat et prérequis documentés ; instances AWS/Azure non déclarées ici. | **À faire** : instances, identités, réseau et tests d'accès réels. |
| 1 | [SPEC-OPENBAO-01](SPEC-OPENBAO-01-contrat-et-routage.md) | Client KV v2, CAS, routage et générations implémentés et testés avec faux services. | **À faire** : vérifier les politiques JWT, l'isolation et la panne sur les instances réelles. |
| 2 | [SPEC-OPENBAO-02](SPEC-OPENBAO-02-livraison-deploiements.md) | Livraison, modification, retour arrière et nettoyage après suppression codés pour GCP, Azure et secours AWS ; références versionnées dans les manifests. | **À faire** : identités et droits cloud, vérification réelle du cycle de vie et recettes. |
| 3, **en dernier** | [SPEC-OPENBAO-03](SPEC-OPENBAO-03-formulaire-variables.md) | Saisie manuelle, import `.env`, validation serveur et préflight implémentés. | **À faire** : démonstration d'un déploiement réel dans chaque mode et contrôle après redémarrage. |

**Aucune de ces SPEC n'est marquée `DONE` au sens de ses critères d'acceptation.** Les parties codées et testées localement sont indiquées ci-dessus ; la recette cloud n'a pas eu lieu. Le détail des prérequis manuels est dans [instances_openBao.md](instances_openBao.md).

## Reste à faire pour que tout fonctionne

1. **Installer et raccorder OpenBao GCP, Azure et AWS :** HTTPS/CA, stockage durable, auto-unseal, sauvegarde, KV v2 avec CAS, auth JWT du portail, politiques par chemin, DNS et accès depuis le pod réel. Revoir la déclaration GCP existante pour les futurs comptes ; AWS et Azure n'ont pas encore de déclaration d'instance dans les dépôts inspectés.
2. **Préparer les identités et permissions cloud :** écriture du portail vers GCP Secret Manager, Azure Key Vault et AWS Secrets Manager ; lecture par des comptes runtime GCP, identités Container Apps Azure et rôles d'exécution ECS AWS dédiés à chaque application/environnement. Fournir les paramètres non secrets listés dans `instances_openBao.md`. L'attribution et la configuration par application sont aujourd'hui manuelles ; leur automatisation reste à concevoir si le déploiement doit être entièrement en libre-service.
3. **Vérifier le contrat des providers et les comptes :** contrôler sur le cluster les champs Crossplane Cloud Run et Container Apps, ainsi que le montage du jeton fédéré Azure. Avant la bascule de comptes, retirer les identifiants historiques du moteur failover, de la provenance CI et des déclarations Terraform/config-repo concernées.
4. **Vérifier le cycle de vie des variables :** la modification et le retrait sans nouvelle image CI, le retour arrière et le nettoyage après disparition des ressources sont codés ; vérifier ces parcours sur les clouds réels. Les versions provisoires dont l'API a confirmé l'écriture sont détruites si la préparation échoue ; une réponse perdue après écriture peut encore laisser une version inconnue à inventorier.
5. **Faire la recette réelle :** application fictive avec une valeur manuelle et une importée depuis `.env` en GCP SQLite, GCP PostgreSQL dev, Azure et GCP PostgreSQL prod avec AWS ; vérifier lecture après démarrage/redémarrage, absence de valeur en clair dans Git/logs, refus d'accès croisé, validation manager, CI échouée et démarrage AWS sans GCP.

Le choix d'hébergement et de données existant détermine automatiquement le ou les domaines OpenBao. L'utilisateur n'a aucun choix « serveur OpenBao » supplémentaire à faire. Le mode GCP PostgreSQL en production conserve son secours AWS obligatoire ; GCP SQLite et GCP PostgreSQL en dev n'activent pas ce secours.

Le pipeline CI continue à construire et publier l'image immuable. Les variables sont des **données d'exécution** prises en charge lors de la publication du déploiement après succès CI. Aucune modification du workflow de build n'est prévue par ces trois SPEC ; si un essai démontre qu'un workflow réécrit le manifeste de runtime ou supprime ses références, corriger cette seule interaction et ajouter un test ciblé. Les variables nécessaires à la construction de l'image restent hors de ce périmètre.

Les comptes cloud, projets, régions, zones, identifiants OpenBao et ARN ne doivent pas être figés dans le code. Les paramètres d'identité, réseau et destination qui relèvent de l'infrastructure sont déclarés par environnement, de préférence via Terraform quand un changement est nécessaire. Aucune valeur secrète n'est fournie dans Git ni dans un plan Terraform.

## Séquence de vérification

1. Vérifier les prérequis de SPEC-OPENBAO-00 ; tests locaux avec faux OpenBao pour l'isolation et le routage, sans appel cloud.
2. Test pilote GCP, puis Azure, puis GCP avec secours AWS ; vérifier la valeur lue par l'application après démarrage et redémarrage.
3. Tester refus d'accès croisé, absence d'OpenBao, échec de livraison, reprise et suppression sans régression des déploiements sans variables.
4. Terminer par le formulaire et le scénario utilisateur complet décrit dans SPEC-OPENBAO-03.
