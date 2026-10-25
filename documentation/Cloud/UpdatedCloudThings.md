# Changements cloud — déploiements dev/prod

Ce guide complète Terraform et les manifests GitOps. Il décrit les opérations
nécessaires pour reconstruire cette configuration après un changement de compte,
de projet ou de cloud. Ne pas réutiliser les identifiants ci-dessous dans un
autre projet sans les recalculer. Aucun secret ne doit être ajouté à ce fichier.

## Paramètres de l'installation actuelle

| Paramètre | Valeur actuelle | À recalculer lors d'une migration |
|---|---|---|
| Projet GCP | `cnp-terraform-512313` | ID et numéro du nouveau projet |
| Région / zone | `europe-west9` / `europe-west9-b` | Région Cloud Run et emplacement GKE |
| Cluster | `cnp-cluster-terraform` | Nom et contexte Kubernetes |
| Identité Crossplane GCP | `crossplane-gcp-sa@cnp-terraform-512313.iam.gserviceaccount.com` | Compte et association Workload Identity |
| Registre | `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry` | Hôte, projet et dépôt Artifact Registry |
| Domaine applicatif | `apps.mooroon5.fr` | Domaine et délégation DNS |
| Zone Route53 | `Z03070463OHUIPXFTWDYQ` | Zone du compte AWS propriétaire |
| IP du LB GCP | `34.54.71.90` | IP réservée du nouveau load balancer |
| URLMap / CertificateMap | `cnp-apps-urlmap` / `cnp-apps-certmap` | Ressources du nouveau projet |

## Sources déclaratives et opérations

1. Dans `config-repo`, les manifests
   `argocd/projects/team-cnp-dev.yaml` et `team-cnp-prod.yaml` définissent les
   projets Argo. Ils ont été appliqués sur le cluster courant. Pour une nouvelle
   installation, lancer `scripts/cloud/bootstrap-environment-projects.sh`
   avec les paramètres du nouveau cluster ; le défaut est une validation serveur,
   `--apply` applique les projets. Ce script ne déploie aucun scanner global.
2. `config-repo/infra/crossplane/providers/provider-gcp-compute.yaml` ajoute le
   provider compute, référencé par le kustomization des providers. Il utilise le
   runtime GCP existant et son identité injectée. Ce provider est nécessaire aux
   NEGs serverless, backends et routes applicatives. Vérifier son état Installed
   et Healthy avant de publier ces ressources. Un changement de compte demande
   de mettre à jour le runtime et le ProviderConfig GCP, pas seulement le portail.
3. Le certificat existant `*.apps.mooroon5.fr` ne couvre pas
   `*.dev.apps.mooroon5.fr`. Le script `scripts/cloud/bootstrap-dev-domain.py`
   prépare le domaine dev et refuse d'écraser une politique DNS existante.
   Il ne modifie pas les enregistrements failover de production.

   ```bash
   python3 scripts/cloud/bootstrap-dev-domain.py \
     --project NEW_PROJECT --base-domain apps.example.fr \
     --zone NEW_ROUTE53_ZONE --lb-ip NEW_LB_IP \
     --certificate-map NEW_CERTIFICATE_MAP
   # Vérifier le plan, puis relancer avec --apply.
   ```

   Le script utilise gcloud, kubectl et les credentials AWS déjà configurés
   (variables AWS ou référence de secret du ProviderConfig). Aucun SDK
   supplémentaire n'est requis. Il crée uniquement l'autorisation DNS dev,
   le certificat wildcard dev, son entrée dans la CertificateMap et les Records
   Crossplane CNAME/A manquants. Les Records utilisent `deletionPolicy: Orphan`.
   Attendre DNS Ready/Synced et certificat ACTIVE avant de valider HTTPS.

## Configuration du portail et du CI après changement de projet

### Routage partagé et ordre des dépendances

Dans `config-repo`, `platform/application-routing/urlmap.yaml` importe le
load balancer existant et conserve son backend historique par défaut.
`argocd/apps/cnp-application-routing.yaml` définit son unique propriétaire Argo.
Avant de reprendre ces fichiers dans un autre projet, lire l'URLMap réellement
présente, préserver toutes ses routes, et remplacer le projet et les URLs des
backends. La politique `Observe, Update` exclut Create/Delete et la late-initialization et
`deletionPolicy: Orphan` protège le load balancer partagé.

Après fusion de la configuration, appliquer uniquement l'Application :

```bash
kubectl apply -f argocd/apps/cnp-application-routing.yaml
kubectl patch configmap argocd-cm -n argocd --type=merge \
  --patch-file argocd/config/crossplane-storage-health.patch.json
```

Le patch ne modifie que les contrôles de santé Bucket et BucketIAMMember ;
il préserve les autres paramètres Argo. Il est nécessaire pour attendre les
conditions Crossplane Ready et Synced entre les vagues : bucket 0, accès au
bucket 1, Cloud Run 2, accès public 3, NEG 4 et backend 5.

