# SPEC — Déploiement reproductible de `cnp-portal` sur GCP

Statut : **proposition à discuter, aucun déploiement autorisé par ce document**  
Date : 19 novembre 2026  
Décision acquise : **GKE + GitOps**, image construite depuis un commit validé de `main` et référencée par digest immuable.  
Point de départ vérifié : `cnp-portal/main` après la fusion OpenBao Azure (`1ec6ef3`) et la PR OpenBao privé #38. Relever à nouveau les SHA avant toute exécution : les dépôts et le cluster peuvent évoluer.

## 1. Besoin fonctionnel et état actuel (`quick_fix.md` §1–2)

**Déjà fait ?** Le code portail et les overlays Kubernetes existent ; le déploiement complet, reproductible et recetté sur GKE n'est pas établi.  
**Changement nécessaire ?** Oui : les manifests prod contiennent encore une adresse d'exemple et une ancienne image, et le chemin de publication de l'image depuis `main` n'est pas déclaré dans le workflow actuel.

**Comportement attendu.** Un utilisateur ouvre le portail à son domaine HTTPS réel, se connecte, retrouve ses données après redémarrage et utilise les services de plateforme qui ont passé leur recette. Une réinstallation suit les mêmes commits, Terraform, secrets gérés, manifests et commandes documentées. Les modes non prêts restent bloqués explicitement ; une page `/ready` verte ne vaut pas validation des intégrations.

**Parcours touchés.** Authentification GitHub et admin, approbations, déploiements et GitOps, Argo CD/Crossplane, OpenBao et livraison des variables GCP/Azure/AWS/privé, failover, observabilité Datadog, assistant MCP, sauvegarde et retour arrière. La migration des données locales du portail est distincte de la migration des bases des applications.

**Critères d'acceptation métier.** HTTPS et OAuth sur le vrai domaine ; utilisateurs et demandes conservés après redémarrage ; publication d'une application témoin ; droits refusés hors équipe ; état Argo et logs réels ; variables OpenBao versionnées et isolées ; aucune valeur secrète dans Git, les images ou les journaux ; retour à la version antérieure démontré ; reconstruction du portail selon ce runbook dans un environnement propre.

### Constat vérifiable dans les dépôts (à revalider sur le cluster)

