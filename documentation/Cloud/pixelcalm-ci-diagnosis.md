# Diagnostic CI/CD Pixelcalm — 22 octobre 2026

## Échec observé

Le run [39797279209](https://github.com/Mooroon5-CNP/app4-pixelcalm/actions/runs/39797279209)
échoue sur `pipeline / scan-deps`, étape `Scan deps — CRITICAL (blocking)`.
Le rapport fourni identifie `proxy-addr@2.0.7`, CVE-2026-90711, corrigée en 2.0.8.
Les jobs build, scan-image et promotion sont ensuite ignorés. Le tag initial
`:placeholder` reste donc dans la configuration GitOps.

Le message Docker « Unable to find image aquasec/trivy:latest locally » précède
un téléchargement réussi ; il n'est pas la cause de l'échec.

## Correction locale vérifiée

Dans `apps/app4-pixelcalm/package-lock.json`, seule l'entrée de `proxy-addr`
est actualisée vers 2.0.8, avec son URL, son intégrité npm et ses métadonnées.
La contrainte Express `~2.0.7` autorise cette version ; aucun override nécessaire.

Vérifications dans une copie isolée de `origin/main` :

- Trivy `fs --scanners vuln --severity CRITICAL --ignore-unfixed --exit-code 1` :
  0 vulnérabilité critique, code de sortie 0.
- Installation `npm ci` sous Node 20 Alpine : réussie.
- Tests existants : 8/8 réussis.
- ESLint : réussi.
- `git diff --check` sur le dépôt applicatif : réussi.

La correction est appliquée au checkout local de l'application. Aucun commit,
push ou nouveau déploiement effectué. Le scan de l'image Docker finale reste à
valider dans le prochain pipeline ; les runs précédents ont aussi rencontré des
échecs de scan-image.

## Nom de l'application

Le registry GitOps contient deux applications : `app4-pixelcam` et
`app4-pixelcalm`, toutes deux associées au dépôt source `app4-pixelcalm`.
Le workflow actuel de ce dépôt utilise `app_name: app4-pixelcalm`.
Il construit et promeut donc cette image et ce chemin GitOps uniquement.
Il ne peut pas corriger le claim `app4-pixelcam` mentionné dans l'erreur initiale.
Les deux claims sont encore à `:placeholder` dans `config-repo/origin/main`
au moment du diagnostic.

## Branches et séparation dev/prod

Branches distantes rafraîchies dans cnp-portal, ci-templates, config-repo et
l'application. Aucun correctif complet de ce problème n'a été trouvé.

- Les branches du portail qui contiennent le module d'onboarding génèrent un
  workflow déclenché uniquement sur `main`. La branche `origin/dev` change
  surtout le port Cloud Run, sans corriger ce contrat. La branche `origin/prod`
  ne contient pas le module d'onboarding.
- Le workflow applicatif de `origin/prod` écoute lui aussi uniquement `main`
  et son job Cloud Run contient encore l'ancien ID de projet.
- `ci-templates/origin/main`, `origin/feat/cnp-027-language-aware-templates`,
  `origin/feat/cnp-037-dd-version` et `origin/feat/ecr-multi-registry` ont des jobs
  dev et prod, mais tous deux écrivent le même
  `apps/${APP_NAME}/crossplane/cloudrun-claim.yaml`.
- Les overlays Kubernetes dev/prod sont distincts, mais l'onboarding GCP utilise
  Cloud Run via ce claim unique. Il ne fournit donc pas deux services Cloud Run
  indépendants.

L'absence d'un suffixe `.dev` dans le nom de l'image n'est pas la cause démontrée.
Le pipeline publie `${REGISTRY_URL}/${APP_NAME}:${github.sha}`. Dev et prod
peuvent référencer ce même nom d'image avec une sélection explicite du tag.
Il faut des services/configurations de déploiement distincts pour leur isolation.

Avant d'activer le workflow sur `prod`, séparer les claims/services Cloud Run et
leurs chemins de promotion ; sinon dev et prod modifient le même service.

Les modifications locales préexistantes du pipeline ci-templates et les
applications/données cloud n'ont pas été modifiées pendant ce diagnostic.
