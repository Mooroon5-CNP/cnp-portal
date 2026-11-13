# Déploiements dev et prod

Le formulaire enregistre un environnement par déploiement. Le même nom
d'application et le même dépôt peuvent avoir un déploiement dev et un prod.

| Choix | Branche source | Publication GitOps | Ressource Cloud Run |
|---|---|---|---|
| dev | main | Automatique après réussite du CI | `<application>-dev` |
| prod | prod | PR candidate, puis validation d'un manager dans le portail | `<application>-prod` |

Les chemins GitOps sont `apps/<application>/crossplane/dev/` et `prod/`.
Le nom de l'image reste `<registry>/<application>:<SHA>` : aucun suffixe `.dev`
n'est nécessaire. Les services, paramètres `DD_ENV`, URL et buckets de données
sont distincts. Les anciens enregistrements restent marqués `legacy` et gardent
leur nom de service et leur comportement historiques.

## Parcours

1. Le portail vérifie l'environnement, le dépôt, les droits d'accès et
   l'AppProject Argo CD nécessaire.
2. Il configure les credentials CI, installe le caller
   `.github/workflows/cnp-<application>.yml` sur main et prod, et déclenche le
   pipeline de la branche choisie. Un ancien `ci.yml` généré par CNP pour cette
   même application est remplacé afin d'éviter deux builds du même tag ; les
   workflows personnalisés sont conservés.
3. Le pipeline construit et scanne l'image. Son nouveau mode `gitops_mode: portal`
   laisse toutes les vérifications actives et désactive ses anciens jobs de
   publication GitOps.
4. Le réconciliateur persistant du portail vérifie le résultat du workflow et
   sa révision source. Il publie dev en un commit atomique, ou prépare prod sur
   une branche candidate et ouvre sa PR via la GitHub App.
5. Un manager approuve ou refuse le candidat dans le portail. L'approbation
   vérifie de nouveau le CI, la branche et le head de la PR avant le merge App.
   Une nouvelle révision source invalide un candidat plus ancien.
6. L'interface attend la disponibilité observée dans Crossplane/Cloud Run pour
   afficher le succès et l'URL ; un CI vert ne suffit pas.

Les décisions et leases de traitement sont enregistrées dans SQLite. Le worker
reprend au redémarrage. La suppression ne retire que l'environnement choisi ;
elle conserve les credentials et le workflow partagés avec l'autre environnement.

## Prérequis et ordre de livraison

1. Fusionner le changement compagnon dans `ci-templates` qui déclare
   `gitops_mode`. Son défaut `pipeline` préserve les callers existants.
2. Préparer les AppProjects `team-cnp-dev` et `team-cnp-prod` depuis les fichiers
   canoniques de config-repo. Le script suivant vérifie d'abord les deux manifests
   avec un kubeconfig temporaire ; ajouter `--apply` pour les appliquer :

   ```bash
   bash scripts/cloud/bootstrap-environment-projects.sh \
     --project cnp-terraform-512313 \
     --cluster cnp-cluster-terraform \
     --location europe-west9-b \
     --config-repo /chemin/vers/config-repo
   ```

   Ce bootstrap n'active aucun ApplicationSet global : des manifests historiques
   de prod existent déjà et ne doivent pas être déployés par accident. Le portail
   doit rester limité aux chemins des nouveaux environnements qu'il gère.
3. Déployer le portail avec sa GitHub App autorisée sur les dépôts applicatifs
   et config-repo : Contents/Workflows, Actions/Secrets/Variables et Pull requests
   selon les opérations correspondantes. Le PAT CI reste injecté dans les apps,
   mais les publications GitOps de ce nouveau mode utilisent l'App.
4. Héberger le portail et sa base SQLite durablement. Son réconciliateur doit
   disposer de CPU en continu. Avec Cloud Run, le mode CPU alloué uniquement
   pendant les requêtes et une instance pouvant tomber à zéro ne garantissent
   pas la publication automatique après fermeture du navigateur. Prévoir un
   processus toujours actif ou une exécution planifiée adaptée avant activation.
5. Tester une application dev neuve, puis un candidat prod et son refus/
   approbation. Une production ne doit pas être fusionnée directement par un
   humain sur GitHub : le workflow de protection attend l'identité de l'App.

Pour tester le couple de branches avant fusion, `CNP_CI_TEMPLATES_REF` peut
désigner la branche du changement compagnon. Après sa fusion, laisser ce
paramètre absent pour utiliser main. Ne pas publier de production pour tester
simplement le formulaire ou la présence des boutons.

## Compatibilité et limites

Les ApplicationSets dev/prod gardent leurs noms et AppProjects canoniques, mais
leur liste de répertoires est limitée aux environnements explicitement enregistrés
et validés par le portail. Ne pas appliquer ensuite les modèles à wildcard de
config-repo : cela étendrait leur périmètre aux anciens manifests non adoptés.
Ils doivent rester les seuls propriétaires des ressources correspondantes.
Le scanner historique des racines plates est
préservé ; une racine sans ressource peut être créée pour une application neuve
afin de ne pas lui donner un chemin Kustomize invalide. Une ancienne racine réelle
n'est jamais remplacée par une racine vide. Une application historique déjà
présente mais dont la racine a disparu nécessite une récupération explicite.
Un chemin d'environnement déjà existant ne peut pas être adopté implicitement.
Si le setup échoue avant l'enregistrement de propriété, supprimer sa ligne dans
le portail ne supprime aucune de ces ressources historiques.

Le workflow `protect-prod-paths` de config-repo est un contrôle après écriture,
pas une protection native Git avant écriture. Voir les PR connexes dans
[l'audit](DEV_PROD_PR_AUDIT.md). Ce changement ne fusionne pas les PR
d'observabilité ni la migration générale des anciens appels PAT vers l'App.

Les vérifications de ce changement séparent les tests locaux avec services
externes simulés et la lecture d'un service GCP existant. Une lecture réussie de
l'ancien service ne prouve pas un nouveau déploiement dev/prod en production.

## Vérifications du 25 octobre 2026

- Suite complète du portail : 9 suites, 77 tests réussis ; ESLint et vérification
  des espaces du diff réussis.
- Compagnon [ci-templates #9](https://github.com/Mooroon5-CNP/ci-templates/pull/9) :
  6 tests de contrat, dont la matrice de 729 cas du mode portal/invalide ; lint
  YAML et actionlint réussis.
- Navigateur Chromium sur un serveur de test isolé, base en mémoire et services
  externes simulés : choix prod, présence du bouton d'approbation pour manager,
  absence pour développeur, aucune erreur JavaScript de page.
  [Formulaire](evidence/environment-selector.png),
  [validation production](evidence/production-approval.png).
- Lecture du service GCP existant `app4-pixelcam` : Ready, image attendue,
  page d'accueil Pixel Calm et `/ready` en HTTP 200. `/healthz` renvoie un 404
  Google non expliqué ; ce chemin n'est pas déclaré validé.
- Les AppProjects dédiés et les scanners dev/prod canoniques ne sont pas encore
  actifs sur le cluster observé. Aucun nouveau déploiement prod, bootstrap live
  ou merge de ces branches n'a été effectué pendant la vérification.
