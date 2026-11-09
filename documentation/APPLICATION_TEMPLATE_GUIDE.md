# Commencer à coder avec les templates CNP

Ce guide concerne les repos créés depuis **Créer un repo** dans le CNP Portal.
Les deux templates actuels utilisent **Python et Flask** : l’un avec SQLite,
l’autre avec PostgreSQL. La création du repo ne crée ni base distante, ni
ressource cloud, ni déploiement.

Après création, cliquez sur **Voir le repo sur GitHub** pour retrouver son URL.
Ce bouton et ce guide sont aussi accessibles dans la page de détail du déploiement.

## 1. Récupérer le code et créer une branche

Copiez l’URL de votre repo depuis GitHub. Remplacez `organisation` et `mon-app`
dans les commandes suivantes par les valeurs de votre repo :

```bash
git clone https://github.com/organisation/mon-app.git
cd mon-app
git switch -c feat/ma-premiere-fonctionnalite
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install pytest flake8
```

Sous Windows, activez l’environnement avec `.venv\Scripts\Activate.ps1` dans
PowerShell. Python 3.12 est la version utilisée par le Dockerfile des templates.

Le repo est **public**. Ne commitez jamais de mot de passe, token, clé privée,
fichier `.env` ou données réelles d’utilisateurs.

## 2. Structure commune des templates

```text
mon-app/
├── app.py             # Application Flask, routes HTTP et exemple de persistance
├── test_app.py        # Tests de départ à compléter avec vos fonctionnalités
├── requirements.txt   # Dépendances Python de l’application
├── Dockerfile         # Construction et lancement du conteneur
├── README.md          # Instructions propres au modèle choisi
├── .flake8            # Configuration du lint Python
├── .gitignore         # Exclut notamment .env, .venv et les fichiers *.db
└── .dockerignore      # Évite de copier des fichiers locaux dans l’image
```

Les branches `main` et `prod` sont créées avec le code de départ. Le workflow de
déploiement n’est pas ajouté lors de la création du repo : il est configuré
plus tard par le parcours de déploiement existant.

Vous pouvez organiser votre code en plusieurs modules ou dossiers. Si vous
déplacez `app.py`, adaptez les imports, les tests et le lancement dans le Dockerfile.

## 3. Lancer le template SQLite

SQLite conserve les données dans un fichier. Pour coder en local :

```bash
export SQLITE_PATH=./app.db
python app.py
```

Ouvrez `http://localhost:8080`, ou le port choisi à la création. La route `/`
enregistre une visite et renvoie le compteur ; `/healthz` vérifie le processus web.
Ces routes sont un exemple de départ, à remplacer ou compléter pour votre métier.

Dans le conteneur, le chemin par défaut est `/data/app.db`. Pour un déploiement
persistant, choisissez l’option **GCP SQLite avec stockage persistant** du portail.
Ne déplacez pas la base hors du stockage persistant sans adapter la configuration
avec l’équipe plateforme. Ne faites pas partager ce fichier entre plusieurs
instances ; demandez conseil avant de modifier le nombre d’instances.

## 4. Lancer le template PostgreSQL

PostgreSQL utilise un serveur séparé. Préparez une base de développement locale
ou dédiée, puis configurez ces variables dans votre terminal avec ses identifiants :

```text
DB_HOST     adresse du serveur (ou chemin du socket fourni par la plateforme)
DB_PORT     port PostgreSQL, 5432 par défaut
DB_NAME     nom de la base
DB_USER     utilisateur de la base
DB_PASSWORD mot de passe, à garder hors du code et du repo
```

Lancez ensuite `python app.py`. La route `/` crée une table de démonstration
`visits` si nécessaire, puis enregistre une visite. Pour votre application réelle,
remplacez cet exemple et gérez l’évolution du schéma par des migrations revues.
N’utilisez pas les identifiants ou les données de production pour vos essais.

Au déploiement, choisissez **GCP Cloud SQL** ou **Azure PostgreSQL**. La plateforme
fournit les variables `DB_*` : conservez ces noms et ne remplacez pas leurs valeurs
par des identifiants codés en dur. Le secours PostgreSQL GCP en production se
configure dans le parcours de déploiement, pas dans le template.

## 5. Ce que vous pouvez modifier et ce qu’il faut préserver

| Élément | Consigne pour le développeur |
|---|---|
| Code applicatif, routes métier, pages et nouveaux modules | Vous pouvez les modifier, les ajouter et les réorganiser. |
| Tests et README | Complétez-les pour documenter et vérifier votre application. |
| `requirements.txt` | Ajoutez vos dépendances et vérifiez la compatibilité avec Python et l’image Docker. |
| `Dockerfile` | Vous en êtes responsable. Vous pouvez l’adapter en conservant le démarrage HTTP, les dépendances nécessaires et le contrat de port. |
| Port HTTP | L’application doit écouter sur `0.0.0.0`, respecter `PORT` et correspondre au port déclaré dans le portail et à `EXPOSE`. Coordonnez tout changement avec la configuration de déploiement. |
| Health checks | Préservez `/healthz`. Le template actuel fournit cette route ; si votre configuration utilise aussi `/ready`, ajoutez et maintenez cette route conformément aux probes configurées. |
| SQLite | Gardez la base sur le stockage persistant configuré, sans la commiter dans Git. |
| PostgreSQL | Gardez le contrat `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, sans secrets dans le code. |
| `.gitignore` et `.dockerignore` | Vous pouvez les compléter ; conservez l’exclusion des secrets et données locales. |
| Workflow `.github/workflows/cnp-<nom-application>.yml` après déploiement | Géré par la plateforme pour les environnements dev/prod. Ne le supprimez pas et ne modifiez pas ses étapes, références ou validations sans accord de l’équipe plateforme. Certains anciens repos utilisent `ci.yml`. |
| Secrets et variables GitHub injectés par le portail | Ne les supprimez pas et ne changez pas leurs noms ou valeurs sans l’équipe plateforme. |
| Manifests dans `config-repo`, ressources cloud et paramètres de failover | Ne les modifiez pas directement pour contourner le portail. Passez par le parcours autorisé et la validation de l’équipe plateforme. |

## 6. Vérifier vos changements et les faire relire

```bash
flake8 .
pytest
git add app.py test_app.py
git commit -m "feat: ajouter ma fonctionnalite"
git push -u origin feat/ma-premiere-fonctionnalite
```

Adaptez les fichiers de `git add` à votre travail. Ouvrez une **pull request** vers
`main` sur GitHub. Faites relire le code et attendez les vérifications CI configurées.
Le test PostgreSQL fourni simule la connexion ; il ne remplace pas un test contre
votre base de développement lorsque vous changez les requêtes ou le schéma.

**Avant le premier déploiement**, un push ne déclenche pas le déploiement CNP.
Utilisez **Déployer ce repo**, choisissez les options compatibles avec votre
base, puis soumettez explicitement le formulaire.

**Après configuration du déploiement**, une mise à jour de `main` peut déclencher
le pipeline dev. La production utilise `prod` et le circuit de validation manager
du portail. Ne contournez pas ce circuit par des changements de workflow ou des
manipulations directes de l’infrastructure. Pour livrer en production, suivez le
processus de votre équipe et les validations affichées par le portail.

Pour les responsabilités générales et l’infrastructure, consultez aussi le
[contrat de plateforme](/docs/PLATFORM_CONTRACT.md). En cas de doute sur un fichier
géré par CNP, demandez à l’équipe plateforme avant de le modifier.
