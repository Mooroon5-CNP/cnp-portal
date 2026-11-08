# Exemple AWS corrigé — ECS Fargate et RDS, prod seulement

Préparation de phase 0 du plan v4, 26 octobre 2026. Les anciens manifestes AWS placés dans l'exemple **dev**, avec un endpoint RDS et un secret de l'ancien compte, sont remplacés par ce rendu local contrôlé. Aucun objet n'est créé automatiquement par ce dossier.

## Périmètre

- Compte `804210702561`, région `eu-west-3` ; image ECR identifiée par digest.
- Cible GitOps après validation : `apps/<app>/crossplane/prod/`.
- Dev GCP et flux bucket inchangés ; pas de secours AWS dev.
- ECS Fargate, RDS privée, ParameterGroup PostgreSQL 15, target group et règle **HTTPS**.
- RDS est conservée/protégée contre la suppression ; le mot de passe maître géré par AWS n'est pas fourni au runtime.
- Endpoint SQL récupéré de l'Instance Crossplane Ready/Synced, sans nom RDS en dur.
- Secret runtime distinct du maître, dans le bon compte/région, référencé par ARN ; aucun mot de passe dans le profil ou le YAML.

## Entrées réelles à fournir

Copier `config.example.json` hors des chemins surveillés et renseigner les valeurs réelles. Les champs `null` sont intentionnels : le script **refuse** de fabriquer un SG, un digest d'image ou un ARN de secret. Le profil d'exemple n'est pas un déploiement prêt à lancer.

| Entrée | Vérification nécessaire avant le futur déploiement |
| --- | --- |
| `database_security_group_id` | SG privé autorisant TCP 5432 depuis les tâches ECS ; ne pas reprendre un SG App Runner sans vérifier ses règles |
| `image` | Image existante, format `804210702561.dkr.ecr.eu-west-3.amazonaws.com/<depot>@sha256:<digest>` |
| `runtime_user` / `runtime_secret_arn` | Compte SQL limité déjà préparé et secret JSON contenant `password` ; accès autorisé pour le rôle d'exécution ECS |
| `listener_priority` | Priorité libre sur le listener HTTPS ; la valeur d'exemple ne réserve rien |
| `log_group_name` | Facultatif : groupe déjà existant, géré et accessible ; aucun groupe de logs n'est créé implicitement par ECS |

Le modèle de phase 0 utilise le port 8080 du SG ECS existant. Les apps sur un autre port demanderont un raccord réseau à l'étape de généralisation. Le driver de l'application doit respecter la connexion TLS configurée et disposer de la CA appropriée ; définir `DB_SSLMODE` ne modifie pas à lui seul son code.

## Rendre les ressources, sans les déployer

Depuis `cnp-portal/scripts/failover/engine`, avec un profil complété :

```sh
python3 render_aws_prod_example.py bootstrap \
  --config /chemin/prive/profil.json --output /tmp/cnp-aws-bootstrap
kubectl kustomize /tmp/cnp-aws-bootstrap
```

Ce premier rendu contient seulement le SubnetGroup, le ParameterGroup et RDS. Le paramètre statique `rds.logical_replication=1` est prévu dès la création pour la future réplication inverse. **Le provider Crossplane devra disposer des permissions de gestion des ParameterGroups avant le fil A.** La policy actuelle doit être vérifiée/complétée lors de cette phase ; aucun droit nouveau n'est appliqué par le générateur.

Après le provisioning **autorisé** et la préparation du compte/secret runtime en phase 1, exporter l'observation, sans lire aucun mot de passe :

```sh
kubectl get instances.rds.aws.upbound.io <app>-prod-db -o json > /chemin/prive/rds.json
python3 render_aws_prod_example.py runtime \
  --config /chemin/prive/profil.json --rds-json /chemin/prive/rds.json \
  --output /tmp/cnp-aws-runtime
kubectl kustomize /tmp/cnp-aws-runtime
```

Le rendu complet ajoute la tâche, le service ECS, le target group et la règle HTTPS. Il refuse une RDS non Ready/Synced, publique, d'un autre compte/app, ou le secret maître. Le nom de TaskDefinition dépend de toute sa configuration, afin qu'un changement de connexion SQL produise une nouvelle définition immuable.

Les rendus restent hors des dossiers suivis par ArgoCD. Leur publication future devra passer par le circuit prod approuvé ; le script n'effectue ni apply, ni écriture Kubernetes/AWS, ni commit/push.

## Ce que ces exemples ne démontrent pas

Le rendu, le contrôle de schéma et un dry-run serveur ne prouvent ni le pull de l'image, ni les droits sur le secret, ni la connexion SQL. RDS/ECS ne sont pas déclarés opérationnels tant que le fil A n'a pas été exécuté et testé. Les tests utilisent des observations fictives explicitement identifiées comme fixtures ; leurs adresses ne sont jamais publiées dans `apps/`.

Ce dossier n'active aucun failover Route53 et ne crée aucune Cloud SQL. La réplication, le contrôle de promotion et le retour GCP relèvent des phases suivantes. La politique de rétention RDS reste à prendre en compte lors de l'offboarding.
