# Déploiements avec variables OpenBao — état vérifié le 20 novembre 2026

Ce document décrit la **production** `portal.apps.mooroon5.fr`, révision
`77d3985f8ba43bcda51b68aaa39547288c22c046`. Il complète le
[runbook du portail](../Cloud/RUNBOOK-CNP-PORTAL-GCP.md). Un test de connexion
OpenBao depuis le pod ne vaut pas recette d'une application déployée.

## Pourquoi la demande est refusée avant déploiement

Dans `src/routes/deployments.js`, si le formulaire contient au moins une
variable, `openbaoRuntime.assertReady()` est appelé **avant** la création de
l'enregistrement de déploiement. `src/services/openbao-runtime.js` exige alors
une identité runtime distincte pour `application/environnement`. En production,
`CNP_OPENBAO_DERIVED_IDENTITIES` est désactivé et les tables
`CNP_GCP_RUNTIME_IDENTITIES`, `CNP_AZURE_RUNTIME_IDENTITIES` et
`CNP_AWS_RUNTIME_EXECUTION_ROLES` ne contiennent pas ces applications. Le
formulaire renvoie donc « Compte GCP runtime dédié ... manquant » ou
« Identité Azure dédiée ... manquante ». Un déploiement **sans variable** ne
passe pas par ce contrôle. L'erreur ne vient ni du `.env` local ni d'une panne
des instances OpenBao.

Activer `CNP_OPENBAO_DERIVED_IDENTITIES=true` calcule seulement un nom
déterministe ; cela ne crée ni compte, ni coffre, ni rôle, ni droits. Ne pas
l'activer avant la présence vérifiée des ressources correspondantes.

| Mode avec variables | Vérifié dans le pod | Manque avant une recette applicative |
| --- | --- | --- |
| GCP SQLite dev/prod et PostgreSQL dev | JWT OpenBao GCP ; portail fonctionnel | Compte de service dédié par `app/env`, droit `actAs` pour Crossplane, droits Cloud SQL si nécessaires et accès aux seuls secrets de l'application ; publication de la référence Cloud Run ; essai réel. |
| GCP PostgreSQL prod avec secours AWS | JWT OpenBao GCP et AWS, KV v2 fictif sur AWS ; adresse et compte AWS configurés | Tout le prérequis GCP, rôle d'exécution ECS dédié, identité AWS effective du portail avec droits Secrets Manager sur le compte `626278345026`, livraison réelle et lecture AWS pendant panne GCP. |
| Azure PostgreSQL dev/prod | JWT OpenBao Azure ; échange du jeton projeté du pod contre un jeton Entra ; ConfigMaps non secrètes chargées | Identité managée et Key Vault dédiés par `app/env`, rôles Secrets Officer/User réellement appliqués, puis essai Container Apps. |
| Privé k3s dev/prod | JWT OpenBao privé, KV v2 fictif et prévalidation `assertReady()` | Essai réel d'une application, de son `ExternalSecret`, des références `secretKeyRef` et du redémarrage. Aucun rôle AWS de secours n'est prévu pour ce mode. |

Le pod actuel a passé `/api/health` : GitHub, Argo CD, Datadog, Kubernetes et
Crossplane `ok`. Argo CD était `Synced/Healthy`. Ce contrôle ne couvre pas les
permissions des applications, Secrets Manager ni le cluster k3s.

## Ce que prépare déjà l'infrastructure

`cnp/cluster/gcp/14-openbao-runtime-identities.tf` crée un compte GCP par
entrée de `openbao_runtime_environments`. L'équivalent Azure crée une identité,
un coffre et deux rôles par entrée. `cnp/cluster/aws/18-openbao-runtime-identities.tf`
crée un rôle ECS par application de `openbao_failover_apps`. **Les trois listes
sont vides par défaut** ; les fichiers Terraform sont des modèles génériques,
pas un mécanisme de provisionnement automatique. L'identité fédérée **du
portail** Azure, distincte des identités applicatives, a été appliquée et testée.
Le compte AWS local disponible appartient à `501433493734` ; il ne permet pas
d'administrer ni de vérifier le compte de secours `626278345026`.

## Choix de correction et délai

| Choix | Ce qu'il donne | Limite |
| --- | --- | --- |
| A. Ajouter des `app/env` nommés dans Terraform, appliquer, publier les sorties et tester | Débloque rapidement **ces** applications si les accès cloud sont disponibles | Chaque nouvelle application exige une intervention ; ne satisfait pas le besoin de déployer des applications inconnues à l'avance. |
| B. Provisionner l'identité et ses droits au moment de l'approbation d'un nouveau déploiement, puis vérifier leur existence avant la publication | Fonctionnement général et reproductible, avec isolation par application | Demande un contrôleur ou une étape GitOps/Terraform suivie, ses permissions limitées sur GCP/Azure/AWS, une reprise idempotente et des tests de refus d'accès croisé. Ce mécanisme n'existe pas encore. |

**Décision recommandée : B.** Conserver le refus avant déploiement tant que
l'identité n'est pas prête ; déplacer le contrôle après une phase de
provisionnement suivie, sans donner au compte partagé l'accès aux secrets de
toutes les applications. Le mécanisme doit créer ou retrouver la ressource
déterministe, vérifier ses rôles, attendre leur propagation, enregistrer son
identifiant puis seulement publier les variables et le déploiement. Une reprise
après panne doit éviter les ressources orphelines et les doubles droits.

En une heure, avec les accès actuels, on peut vérifier les chemins GCP/Azure,
faire une recette privée si le cluster et l'application témoin sont accessibles,
et préparer le changement général. On ne peut **pas prouver 100 % des modes en
production** : le compte AWS de secours est inaccessible et le provisionnement
automatique intercloud n'est pas implémenté. Ajouter seulement
`CNP_OPENBAO_DERIVED_IDENTITIES=true` ne raccourcirait pas ce travail.

## Reproduction et critères de fin

1. Partir des branches `cnp-portal/main`, `cnp/cluster` et `config-repo/main`,
   noter leurs SHA et vérifier `kubectl -n argocd get application cnp-portal`.
2. Pour chaque nouveau `app/env`, exécuter le provisionnement idempotent ;
   contrôler **dans le cloud cible** l'identité, les permissions bornées et,
   pour Azure, le coffre. Vérifier l'identité AWS dans le bon compte.
3. Créer via le portail une application témoin avec une variable fictive pour
   chaque mode. Vérifier la valeur dans le conteneur, sans l'imprimer dans les
   logs ; tester redémarrage, rotation, suppression et refus d'accès entre
   applications et entre `dev`/`prod`.
4. En GCP PostgreSQL prod, provoquer une indisponibilité GCP contrôlée et
   démontrer que l'application de secours lit la valeur depuis Secrets Manager
   dans `626278345026`.
5. Garder les preuves (révisions Git, plans sans destruction inattendue,
   identifiants de ressources non secrets, état Argo, résultats de tests) dans
   le journal de promotion. Le portail et ses services annexes peuvent être
   sains alors qu'un mode de déploiement reste bloqué.

Ne pas copier des clés AWS de Crossplane dans le pod du portail, ni des valeurs
applicatives dans Git, Terraform state, les manifests ou les journaux.
