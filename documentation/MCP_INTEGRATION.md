# Intégration MCP-CNP / CNP Portal

État vérifié le **26 octobre 2026**. Les correctifs actuels sont commités localement
sur `feat/mcp-environment-integration`, après intégration de main dev/prod.
Ils ne sont pas encore poussés ni fusionnés. Le checkout original
`feat/MCPapi` et ses changements locaux sont conservés.

## Fonctionnalités disponibles

| Parcours | Comportement actuel | Conditions / limites |
| --- | --- | --- |
| Connexion et chat | Session portail, CSRF, réponses SSE et tableaux structurés | Lancer l’intégration depuis la branche à jour |
| `/applications` | Catalogue réel filtré par application et environnement autorisés | Accès au registre Git |
| `/deploiement` | Versions souhaitée/servie, santé Argo, synchronisation et dérive | Accès Git/Argo/Crossplane ; preuves manquantes explicites |
| `/logs` | Logs bornés, datés, expurgés, avec pagination/troncature | Credentials Datadog et tags corrects |
| `/finops` | Analyse d’une application et d’un environnement | Métriques nécessaires ; sinon `INSUFFICIENT_DATA` |
| Clarifications | Application et environnement demandés en plusieurs tours | Pas de choix implicite de l’environnement |
| Description naturelle et synthèse | Résolution d’un nom comme « le canard » et reformulation | Configuration `GENAI_*` ; qualité réelle à vérifier |
| FinOps équipe / facturation | Spécifications rédigées | Pas encore implémenté ; coûts V1 toujours `null` |

Une source absente reste absente. La clé IA ne fournit ni métriques CPU/mémoire,
ni montants de facturation. Les faits structurés restent visibles si la génération
échoue. Aucun outil de chat ne déploie, ne supprime ni ne modifie une ressource.

## Démarrage dans un checkout normal

Les dépôts sont normalement voisins : `CNP/cnp-portal` et `CNP/MCP-CNP`.
Utiliser Node.js 24 pour l’environnement testé ; MCP exige Node.js >= 22.

Si les dépendances ne sont pas installées, lancer `npm ci` dans chacun des deux
dépôts. Construire ensuite le runtime MCP :

```bash
cd ../MCP-CNP
npm run build
cd ../cnp-portal
npm run dev:integration
```

Le portail doit contenir les correctifs de la branche actuelle. Préserver `.env`
et `.env.cloud` existants ; créer les fichiers depuis les modèles uniquement
s’ils n’existent pas. La commande démarre MCP sur `127.0.0.1:3000` puis le portail
sur **http://localhost:3001/mcp-chat**. Un probe authentifié valide le catalogue et
les JWT locaux courts sont renouvelés à chaque appel. Ctrl+C arrête les enfants.
Les ports occupés provoquent un arrêt du launcher, sans tuer d’autres processus.

`npm start` démarre uniquement le portail ; il ne lance pas MCP. Le modèle de
configuration utilise un client `fake` : ce lancement seul ne prouve donc pas une
connexion réelle. `npm run dev:integration:mock` choisit explicitement les données
synthétiques, identifiées comme telles dans les résultats.

## Démarrer la branche isolée actuelle

Le worktree créé pour cette reprise est
`documentation/Cloud/.worktrees/mcp-integration` dans le checkout original.
Il contient les commits ; inutile de déplacer les changements non commités du
checkout original. Depuis ce worktree, utiliser les chemins des configurations
existantes et du vrai dépôt MCP :

```bash
PORTAL_CONFIG_DIR=/chemin/vers/cnp-portal
MCP_PROJECT_DIR=/chemin/vers/MCP-CNP \
DOTENV_CONFIG_PATH="$PORTAL_CONFIG_DIR/.env" \
CLOUD_ENV_FILE="$PORTAL_CONFIG_DIR/.env.cloud" \
DB_PATH="$PORTAL_CONFIG_DIR/data/cnp-portal.sqlite" \
node -r dotenv/config scripts/start-local-mcp.cjs
```

`PORTAL_CONFIG_DIR` désigne le checkout qui possède déjà les credentials et la
base à conserver, pas un nouveau dossier. Sans `DB_PATH`, un worktree crée sa
propre base et ses utilisateurs locaux ; ce n’est pas une migration des comptes.
Sans `MCP_PROJECT_DIR`, le chemin par défaut est incorrect dans ce worktree imbriqué.
Choisir explicitement une autre base pour une démonstration isolée.

Le démarrage normal du portail active aussi le réconciliateur de déploiements
sur sa base et son cloud configurés. Le chat est read-only, mais le portail
complet conserve ses fonctions de publication. La recette live ci-dessous évite
ce réconciliateur et utilise une base temporaire.

## Configuration des sources

