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
