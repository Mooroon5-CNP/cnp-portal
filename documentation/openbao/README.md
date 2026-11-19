# Variables d'environnement avec OpenBao — ordre de réalisation

Le déploiement Kubernetes du portail et son raccordement à l'instance GCP sont
documentés dans [spec_How_to-deploy_cnp-portal.md](spec_How_to-deploy_cnp-portal.md).

Branche du portail : `feat/OpenBao-Vault` ; branche d'infrastructure : `cnp/cluster`. Ces spécifications décrivent les variables **des applications déployées**, pas la migration de la base SQLite du portail. Le serveur OpenBao Azure a été appliqué avec l'autorisation donnée après pull de `cluster`. Aucun push sur branche protégée ni déploiement du portail n'a été effectué dans ce chantier.

La [liste opérationnelle des prérequis des instances](instances_openBao.md) précise ce qui est déjà préparé et ce qui reste à installer sur chaque cloud.
Pour Azure, le plan des identités et coffres (`cnp/azure/openbao-server/DELIVERY-PLAN.md`)
et la recette de restauration isolée (`cnp/azure/openbao-server/RESTORE-TEST.md`)
sont préparés sur une branche locale de `cnp`, sans `apply` du plan de livraison.

| Ordre | Spécification | Code sur `feat/OpenBao-Vault` | Acceptation complète |
| --- | --- | --- | --- |
| 0, plateforme | [SPEC-OPENBAO-00](SPEC-OPENBAO-00-instances-et-prerequis.md) | Serveur Azure déployé depuis `cnp/cluster` ; HTTPS, auto-unseal, KV v2/CAS, snapshot et persistance testés. | **À faire** : JWT depuis le pod, identités/coffres runtime, déploiement Azure et restauration isolée ; suivre GCP/AWS séparément. |
| 1 | [SPEC-OPENBAO-01](SPEC-OPENBAO-01-contrat-et-routage.md) | Client KV v2, CAS, routage et générations implémentés et testés avec faux services. | **À faire** : vérifier les politiques JWT, l'isolation et la panne sur les instances réelles. |
| 2 | [SPEC-OPENBAO-02](SPEC-OPENBAO-02-livraison-deploiements.md) | Livraison, modification, retour arrière et nettoyage après suppression codés pour GCP, Azure et secours AWS ; références versionnées dans les manifests. L'état observé est comparé aux versions attendues pour les trois chemins. | **À faire** : identités et droits cloud, vérification réelle du cycle de vie et recettes. |
| 3, **en dernier** | [SPEC-OPENBAO-03](SPEC-OPENBAO-03-formulaire-variables.md) | Saisie manuelle, import `.env`, validation serveur et préflight implémentés. | **À faire** : démonstration d'un déploiement réel dans chaque mode et contrôle après redémarrage. |

**Aucune de ces SPEC n'est marquée `DONE` au sens de ses critères d'acceptation.** Des tests cloud réels ont réussi sur le **serveur Azure**, mais pas encore le parcours portail → Container App. Le détail est dans [instances_openBao.md](instances_openBao.md).

## Reste à faire pour que tout fonctionne

1. **Terminer le raccordement Azure :** le serveur est actif. Appliquer les identités/coffres d'application à partir d'un plan sans modification ni suppression de l'existant, renseigner les paramètres non secrets et le jeton projeté dans le pod, puis tester le JWT réel depuis ce pod. Le contrôle d'appartenance est dans le portail ; son rôle OpenBao de contrôle peut accéder aux chemins de toutes les applications qu'il administre.
2. **Suivre GCP et AWS séparément :** les ressources Terraform pour les identités runtime GCP et les rôles ECS AWS sont préparées. Vérifier les instances et comptes actifs sur chaque cloud avant leurs recettes ; l'état du serveur Azure ne prouve rien pour ces deux domaines. La création des identités à la volée depuis le formulaire n'est pas automatisée.
3. **Vérifier le contrat des providers et les comptes :** le schéma Crossplane Container Apps installé accepte les champs de référence Key Vault et d'identité ; vérifier leur comportement lors d'un déploiement réel ainsi que le montage du jeton fédéré Azure. Contrôler aussi Cloud Run et les paramètres AWS avant les recettes de ces domaines.
4. **Vérifier le cycle de vie des variables :** la modification et le retrait sans nouvelle image CI, le retour arrière et le nettoyage après disparition des ressources sont codés ; vérifier ces parcours sur les clouds réels. Une réponse OpenBao perdue après écriture est récupérée par relecture si la génération est encore observable ; si cette relecture échoue également, une version inconnue peut rester à inventorier.
5. **Faire la recette réelle :** application fictive avec une valeur manuelle et une importée depuis `.env` en GCP SQLite, GCP PostgreSQL dev, Azure et GCP PostgreSQL prod avec AWS ; vérifier lecture après démarrage/redémarrage, absence de valeur en clair dans Git/logs, refus d'accès croisé, validation manager, CI échouée et démarrage AWS sans GCP.

Le choix d'hébergement et de données existant détermine automatiquement le ou les domaines OpenBao. L'utilisateur n'a aucun choix « serveur OpenBao » supplémentaire à faire. Le mode GCP PostgreSQL en production conserve son secours AWS obligatoire ; GCP SQLite et GCP PostgreSQL en dev n'activent pas ce secours.

Le pipeline CI continue à construire et publier l'image immuable. Les variables sont des **données d'exécution** prises en charge lors de la publication du déploiement après succès CI. Aucune modification du workflow de build n'est prévue par ces trois SPEC ; si un essai démontre qu'un workflow réécrit le manifeste de runtime ou supprime ses références, corriger cette seule interaction et ajouter un test ciblé. Les variables nécessaires à la construction de l'image restent hors de ce périmètre.

Les comptes cloud, projets, régions, zones, identifiants OpenBao et ARN ne doivent pas être figés dans le code. Les paramètres d'identité, réseau et destination qui relèvent de l'infrastructure sont déclarés par environnement, de préférence via Terraform quand un changement est nécessaire. Aucune valeur secrète n'est fournie dans Git ni dans un plan Terraform.

## Séquence de vérification

1. Vérifier les prérequis de SPEC-OPENBAO-00 ; les tests locaux et les tests directs du serveur Azure sont déjà disponibles. On peut encore préparer et contrôler les identités/coffres, les paramètres du pod et une restauration isolée **avant** le déploiement du portail.
2. Déployer le portail et une application témoin pour le test Azure de bout en bout, puis réaliser les recettes GCP et GCP avec secours AWS selon leur état réel. Vérifier la valeur lue après démarrage et redémarrage sans l'afficher.
3. Tester refus d'accès croisé, absence d'OpenBao, échec de livraison, reprise et suppression sans régression des déploiements sans variables.
4. Terminer par le formulaire et le scénario utilisateur complet décrit dans SPEC-OPENBAO-03.