Secrets uniquement côté serveur, dans les fichiers ignorés ou le gestionnaire de
secrets runtime. Ne jamais les copier dans un chat, une capture ou un fichier suivi.

| Source | Variables / données | Utilisation |
| --- | --- | --- |
| Catalogue et Git souhaité | `GITHUB_CONFIG_REPO_NAME`, `GITHUB_CONFIG_REPO_TOKEN` | Registre et manifests de l’environnement |
| Argo CD | `ARGOCD_SERVER_URL`, token ou `ARGOCD_USERNAME`/`ARGOCD_PASSWORD` | Propriétaire, santé et synchronisation |
| Runtime Cloud Run via Crossplane | `KUBE_API_URL`, `KUBE_TOKEN`, `KUBE_CA_CERT` | Image observée et conditions du service |
| Logs Datadog | `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE` | Recherche sur `service:<applicationId> env:<dev|prod>` |
| Métriques FinOps | Datadog + `MCP_CPU_PERCENT_METRIC`, `MCP_MEMORY_PERCENT_METRIC` | Pourcentages 0–100 avec couverture observée |
| Jev | `TYPESAFE_ENABLED`, `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_TIMEOUT_MS` | Classification des demandes libres ambiguës |
| Génération | `GENAI_ENABLED`, `GENAI_API_KEY`, `GENAI_MODEL`, optionnel `GENAI_BASE_URL` | Synthèse et résolution sémantique autorisée |
| Facturation | Aucun adaptateur connecté en V1 | Coûts inconnus, jamais inventés |

Le launcher reprend les `TYPESAFE_*` de MCP-CNP avec priorité aux valeurs du
portail. `CLOUD_ENV_FILE` sélectionne les paramètres cloud importés. Voir le
[guide cloud](Cloud/README.md) et les
[changements reproductibles](Cloud/UpdatedCloudThings.md) lors d’un changement
de compte, projet ou région.

Le launcher réel réutilise les adaptateurs natifs du portail : GitHub, Argo,
Kubernetes/Crossplane et Datadog. Il n’a pas besoin de la Platform API Python
synthétique. Le serveur MCP lancé seul en `ADAPTER_MODE=http` utilise, lui, ses
façades HTTPS contractuelles ; ce sont deux modes distincts.

