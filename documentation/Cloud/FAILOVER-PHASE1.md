# Profil failover Pixelcalm — phase 1

Le profil est isolé dans `src/services/environment-failover.js`, sur le modèle
de `environment-azure.js`. Les seuls branchements dans le service partagé
concernent le rendu, l'état de disponibilité et l'interdiction de suppression
du profil. Aucun comportement Azure ou des autres applications n'est changé.
Coordonner tout changement de ces branchements avec Maia ; son travail Azure
de `f1c78d1` est conservé.

## Préparation locale et configuration

Node 22.22.2 est requis pour l'installation locale actuelle. Conserver la base
SQLite et les fichiers de configuration existants. Le démarrage existant via
`start-portal.sh` est compatible avec les symlinks du runtime privé.

Le profil est opt-in : un fichier défini par `CNP_FAILOVER_SETTINGS`, ou par
défaut `../phase1-deployment-20261029/portal-settings.json` à côté du dépôt,
référence les documents locaux sans mots de passe :

```json
{
  "app": "app4-pixelcam",
  "profile": "/chemin/profile.json",
  "credentials": "/chemin/credentials-outputs.json",
  "secrets": "/chemin/secret-result.json",
  "observations": "/chemin/observations.json"
}
```

`credentials` contient les références Terraform, `secrets` le résultat expurgé
d'initialisation (dont la version GCP), jamais les valeurs des secrets. Les
observations contiennent les ressources Crossplane Ready/Synced et leurs CA
publiques. Le profil conserve `ENCRYPTED_ONLY` côté Cloud SQL ; le choix explicite
`wireguard-tls` ne concerne que le subscriber natif RDS.

Le rendu utilise Python 3 (surcharge possible `CNP_FAILOVER_PYTHON`) et réutilise
les générateurs versionnés du dépôt frère `config-repo/scripts`. Le pont
`scripts/failover/render.py` est sans réseau et ne lit aucun secret cloud. Il
reçoit uniquement des documents JSON par stdin. Conserver les deux dépôts à
côté l'un de l'autre ; ce profil opérateur local n'est pas une image de portail
autonome à déployer dans un autre environnement sans ces dépendances.

## Circuit prod

Le manager utilise `http://localhost:3001/failover` :

1. Préparer `databases`. Le portail lit la baseline distante exacte, conserve
   toutes les ressources existantes et génère Cloud SQL/RDS. Il crée une branche
   dédiée et une PR avec la GitHub App `cnp-platform-bot[bot]`, jamais un push
   direct sur main.
2. Examiner les fichiers affichés et la PR, puis approuver le SHA exact dans
   le portail. L'identité du manager est enregistrée dans la base. Un profil,
   un SHA ou une baseline modifiés invalident la revue. Une seule proposition
   peut être en attente ; aucune préparation ne fusionne automatiquement.
3. Attendre les bases Ready/Synced et vérifier le bootstrap, la réplication
   initiale et les nouvelles écritures avec les outils de recette existants.
4. Compléter le profil avec les endpoints, CA et références réellement observés,
   puis préparer et approuver `runtime` et ensuite `dns`.

Les étapes publiées sont enregistrées dans `failover_candidates` de la base
existante. Un déploiement CI ordinaire conserve les manifests du profil approuvé
plutôt que de remettre le mode bucket. Une nouvelle image ou un changement de
profil nécessitent une nouvelle revue runtime. Les appels du service et les
routes vérifient le rôle manager ; les POST exigent le jeton de session.

Le bucket, ses objets, les volumes et variables existants restent conservés.
Les nouveaux objets cloud portent `deletionPolicy: Orphan`. Ce lot ne migre
pas les anciennes données vers PostgreSQL et ne réalise aucun failback.

## Limites de validation

Une PR fusionnée n'est pas un état opérationnel : le parcours de disponibilité
reste explicite et n'annonce pas « déployée » sans recette complète. Les plans
réseau attendent deux relectures humaines avant application. Le worker doit
observer une réplication saine avant activation de ses déclencheurs.
Les tests de panne sont réalisés par Thomas ; le portail ne coupe jamais GCP
ou WireGuard pour valider cette phase.

## Généralisation locale — 3 novembre 2026

Le code ne sélectionne plus le pilote par son nom : les profils sont enregistrés
par application dans `failover_profiles`. Le fichier historique reste une source
compatible pour le pilote existant. Les candidats portent `app_name` ; la migration
rattache l'ancien historique à ses chemins GitOps réellement publiés. Préparations,
prérequis, manifests et revue sont isolés par application. Le SHA exact et la
baseline distante restent vérifiés avant tout merge.

