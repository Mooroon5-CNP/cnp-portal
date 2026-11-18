# SPEC-OPENBAO-00 — Instances OpenBao et prérequis de raccordement

**Ordre : 0/3, préalable de plateforme sous responsabilité de l'utilisatrice.** Cette SPEC décrit le contrat nécessaire au portail ; elle ne demande ni application Terraform ni déploiement depuis la branche du portail.

**Statut : À FAIRE (acceptation).** Les prérequis sont documentés ; les trois instances, leurs politiques et leur accès depuis le portail n'ont pas été vérifiés en réel. Ne pas marquer `DONE` avant les quatre contrôles d'acceptation ci-dessous.

## État des dépôts constaté le 15 novembre 2026

- `config-repo/platform/openbao/` prépare une installation **GCP opt-in** par Application Argo manuelle. Son fichier de valeurs mentionne encore le projet et le compte GCP actuels ; ce n'est pas une preuve d'installation live.
- Aucune installation OpenBao AWS ou Azure n'est déclarée dans les dossiers inspectés. Ces domaines doivent être préparés avant la recette des modes correspondants.
- `cnp/gcp/11-vault.tf` déclare un **Vault HashiCorp** séparé, avec son propre chart et son propre stockage. Il ne constitue pas l'instance OpenBao demandée ; aucune migration ou suppression de ce Vault n'est implicite.
- Le changement prochain des comptes GCP, AWS et Azure impose de revoir les identités, réseaux, KMS et références avant installation. Les changements d'infrastructure seront préparés de préférence en Terraform et revus sans `apply`.

## Instances requises

| Domaine | Nécessaire quand | Emplacement et indépendance |
| --- | --- | --- |
| Azure | Une application est déployée sur Azure. | Instance OpenBao Azure accessible par le portail et par son mécanisme de livraison ; données Azure isolées des domaines publics. |
| GCP | Une application est déployée sur GCP. | Instance OpenBao GCP accessible par le portail. |
| AWS | Le mode GCP PostgreSQL est déployé en production, avec son secours AWS obligatoire. | Instance OpenBao AWS et valeurs nécessaires prêtes avant la panne GCP ; leur lecture et la reprise ne dépendent pas d'OpenBao GCP. |

Les modes GCP SQLite et GCP PostgreSQL dev ne nécessitent aucune écriture dans l'instance AWS. Aucun choix d'instance ni de secours supplémentaire n'est ajouté au formulaire. Le portail route les variables à partir du mode de déploiement validé par le serveur.

## Contrat que la plateforme fournit au portail

- URL HTTPS, CA si privée, montage KV v2 et rôle d'accès pour chaque domaine actif ; authentification d'une identité de service, sans token racine ni token permanent stocké dans Git.
- Droits bornés pour lire/écrire une application et son environnement ; rôles runtime en lecture uniquement si le mode de livraison en a réellement besoin.
- Réseau et DNS permettant au portail de joindre chaque instance requise. Vérifier les appels depuis le runtime réel du portail, pas seulement depuis un poste opérateur.
- Sauvegarde/restauration, audit et rotation des accès opérables ; pour AWS, test de lecture pendant une panne simulée de GCP.
- Paramètres de comptes, projets, régions, identités et clés KMS issus de variables d'infrastructure. La configuration GKE préparée sous `config-repo/platform/openbao/` contient aujourd'hui des valeurs liées au compte courant : les revoir avant tout changement de comptes.

## Critères d'acceptation avant activation du portail

1. Chaque endpoint requis répond sur HTTPS avec une chaîne de confiance vérifiée depuis le portail.
2. Un rôle de test peut écrire puis lire une version KV v2 dans son périmètre, et ne peut pas accéder à une autre application ou à l'autre environnement.
3. Le domaine AWS reste lisible sans GCP pour le mode GCP PostgreSQL prod ; aucun secret des modes GCP sans secours n'y est créé.
4. Aucune valeur secrète n'apparaît dans Terraform state affiché, Git, les logs de test ou la réponse utilisateur.

Tout ajustement d'infrastructure nécessaire est préparé de préférence en Terraform, avec un plan revu séparément. Aucun `terraform apply` et aucun push sur `cnp/cluster` avant accord explicite de l'utilisatrice.