Pour un tunnel Argo local existant, conserver son contexte et son endpoint
configurés. Si nécessaire :

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443
```

Un refus 401/403 demande une correction des credentials ou droits ; ne pas le
masquer en activant des fixtures. Ne pas installer de nouvelle infrastructure
pour un simple test de lecture.

## Utiliser le chat

Depuis la liste des déploiements, « Analyser avec MCP » transmet l’application
et l’environnement. Le catalogue n’expose que les cibles autorisées ; un accès
dev seul ne permet pas de consulter prod, même avec le même nom applicatif.

| Commande | Résultat |
| --- | --- |
| `/applications` | Applications et environnements accessibles |
| `/deploiement` | Versions souhaitée et observée, santé et dérive |
| `/logs` | Logs de la dernière heure pour la cible |
| `/finops` | Recommandation de ressources ; fenêtre actuelle du chat : 14 jours |
| `/aide` ou `/` | Aide sans collecte |
| `/annuler` | Abandon de la clarification en attente |

Le menu slash fonctionne au clic ou au clavier : ↑/↓, Entrée/Tab, Échap.
`/deployment` et `/deploiment` sont des alias de `/deploiement`.

```text
Utilisateur : /deploiement
Portail     : Quelle application et quel environnement ?
Utilisateur : app4-pixelcam
Portail     : Quel environnement pour app4-pixelcam ?
Utilisateur : prod
Portail     : consultation de la production autorisée
```

Le contexte est conservé par conversation pendant 15 minutes, au plus 20 demandes
pendantes. Une nouvelle commande remplace l’intention précédente. Un environnement
absent est demandé ; le serveur ne le choisit pas pour l’utilisateur.

Les noms exacts et commandes fonctionnent sans IA. En mode hybride, Jev intervient
pour les demandes libres ambiguës ; s’il ne répond pas, aucun outil qu’il aurait
sélectionné n’est exécuté. La résolution « le canard » ne reçoit que les noms et
identifiants autorisés. Sa proposition est revalidée ; une ambiguïté reste ouverte.

Pour activer la génération, configurer côté portail puis redémarrer :

```dotenv
GENAI_ENABLED=true
GENAI_BASE_URL=https://api.openai.com/v1
GENAI_API_KEY=<clé locale>
GENAI_MODEL=<modèle accessible compatible Responses et sorties structurées>
```

La requête utilise Responses avec `store=false`, sans outils d’écriture. Les
identités, cookies et credentials ne sont pas envoyés au modèle. Une panne de
synthèse conserve les résultats structurés. Les tests simulés du SDK ne prouvent
ni l’accès réel au modèle, ni sa qualité sémantique.

## Interpréter les preuves dev/prod

- Le claim `crossplane/dev|prod` prime sur la racine historique. Un claim plat
  historique est uniquement compatible dev ; il ne représente pas une prod isolée.
- Pour un environnement isolé, la lecture vise son propriétaire Argo et son runtime
  distincts. `MCP_ARGO_APPLICATIONS` peut déclarer un nom Argo particulier.
- La version servie Cloud Run provient d’un état réellement prêt : générations
  observées, révision créée/prête identique et aucune réconciliation active.
  Le résumé d’images Argo n’est pas une preuve de l’image actuellement servie.
- Un digest absent reste inconnu ; les pods GKE ne prouvent pas un digest Cloud Run.
- Une application peut servir correctement alors qu’Argo est dégradé pour une
  ressource de routage. Le résultat reste partiel et conserve cette différence.
- Une absence de métriques, de couverture ou de facturation n’est pas un zéro.
  V1 garde les coûts `null` et n’annonce aucune économie démontrée.

## Vérifications reproductibles

Depuis le portail :

```bash
npm run lint
npm test -- --runInBand
npm run test:generation
npm run test:context
npm run test:integration
```

Les tests de génération/contexte traversent le SDK avec une réponse simulée,
sans appel IA payant. L’intégration croisée teste les quatre contrats, le transport,
les erreurs et SSE sur données synthétiques. Depuis un worktree, sélectionner
les chemins déjà installés au lieu de réinstaller les environnements :

```bash
MCP_PROJECT_DIR=/chemin/MCP-CNP \
PLATFORM_PYTHON=/chemin/cnp-portal/services/platform-api/.venv/bin/python \
npm run test:integration
```

### Recette live cloud et accès

```bash
MCP_PROJECT_DIR=/chemin/MCP-CNP \
MCP_PORTAL_ENV_FILE=/chemin/cnp-portal/.env \
CLOUD_ENV_FILE=/chemin/cnp-portal/.env.cloud \
npm run test:live-environments -- app4-pixelcam
```

Cette recette démarre un MCP loopback éphémère et une base SQLite temporaire.
Elle traverse une vraie connexion portail, CSRF, SSE et les adaptateurs natifs.
Elle vérifie les versions désirée/servie et le runtime prêt des deux environnements.
Un compte de recette dev seul ne doit ni voir prod, ni déclencher son outil ciblé.
Aucun réconciliateur de déploiement, changement cloud ou appel IA payant n’est lancé.
Les credentials ne sont pas imprimés et la base est supprimée à la fin.

La commande `test:live-sources -- <app> --sources-only` permet aussi de lire les
sources, sans Jev/génération ; elle vérifie dev uniquement et ne remplace pas la
recette multi-environnements authentifiée.

### Résultats observés le 26 octobre 2026

- Portail/MCP/dev-prod : **20 suites, 151 tests** ; lint réussi.
- MCP-CNP : **58 tests**, typecheck et lint réussis.
- Intégration croisée et tests SDK simulés : réussis, sans appel IA payant.
- Recette live à 15:51 UTC : connexion/CSRF/SSE/MCP réels, refus prod pour dev seul.

| Cible | Version souhaitée et effectivement servie | Runtime | Argo |
| --- | --- | --- | --- |
| Pixel Cam dev | `566a33ac3d152eb07ab053df8bb1a179d8f4b33e` | Prêt | OutOfSync / Degraded |
| Pixel Cam prod | `7050ee1f84fe69738011952ad0cfdbe263245026` | Prêt | OutOfSync / Degraded |

Les réponses sont donc partielles. Cette observation datée ne valide pas les
URLs personnalisées/failover, Datadog, les coûts réels ni une génération IA live.

## Travail restant pour le fonctionnement complet

Les six spécifications et leurs critères sont dans `MCP-CNP/specs/README.md` du
dépôt voisin ; elles suivent le skill to-spec. La spécification FinOps détaillée
côté portail reste dans [SPEC_FINOPS_CONVERSATIONNEL.md](SPEC_FINOPS_CONVERSATIONNEL.md).

1. Autorisation autonome par application/environnement côté serveur MCP pour les
   appels directs ; le scope JWT global et le filtre portail ne suffisent pas.
2. FinOps V2 par application/équipe, contrat compatible, attribution des ressources,
   données Billing réelles, calculs décimaux et couvertures explicites.
3. Validation live des logs/métriques et de la génération avec les sources configurées.
4. Service MCP partagé versionné, HTTPS, émission/rotation de tokens indépendante,
   limites distribuées et configuration reproductible pour un autre compte/projet.

Le launcher et la signature loopback restent réservés au développement. Aucun
hébergement partagé ni accès multiutilisateur autonome n’est déclaré validé.
