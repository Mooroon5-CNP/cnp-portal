# Variables d'environnement avec OpenBao — ordre de réalisation

> **État de production au 20 novembre 2026 :** le portail est déployé sur GKE,
> révision `77d3985f8ba43bcda51b68aaa39547288c22c046`. Les connexions JWT
> aux quatre instances OpenBao ont été vérifiées depuis le pod. Les modes GCP
> et Azure **avec variables** restent bloqués avant création du déploiement
> faute d'identités applicatives ; le privé passe la prévalidation mais attend
> une recette applicative ; le secours AWS attend en plus les droits du compte
> `626278345026`. Voir l'[état vérifié et le choix de correction](ETAT-DEPLOIEMENT-20261120.md)
> et le [runbook de production](../Cloud/RUNBOOK-CNP-PORTAL-GCP.md).

Le déploiement Kubernetes du portail et son raccordement à l'instance GCP sont
documentés dans [spec_How_to-deploy_cnp-portal.md](spec_How_to-deploy_cnp-portal.md).

Ces spécifications ont été rédigées sur `feat/OpenBao-Vault` puis intégrées à `main` ; l'infrastructure suivie est `cnp/cluster`. Elles décrivent les variables **des applications déployées**, pas la migration de la base SQLite du portail. Les paragraphes ci-dessous conservent l'ordre de réalisation initial ; le document d'état lié plus haut fait foi pour la production actuelle.

La [liste opérationnelle des prérequis des instances](instances_openBao.md) précise ce qui est déjà préparé et ce qui reste à installer sur chaque cloud.
Pour Azure, l'identité **du portail** et sa fédération ont été appliquées et vérifiées. Les identités et coffres **des applications** prévus dans `cnp/azure/14-openbao-runtime-identities.tf` ne sont pas appliqués. La recette de restauration isolée (`cnp/azure/openbao-server/RESTORE-TEST.md`) reste distincte.

| Ordre | Spécification | Code sur `feat/OpenBao-Vault` | Acceptation complète |
| --- | --- | --- | --- |
| 0, plateforme | [SPEC-OPENBAO-00](SPEC-OPENBAO-00-instances-et-prerequis.md) | Portail GKE déployé ; JWT GCP, Azure, AWS et privé vérifiés depuis le pod ; identité fédérée Azure du portail appliquée. | **À faire** : identités/coffres runtime, recettes applicatives et restauration isolée Azure. |
| 1 | [SPEC-OPENBAO-01](SPEC-OPENBAO-01-contrat-et-routage.md) | Client KV v2, CAS, routage et générations implémentés et testés avec faux services. | **À faire** : vérifier les politiques JWT, l'isolation et la panne sur les instances réelles. |
| 2 | [SPEC-OPENBAO-02](SPEC-OPENBAO-02-livraison-deploiements.md) | Livraison, modification, retour arrière et nettoyage après suppression codés pour GCP, Azure et secours AWS ; références versionnées dans les manifests. L'état observé est comparé aux versions attendues pour les trois chemins. | **À faire** : identités et droits cloud, vérification réelle du cycle de vie et recettes. |
| 3, **en dernier** | [SPEC-OPENBAO-03](SPEC-OPENBAO-03-formulaire-variables.md) | Saisie manuelle, import `.env`, validation serveur et préflight implémentés. | **À faire** : démonstration d'un déploiement réel dans chaque mode et contrôle après redémarrage. |

**Aucune de ces SPEC n'est marquée `DONE` au sens de ses critères d'acceptation.** Les connexions OpenBao depuis le portail sont réelles ; le parcours portail → application avec variables n'a pas été prouvé. Le détail actuel est dans [ETAT-DEPLOIEMENT-20261120.md](ETAT-DEPLOIEMENT-20261120.md).

## Reste à faire pour que tout fonctionne

1. **Terminer Azure :** le serveur, le JWT du pod et la fédération du portail fonctionnent. Provisionner automatiquement les identités/coffres d'application et leurs droits, puis tester la livraison à Container Apps.
2. **Terminer GCP et AWS :** les ressources Terraform pour les identités runtime GCP et les rôles ECS AWS sont déclarées mais les listes sont vides par défaut. Mettre en place la création à la demande, vérifier le compte AWS de secours `626278345026`, puis réaliser les recettes. La création des identités depuis le formulaire n'est pas automatisée.
3. **Vérifier le contrat des providers et les comptes :** le schéma Crossplane Container Apps installé accepte les champs de référence Key Vault et d'identité ; vérifier leur comportement lors d'un déploiement réel ainsi que le montage du jeton fédéré Azure. Contrôler aussi Cloud Run et les paramètres AWS avant les recettes de ces domaines.
4. **Vérifier le cycle de vie des variables :** la modification et le retrait sans nouvelle image CI, le retour arrière et le nettoyage après disparition des ressources sont codés ; vérifier ces parcours sur les clouds réels. Une réponse OpenBao perdue après écriture est récupérée par relecture si la génération est encore observable ; si cette relecture échoue également, une version inconnue peut rester à inventorier.
5. **Faire la recette réelle :** application fictive avec une valeur manuelle et une importée depuis `.env` en GCP SQLite, GCP PostgreSQL dev, Azure et GCP PostgreSQL prod avec AWS ; vérifier lecture après démarrage/redémarrage, absence de valeur en clair dans Git/logs, refus d'accès croisé, validation manager, CI échouée et démarrage AWS sans GCP.

Le choix d'hébergement et de données existant détermine automatiquement le ou les domaines OpenBao. L'utilisateur n'a aucun choix « serveur OpenBao » supplémentaire à faire. Le mode GCP PostgreSQL en production conserve son secours AWS obligatoire ; GCP SQLite et GCP PostgreSQL en dev n'activent pas ce secours.

Le pipeline CI continue à construire et publier l'image immuable. Les variables sont des **données d'exécution** prises en charge lors de la publication du déploiement après succès CI. Aucune modification du workflow de build n'est prévue par ces trois SPEC ; si un essai démontre qu'un workflow réécrit le manifeste de runtime ou supprime ses références, corriger cette seule interaction et ajouter un test ciblé. Les variables nécessaires à la construction de l'image restent hors de ce périmètre.

Les comptes cloud, projets, régions, zones, identifiants OpenBao et ARN ne doivent pas être figés dans le code. Les paramètres d'identité, réseau et destination qui relèvent de l'infrastructure sont déclarés par environnement, de préférence via Terraform quand un changement est nécessaire. Aucune valeur secrète n'est fournie dans Git ni dans un plan Terraform.

## Séquence de vérification

1. Vérifier les prérequis de SPEC-OPENBAO-00 et la révision du portail déjà déployé. Préparer et contrôler les identités/coffres applicatifs et une restauration Azure isolée avant de publier des variables.
2. Déployer une application témoin pour le test Azure de bout en bout, puis réaliser les recettes GCP, privé et GCP avec secours AWS selon leur état réel. Vérifier la valeur lue après démarrage et redémarrage sans l'afficher.
3. Tester refus d'accès croisé, absence d'OpenBao, échec de livraison, reprise et suppression sans régression des déploiements sans variables.
4. Terminer par le formulaire et le scénario utilisateur complet décrit dans SPEC-OPENBAO-03.
