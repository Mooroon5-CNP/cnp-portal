# Instances OpenBao — prérequis de préparation

Ce document sert à préparer les instances nécessaires aux variables d'environnement des applications. Il ne contient ni secret, ni commande d'installation live. Le déploiement de la plateforme est assuré par l'utilisatrice. Les changements d'infrastructure seront de préférence déclarés en Terraform ; aucun `terraform apply` ni push sur `cnp/cluster` avant son accord.

## Instances nécessaires selon le formulaire actuel

| Mode de déploiement | OpenBao à rendre disponible |
| --- | --- |
| Azure dev/prod | Azure seulement. |
| GCP SQLite dev/prod, GCP PostgreSQL dev | GCP seulement. |
| GCP PostgreSQL prod | GCP **et** AWS, car ce mode conserve le secours AWS obligatoire. |

Le portail est le client qui écrit les valeurs dans ces domaines. Les applications utilisent ensuite les secrets préparés dans leur cloud ; elles ne doivent pas dépendre du portail au démarrage. Les valeurs AWS requises pour le secours doivent être disponibles avant une panne GCP.

## État constaté dans les dépôts

- **GCP :** `config-repo/platform/openbao/` contient une Application Argo manuelle et des valeurs Helm OpenBao (chart 0.29.6, image 2.6.3, trois pods Raft, TLS, LoadBalancer interne et auto-unseal GCP KMS). Le dossier n'est découvert automatiquement par aucun ApplicationSet. Il référence encore le projet `cnp-terraform-512313`, le GSA `openbao-seal@cnp-terraform-512313.iam.gserviceaccount.com`, la zone `europe-west9-b` dans le runbook et la branche `fix/cloudrun-environment` dans l'Application. Il faudra les revoir lors du changement de compte. Aucune installation live n'est prouvée par ces fichiers.
- **AWS et Azure :** aucune déclaration d'instance OpenBao n'a été trouvée dans `cnp/{aws,azure}` ou dans `config-repo` lors de l'inventaire du 15/11/2026. Leur architecture de stockage, leur chiffrement d'unseal, leurs endpoints et leur installation restent à préparer.
- **Vault existant :** `cnp/gcp/11-vault.tf` déclare un Vault HashiCorp distinct, à un pod et sans TLS. Il ne remplace pas OpenBao et ne doit pas être supprimé ou migré implicitement.

## Contrat à fournir pour chaque instance

1. **Adresse et confiance :** URL `https://...:8200` joignable depuis le runtime réel du portail, certificat serveur valide et CA fournie si privée. Vérifier DNS, routage et pare-feu depuis le portail.
2. **Stockage et récupération :** volume persistant, sauvegarde/restauration testée et mécanisme d'unseal qui reste disponible selon le scénario de panne prévu. Pour AWS, vérifier l'accès sans GCP.
3. **KV v2 :** montage `cnp-runtime` ou nom communiqué au portail, versionnement activé et écritures CAS exigées. Conserver les versions encore référencées par un déploiement.
4. **Identité du portail :** auth JWT au chemin `jwt`, rôle du portail limité aux chemins `apps/<application>/<dev|prod>`. Le portail demande un jeton d'identité Google à son runtime ; l'instance doit valider son issuer, son audience et le sujet réel du compte de service. Aucun token OpenBao statique dans Git ou dans le portail.
5. **Audit et permissions :** audit sans valeurs, droits de lecture/écriture bornés au portail, pas de droits d'administration ni de lecture croisée pour une application. Préparer une procédure de rotation et de révocation.

## Paramètres attendus par le code du portail

Pour chaque domaine `GCP`, `AZURE`, `AWS` réellement utilisé :

| Variable non secrète du portail | Exemple / sens |
| --- | --- |
| `CNP_OPENBAO_<DOMAINE>_ADDR` | URL HTTPS de l'instance. |
| `CNP_OPENBAO_<DOMAINE>_AUDIENCE` | Audience JWT configurée dans cette instance ; par défaut, son URL. |
| `CNP_OPENBAO_<DOMAINE>_ROLE` | Rôle JWT du portail ; par défaut `cnp-control`. |
| `CNP_OPENBAO_<DOMAINE>_MOUNT` | Mount KV v2 ; par défaut `cnp-runtime`. |
| `CNP_OPENBAO_<DOMAINE>_CA_FILE` | Chemin local de la CA privée, si nécessaire. |

Les URLs, audiences et noms de rôle ne sont pas des secrets. Ne transmettre ni recovery keys, ni root token, ni valeurs applicatives dans un message ou un plan Terraform.

## Validation manuelle avant recette applicative

- Vérifier l'état `initialized`, `unsealed` et l'accès HTTPS de chaque instance ; ne pas publier la sortie d'une commande qui expose un token.
- Depuis l'identité réelle du portail, tester une lecture/écriture KV v2 sur une application fictive dans le bon environnement, puis un refus sur un autre périmètre.
- Pour GCP PostgreSQL prod, vérifier la même génération de variables sur GCP et AWS, puis lire les valeurs AWS pendant une simulation d'indisponibilité GCP.
- Transmettre au développement **uniquement** les URLs, les CA publiques nécessaires, les mounts, les rôles et les audiences validés. La recette de déploiement finale utilisera des variables fictives.

Références produit : [KV v2](https://openbao.org/docs/secrets/kv/kv-v2/), [authentification JWT](https://openbao.org/docs/api/auth/jwt/).