Les NEGs/backends sont générés dans chaque environnement publié. Le portail
ajoute/supprime seulement ses propres routes du manifeste partagé, conserve
les routes voisines et n'ajoute pas un candidat de production avant validation.
L'URL n'est disponible dans l'interface qu'après observation du service, de sa
révision, des ressources de routage et d'une réponse HTTPS réussie.

Le rôle Kubernetes du portail nécessite aussi la lecture des ressources
compute. Source reproductible : `scripts/cloud/portal-rbac.yaml` ; appliquer ce
fichier après avoir vérifié le contexte du nouveau cluster. Toute définition
Terraform équivalente de ce rôle doit conserver la règle
`compute.gcp.upbound.io` / `regionnetworkendpointgroups, backendservices, urlmaps`
avec `get, list, watch`.

### Permission GCP supplémentaire pour le routage

Le compte Crossplane doit disposer de `roles/compute.loadBalancerAdmin` dans le
projet cible. Ce rôle inclut la gestion des NEGs, backends et URLMaps ; il ne
nécessite pas de rôle réseau supplémentaire pour ces opérations.
Un propriétaire/administrateur IAM du projet doit exécuter :

```bash
gcloud projects add-iam-policy-binding NEW_PROJECT \
  --member=serviceAccount:CROSSPLANE_SERVICE_ACCOUNT \
  --role=roles/compute.loadBalancerAdmin --condition=None
```

Sur le projet actuel, l'ajout par le compte opérateur a été refusé
(`setIamPolicy`). L'autorisation a été demandée au propriétaire ; elle ne doit
pas être considérée comme appliquée avant vérification. Pour une reconstruction
Terraform, ajouter ce binding au module IAM du projet avec les identifiants
paramétrés du nouveau compte et du nouveau projet.

Mettre à jour `.env.cloud` via le mécanisme d'import existant : `GCP_PROJECT`,
`GCP_REGION`, `GCP_IMAGE_REGISTRY`, `GCP_CLOUD_RUN_SA`,
`GITHUB_REGISTRY_URL`, `GITHUB_GCP_SA_EMAIL`, `GITHUB_WIF_PROVIDER`,
les credentials/API Kubernetes et Argo. `APPLICATIONS_BASE_DOMAIN` est optionnel
et vaut `apps.mooroon5.fr` par défaut. Ne pas confondre ce domaine applicatif
avec le domaine historique des ingress Kubernetes.

Configurer Workload Identity Federation pour les dépôts applicatifs dans le
nouveau projet. Vérifier les droits push Artifact Registry, exécution Cloud Run,
stockage si demandé, et gestion du load balancer pour Crossplane. Conserver les
secrets dans les gestionnaires existants. Les valeurs de l'ancien projet ne
doivent pas rester dans les variables GitHub des applications.

Le workflow conserve `main → dev` automatique et `prod → production` après
validation manager. Les images restent nommées `<application>:<SHA>` ; les
ressources runtime sont séparées. Les URLs sont
`<application>.dev.<domaine>` et `<application>.<domaine>`.

## Changement de cloud

Le nouveau parcours du portail reste implémenté pour GCP. Changer un sélecteur
ou une variable ne suffit pas à déployer sur AWS/Azure : fournir et tester les
manifests runtime, le routage HTTPS, les identités CI/provider et les règles de
stockage correspondants. Le domaine stable et Route53 peuvent être conservés,
mais leurs cibles doivent être explicitement mises à jour pour le nouveau cloud.
Le secours AWS nécessite une application AWS réellement disponible ; la présence
d'un ALB et de modèles Route53 ne prouve pas un failover fonctionnel.

## Retour arrière

Conserver les sauvegardes de la base du portail et les anciens manifests.
Suspendre la publication avant un retour arrière. Détacher les routes d'un
backend avant de le supprimer. Ne pas supprimer le LB partagé, ses routes
historiques, les certificats de production, les DNS de failover ou le provider
compute tant que d'autres ressources en dépendent. Les ressources marquées
Orphan nécessitent un nettoyage explicite et vérifié.

## État observé pendant le déploiement

- AppProjects dev/prod créés ; scanner historique conservé.
- Provider compute installé : Installed=True, Healthy=True.
- Permission loadBalancerAdmin demandée au propriétaire : ajout opérateur refusé.
- DNS wildcard dev et CNAME d'autorisation : Ready/Synced.
- Certificat dev : ACTIVE.
- Patch de santé stockage Argo appliqué ; RBAC de lecture compute appliqué.
- Baseline URLMap et Application de routage ajoutées dans config-repo (PR #37).
- Hébergement du portail inchangé ; base existante sauvegardée avant migration.
- L'intégration des routes, les merges restants et le test complet Pixel Cam
  doivent être enregistrés ci-dessous une fois vérifiés.