| Constat | Conséquence pour le déploiement | Source |
| --- | --- | --- |
| `main` ne contient que `portal-validation.yml`, exécuté sur les PR vers `main` ; l'ancien workflow de publication a été retiré. | Il manque une chaîne déclarée pour construire, scanner, publier et promouvoir l'image du portail. | [workflow main](https://github.com/Mooroon5-CNP/cnp-portal/blob/main/.github/workflows/portal-validation.yml), [workflow CI réutilisable](https://github.com/Mooroon5-CNP/ci-templates/blob/main/.github/workflows/pipeline.yml) |
| L'overlay dev configure GCP/Azure OpenBao, mais utilise `latest` et `cnp-portal.dev.example.com`. L'overlay prod utilise `1.0.0` et `cnp-portal.example.com`, sans raccordement OpenBao. | Il faut une promotion par digest et deux overlays complets, avec domaines et identités validés. | [`k8s/overlays/dev/kustomization.yaml`](../../k8s/overlays/dev/kustomization.yaml), [`k8s/overlays/prod/kustomization.yaml`](../../k8s/overlays/prod/kustomization.yaml) |
| La base du portail est SQLite dans `/app/data`, le conteneur a un root filesystem en lecture seule, aucun volume `/app/data`, et prod demande deux réplicas. Les sessions `express-session` utilisent le store mémoire par défaut. | Sans correction, le pod risque de ne pas démarrer ; deux pods ne partagent ni la base ni les sessions. C'est le premier choix d'architecture encore ouvert. | [`src/models/db.js`](../../src/models/db.js), [`src/index.js`](../../src/index.js), [`k8s/base/deployment.yaml`](../../k8s/base/deployment.yaml) |
| La base référence des Secrets nommés `cnp-portal-dev-*` et `cnp-portal-cloud-env` est `optional: true`. | Prod peut démarrer avec des secrets dev ou sans configuration cloud complète. Vérifier chaque référence et rendre les prérequis nécessaires. | [`k8s/base/deployment.yaml`](../../k8s/base/deployment.yaml) |
| `config-repo/apps/cnp-portal/base` ne contient qu'un `default-deny-all` sans règles d'autorisation visibles dans ce dossier. | Une adoption de cette policy couperait le trafic ; définir les flux entrants et sortants avant l'activation. | [config-repo portal](https://github.com/Mooroon5-CNP/config-repo/tree/main/apps/cnp-portal/base) |
| Le checkout local de `cnp` déclare le namespace, KSA/GSA, RBAC et `cnp-portal-cloud-env`, avec notamment un `KUBE_TOKEN` long terme. Ce checkout comporte des modifications non fusionnées. | Comparer la branche distante et l'état réel ; préférer l'identité du pod pour Kubernetes, et faire évoluer le contrat du secret sans interrompre les clients. | [cnp/gcp/11-portal.tf](https://gitlab.cri.epita.fr/thomas.baller/cnp/-/blob/cluster/gcp/11-portal.tf) — confirmer la branche et les différences locales |
| Le guide OpenBao décrit GCP et avertit que son Service est `ClusterIP`. Les identités runtime sont déclarées, pas prouvées appliquées. | Déployer dans le même GKE est cohérent ; tester les identités, TLS, réseau et droits depuis le pod. | [`spec_How_to-deploy_cnp-portal.md`](../openbao/spec_How_to-deploy_cnp-portal.md), [`instances_openBao.md`](../openbao/instances_openBao.md) |
| Le client MCP utilise un faux client par défaut ; `npm start` ne lance pas MCP-CNP. | Une interface de chat visible ne prouve pas que les sources réelles fonctionnent. | [`MCP_INTEGRATION.md`](../MCP_INTEGRATION.md), [`apps/orchestrator/src/mcp-client/index.js`](../../apps/orchestrator/src/mcp-client/index.js) |

Ces constats décrivent **le code**, pas la présence ni la configuration effective des ressources cloud. L'inventaire live est une étape bloquante de préparation.

## 2. Choix techniques à challenger (`quick_fix.md` §3)

### D1 — Persistance et nombre de réplicas : décision requise avant les manifests prod

La pondération privilégie la reproductibilité et la sûreté des données. Scores proposés, à corriger après inventaire des volumes et des données existantes.

| Critère | Poids | A — 1 pod + PVC SQLite + sauvegarde | B — base partagée PostgreSQL + sessions partagées | C — 2 pods SQLite indépendants |
| --- | ---: | ---: | ---: | ---: |
| Intégrité et continuité des données | 35 % | 3/5 | 5/5 | 0/5 |
| Compatibilité avec le code actuel | 25 % | 5/5 | 2/5 | 1/5 |
| Reproductibilité et reprise | 20 % | 4/5 | 4/5 | 1/5 |
| Effort et délai | 10 % | 5/5 | 2/5 | 4/5 |
| Coût d'exploitation | 10 % | 4/5 | 2/5 | 3/5 |
| **Total indicatif** | **100 %** | **4,00/5** | **3,45/5** | **1,15/5** |

**Proposition : A pour une première mise en service maîtrisée**, avec un seul pod, PVC et procédure de sauvegarde/restauration SQLite/WAL testée. Remplacer la stratégie `RollingUpdate` avec `maxSurge: 1` par une stratégie qui empêche deux processus d'écrire simultanément la même base, puis démontrer la mise à jour et le retour arrière. A accepte une interruption pendant la reprise du pod et ne remplit pas une exigence de haute disponibilité. **B devient nécessaire si deux réplicas ou une tolérance à la perte d'un nœud sont requis** ; il implique une migration du modèle de données, des sessions et de leur recette. C n'est pas acceptable : deux bases et deux stores de session divergent. Ne pas conserver `replicas: 2` tant que B n'est pas réalisé.

### D2 — Image et promotion : choix recommandé, à confirmer

**A — Workflow dédié au portail** : CI sur PR, build/scans sur `main`, publication dans Artifact Registry par Workload Identity Federation, digest signé ou attesté si la plateforme le prévoit, puis PR de promotion du digest dans les overlays. C'est le choix recommandé : il rend la provenance et le retour arrière contrôlables. **B — réactiver l'ancien workflow** : moins d'écriture initiale, mais il faut prouver qu'il respecte encore la CI et les comptes actuels. **C — build local puis push** : possible pour dépannage, non acceptable comme procédure reproductible. Le workflow de `ci-templates` peut servir de base ; vérifier sa sortie digest et ses permissions réelles avant de le réutiliser.

### D3 — MCP réel : choix fonctionnel à confirmer

**A — livrer MCP-CNP comme service GKE séparé avec URL HTTPS interne, identité et secret de service** : recette intégrée dès le lancement. **B — lancer d'abord le portail avec l'interface MCP conservée, afficher l'indisponibilité de la connexion réelle, puis l'ajouter dans une promotion distincte** : réduit le chemin critique, mais le lancement n'inclut pas l'assistant réel. Le mode `fake` ne doit pas être présenté comme une recette MCP. Choisir selon la portée du premier lancement ; documenter le choix et le test de non-régression. **Décision du 19/11 : B, sans retirer ni masquer les fonctionnalités MCP.**

### D4 — Environnement de validation et domaine : à renseigner

Valider sur un domaine de staging réel avant le domaine prod. Choisir les FQDN, zone DNS, émetteur de certificat, frontière d'accès (public/VPN), callback GitHub OAuth et stratégie de secrets propres à chaque environnement. Ne pas remplacer les placeholders par des noms supposés. Si le même namespace GKE héberge les deux environnements, prévoir des noms de ressources, bases, secrets et identités distincts ; sinon choisir des namespaces séparés. Confirmer aussi si un déploiement du portail existe déjà, pour l'adopter sans double propriétaire.

## 3. Dépôts concernés et responsabilité de chaque changement (`quick_fix.md` §4)

| Dépôt | Changements prévus | Impact et compatibilité à vérifier |
| --- | --- | --- |
| `cnp-portal` | Workflow build/release ; manifests base et overlays par environnement ; adaptation de la persistance, sessions, probes et configuration ; tests de contrats ; ce runbook. | Login, base SQLite, approbations, réconciliation, GitHub App, OpenBao, Datadog, MCP, déploiements et failover. Aucun secret dans le dépôt. |
| `cnp` (branche d'infrastructure effective à confirmer, vraisemblablement `cluster`) | Terraform GKE, GSA/KSA, IAM, PVC ou base partagée, DNS/certificats si gérés ici, secrets cloud et droits réseau. Appliquer les identités runtime nécessaires après plan revu. | Détecter la dérive Terraform et éviter de remplacer le cluster, OpenBao, Argo ou des ressources existantes. `portal_environment` doit refléter le contrat réel du pod. |
| `config-repo` | Une Application Argo CD dédiée au portail et son ownership ; NetworkPolicies ingress/egress ; éventuellement ConfigMaps publiques, promotion du digest si les manifests y sont hébergés. | Éviter qu'Argo, Terraform et une commande manuelle gèrent le même Deployment. Préciser AppProject, repository credentials, sync et prune. |
| `ci-templates` | Changement seulement si le workflow réutilisable ne sait pas construire, scanner, publier et retourner le digest requis sans publier automatiquement des manifests applicatifs. | Toute modification est partagée avec d'autres applications ; tester les consommateurs existants avant fusion. |
| `MCP-CNP` | Changement seulement si D3=A et qu'il manque image, manifests, endpoint, auth ou tests compatibles avec le portail déployé. | Versionner son image et son contrat avec la version du portail. Ne pas utiliser le launcher local en production. |

Les emplacements définitifs des manifests portail se décident avec l'ownership Argo : une option simple est de garder `k8s/` dans `cnp-portal` et une Application bootstrap dans `config-repo` pointant vers un commit/révision contrôlé. Éviter deux copies éditables des mêmes objets.

### Matrice de dépendances à valider, sans conclure de la seule présence du code

| Service | Contrat d'exécution | Test de compatibilité et échec attendu |
| --- | --- | --- |
| GKE/Argo CD/Crossplane | KSA/GSA du pod, RBAC borné, URL Argo et CA valides ; Argo possède le portail sans boucle de gestion ; accès GitHub de lecture au repo. | Argo `Healthy/Synced`, lecture puis sync autorisé d'une app témoin, refus sur une app hors périmètre ; retrait d'un droit doit échouer clairement. |
| GitHub OAuth et GitHub App | Callback HTTPS du domaine exact, credentials et installation App runtime, droits sur `config-repo` ; aucune clé dans l'image. | Login, session, création de branche/PR de test, attribution au bot, refus si droits absents. Vérifier les webhooks/URLs après changement de domaine. |
| Données/session | Volume durable ou base partagée selon D1 ; secrets de session stables ; sauvegarde/restauration, migration et verrouillage SQLite si A. | Redémarrage puis lecture des mêmes utilisateurs, déploiements, demandes et sessions selon le contrat retenu. `/ready` doit couvrir les dépendances critiques retenues. |
| OpenBao GCP | DNS du Service `ClusterIP`, TLS avec CA publique, metadata server GKE, JWT audience/rôle, KV v2/CAS. | Depuis le pod, écrire/lire deux versions fictives et vérifier refus inter-app/inter-env ; redémarrer sans token statique. |
| OpenBao Azure | Endpoint TLS joignable depuis GKE, jeton Kubernetes projeté pour Entra, identité portail, Key Vault applicatif borné. | Auth JWT et livraison d'une variable dans une app Azure témoin ; refus hors coffre. Valider l'`apply` des identités et coffres avant d'activer ce mode. |
| OpenBao AWS et secours | Endpoint TLS joignable, JWT ; identité AWS du portail et rôles ECS par app, Secrets Manager dans le compte/région actifs. | Valeur pinée lue par ECS ; pendant panne GCP contrôlée, lire les valeurs depuis AWS. Ne pas annoncer le mode prêt sur la seule réussite GCP. |
| OpenBao cloud privé | Endpoint du cluster privé et port autorisé depuis la sortie GKE, JWT `CNP_OPENBAO_PRIVATE_*`, External Secrets et politique d'admission. | Publication versionnée dans un namespace privé témoin ; redémarrage et refus de lecture croisée. PR #38 est du code fusionné, pas une recette live. |
| Datadog | Contrat `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE` du portail et destination d'émission des logs/métriques des apps ; vérifier le Secret effectif, pas seulement `DATADOG_API_KEY` du manifest. | Logs/métriques d'une app témoin et restriction par équipe ; absence de données clairement distinguée d'une panne Datadog. |
| MCP/IA | Selon D3, `MCP_CLIENT_MODE=http`, URL HTTPS, origin, JWT/secret et sources Git/Argo/Kubernetes/Datadog ; clés IA éventuelles séparées. | Catalogue réel, lecture dev/prod bornée, chat SSE ; 401/403 et source indisponible visibles ; aucune réponse fixture présentée comme réelle. |
| DNS/Ingress/cert-manager | FQDN réel, certificat valide, route vers Service, en-têtes proxy et cookies `Secure`. | HTTPS, callback OAuth, absence de boucle de redirection, renouvellement du certificat. |
| Réseau | Politique egress explicite : DNS, GKE metadata, OpenBao, Argo, Kubernetes API, GitHub, Datadog, MCP, Azure et AWS selon modes actifs. | Tests depuis le pod réel ; deny-by-default maintenu, refus d'une destination non prévue. |

## 4. Séquence exécutable et preuves à conserver (`quick_fix.md` §5–6)

Chaque étape produit un artefact versionné ou une preuve datée **sans secret**. L'équipe inscrit commit, image digest, projet/cluster, environnement, responsable, commande, résultat et lien de log dans un journal de déploiement.

1. **Inventaire en lecture seule.** Relever SHA des dépôts ; `terraform state`/plan, objets K8s, Applications Argo, registry, DNS et certificats ; exporter le schéma et un backup chiffré de la base existante si elle existe. Déterminer les propriétaires réels de chaque objet. Arrêt si l'inventaire révèle des ressources déjà gérées autrement.
2. **Décisions D1–D4.** Écrire les choix, critères et conséquences fonctionnelles dans ce document avant toute modification majeure. Un changement du nombre de réplicas ou du mode MCP doit avoir un test correspondant.
3. **Préparer les PR séparées.** `cnp-portal` : code/manifests/CI ; `cnp` : plans Terraform sans suppression inattendue ; `config-repo` : Argo/NetworkPolicy ; `MCP-CNP` et `ci-templates` seulement si requis. Revoir le rendu Kustomize, les diff Argo et Terraform, les droits IAM et les secrets référencés.
4. **Construire l'image depuis `main`.** Passer lint, tests et scans ; publier par identité CI fédérée ; enregistrer `source SHA → image digest`. Ne jamais promouvoir un tag mutable. Vérifier que l'image contient le code OpenBao, le runtime Python failover et les composants nécessaires au portail.
5. **Préparer les dépendances avant le pod.** Créer ou vérifier stockage, KSA/GSA et fédérations Azure/AWS, CA publiques, Secrets runtime, AppProject/Argo, règles réseau, DNS et certificat. Les valeurs secrètes passent par un gestionnaire de secrets ou une procédure chiffrée reproductible, jamais par un commit ou une sortie CI.
6. **Déployer staging par Argo.** Synchroniser une seule Application propriétaire vers le digest choisi. Vérifier pod, stockage, `/healthz`, `/ready`, Ingress et chaque dépendance de la matrice. Corriger les écarts dans les dépôts et resynchroniser ; aucune correction manuelle durable.
7. **Recette avant prod.** Login et rôles ; sauvegarde/restauration ; déploiement témoin ; OpenBao et cloud modes réellement préparés ; Datadog ; MCP selon D3 ; failover AWS contrôlé. Enregistrer Pass/Fail/Non testé avec preuve. Un mode non testé n'est pas déclaré disponible.
8. **Promouvoir prod.** PR de changement de digest et configuration d'environnement ; review du diff ; sync Argo observé ; smoke tests ; fenêtre de surveillance. Utiliser le même digest que staging. En cas d'échec, revenir au digest GitOps précédent et restaurer les données seulement si leur format a changé et que la procédure a été testée.
9. **Rejouer.** Recréer un environnement vierge ou un namespace de répétition à partir des dépôts et des paramètres documentés. Vérifier que chaque intervention manuelle est soit supprimée, soit inscrite comme prérequis avec une commande idempotente et une vérification.

### Conditions d'arrêt

Pas de promotion si : risque de perte de données ou sauvegarde non restaurable ; Terraform planifie une suppression non approuvée ; un secret requis manque ; deux contrôleurs possèdent le Deployment ; le certificat ou OAuth échoue ; l'identité du pod est trop large ; une NetworkPolicy bloque une dépendance requise ; les tests de cloisonnement OpenBao échouent ; le mode prod avec secours AWS ne lit pas ses secrets côté AWS. Une intégration facultative choisie pour plus tard doit être désactivée ou signalée explicitement dans l'interface.

## 5. Décisions à prendre ensemble

| ID | Question | Recommandation initiale | État |
| --- | --- | --- | --- |
| D1 | Première production à un pod avec PVC, ou migration PostgreSQL + sessions partagées avant lancement ? | Un pod + PVC si une interruption de reprise est acceptable ; sinon B avant prod. | **À choisir** |
| D2 | Nouveau workflow de publication et promotion par digest ? | Oui, depuis `main`, avec PR de promotion. | **À confirmer** |
| D3 | MCP réel obligatoire au premier lancement ? | Garder l'interface ; distinguer clairement les données de test de la connexion réelle. | **B choisi : service réel plus tard** |
| D4 | Quels FQDN, environnements, frontières d'accès et propriétaire Argo du portail ? | Staging puis prod, ressources séparées, propriétaire unique. | **À renseigner après inventaire** |

## 6. Références

- Méthode de décision : [`../quick_fix.md`](../../../quick_fix.md).
- Contrat de déploiement OpenBao : [`documentation/openbao/spec_How_to-deploy_cnp-portal.md`](../openbao/spec_How_to-deploy_cnp-portal.md).
- État des instances et identités OpenBao : [`documentation/openbao/instances_openBao.md`](../openbao/instances_openBao.md).
- Intégration MCP : [`documentation/MCP_INTEGRATION.md`](../MCP_INTEGRATION.md).
- Manifestes du portail : [`k8s/base`](../../k8s/base), [`k8s/overlays`](../../k8s/overlays).
- Dépôts externes : [cnp (GitLab)](https://gitlab.cri.epita.fr/thomas.baller/cnp), [config-repo](https://github.com/Mooroon5-CNP/config-repo), [ci-templates](https://github.com/Mooroon5-CNP/ci-templates), [MCP-CNP](https://github.com/Mooroon5-CNP/MCP-CNP).