Dans **Déploiements → Nouveau déploiement**, l'option **Activer le failover GCP →
AWS** demande une production GCP sans SQLite sur bucket. La CI utilise alors le
circuit existant `target_cloud: both`, en mode portail : la publication reste
soumise au manager. Une demande sans profil reste en attente ; elle ne publie pas
silencieusement un runtime GCP seul.

Le manager accède à **Failover** dans le menu. Il configure le document
`{profile, credentials, secrets, observations}` de l'application puis prépare
les lots. Les références de secrets doivent appartenir à l'application. Les noms
de secrets SQL et priorités ALB doivent être distincts des autres profils.
Les identités, contrats et bases d'un profil publié ne sont pas modifiables par ce
formulaire ; seules les évolutions compatibles passent par la revue suivante.

Deux parcours supplémentaires sont disponibles :

- `application_profile: postgres` : schéma déclaratif dans `sql_contract`, avec
  plusieurs tables du schéma public, une clé primaire simple par table et
  séquences identity positives. Aucun SQL libre, aucune migration automatique.
  Le bootstrap valide le schéma existant et le worker aligne les séquences à la
  promotion. Les applications doivent utiliser le rôle exclusif `cnp_runtime`,
  les variables DB injectées et les CA vérifiées. Fournir une sonde de vie AWS
  indépendante de la disponibilité SQL, par exemple `/healthz`.
- `mode: stateless` et `application_profile: stateless` : pas de base, secret SQL,
  réplication ou worker SQL. Les lots sont `runtime` puis `dns` ; Route53 utilise
  directement la sonde HTTPS primaire. Ce mode ne couvre pas des fichiers
  persistants, sessions locales ou services externes non répliqués.

Exemples : `config-repo/docs/templates/failover-phase1/{postgres,stateless}/`.
Les paramètres réseau partagés sont réutilisés ; aucune VM ou configuration
WireGuard n'est créée ou modifiée par les générateurs.

Pour une production déjà présente, **Rattacher la production existante au
portail** lit le registre, les ressources et l'Application Argo. Le manager
confirme la révision examinée. L'action écrit seulement le rattachement local,
conserve le propriétaire GitOps et ne crée pas de fausse exécution CI. Une
Application en suppression ou une baseline différente bloque l'opération.

Les paquets `secrets`, `bootstrap`, `automation` sont téléchargeables pour le
circuit opérateur existant. Le paquet automation rassemble tous les profils SQL
connus afin de ne pas omettre une application du worker partagé. La proposition
conserve `enable_triggers=false` ; garder les varfiles bootstrap/activation déjà
appliqués et faire contrôler le plan par `safe_apply.py`. Un paquet téléchargé
n'est ni un apply ni une preuve de disponibilité.

**État de livraison : développements locaux testés, pas encore déployés dans
l'image cloud du portail ou du worker.** Le formulaire manager reste un formulaire
de profil opérateur ; le provisionnement des secrets, l'exécution distante du
bootstrap et l'activation Terraform ne sont pas encore un parcours automatique
complet dans le portail. Le changement ne suffit donc pas à déclarer la phase 1
self-service entièrement terminée. La CI normale conserve les manifests approuvés ;
une nouvelle image doit encore être renseignée dans une revue runtime.

## Raccordement CI — 4 novembre 2026

Le workflow réutilisable exporte désormais `image_digest`. Le caller failover
produit une preuve `cnp-images.json` uniquement après succès du pipeline prod.
Le portail vérifie l'application, les deux registres, la révision courante,
l'unicité et la validité de l'artefact. Le candidat runtime utilise ces images
par digest ; l'approbation les revalide et conserve leur provenance en base.
Une nouvelle CI de production attend une nouvelle revue runtime au lieu de
réutiliser silencieusement l'ancienne version.

L'action manager « Configurer la CI sur les deux clouds » configure le workflow
CNP de l'application. Les changements de `ci-templates` et du portail doivent
être publiés ensemble avant d'utiliser cette action sur un dépôt réel. Ils sont
encore locaux. Le provisionnement des secrets, l'exécution du bootstrap et
l'activation du worker restent à raccorder au portail ; les paquets existants
restent disponibles, sans exécution automatique ajoutée par ce lot.
