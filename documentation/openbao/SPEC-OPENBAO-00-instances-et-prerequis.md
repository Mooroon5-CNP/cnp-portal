# SPEC-OPENBAO-00 — Instances OpenBao et prérequis de raccordement

**Ordre : 0/3, préalable de plateforme sous responsabilité de l'utilisatrice.** Cette SPEC décrit le contrat nécessaire au portail ; elle ne demande ni application Terraform ni déploiement depuis la branche du portail.

## Instances requises

| Domaine | Nécessaire quand | Emplacement et indépendance |
| --- | --- | --- |
| Azure | Une application est déployée sur Azure. | Instance OpenBao Azure accessible par le portail et par son mécanisme de livraison ; données Azure isolées des domaines publics. |
| GCP | Une application est déployée sur GCP. | Instance OpenBao GCP accessible par le portail. |
| AWS | Un secours AWS est demandé pour une application GCP. | Instance OpenBao AWS et valeurs nécessaires prêtes avant la panne GCP ; leur lecture et la reprise ne dépendent pas d'OpenBao GCP. |

Un déploiement GCP sans secours AWS ne nécessite aucune écriture dans l'instance AWS. Aucun choix d'instance n'est ajouté au formulaire. Le portail route les variables à partir des options de déploiement validées par le serveur.

## Contrat que la plateforme fournit au portail

- URL HTTPS, CA si privée, montage KV v2 et rôle d'accès pour chaque domaine actif ; authentification d'une identité de service, sans token racine ni token permanent stocké dans Git.
- Droits bornés pour lire/écrire une application et son environnement ; rôles runtime en lecture uniquement si le mode de livraison en a réellement besoin.
- Réseau et DNS permettant au portail de joindre chaque instance requise. Vérifier les appels depuis le runtime réel du portail, pas seulement depuis un poste opérateur.
- Sauvegarde/restauration, audit et rotation des accès opérables ; pour AWS, test de lecture pendant une panne simulée de GCP.
- Paramètres de comptes, projets, régions, identités et clés KMS issus de variables d'infrastructure. La configuration GKE préparée sous `config-repo/platform/openbao/` contient aujourd'hui des valeurs liées au compte courant : les revoir avant tout changement de comptes.

## Critères d'acceptation avant activation du portail

1. Chaque endpoint requis répond sur HTTPS avec une chaîne de confiance vérifiée depuis le portail.
2. Un rôle de test peut écrire puis lire une version KV v2 dans son périmètre, et ne peut pas accéder à une autre application ou à l'autre environnement.
3. Le domaine AWS reste lisible sans GCP pour un déploiement ayant choisi le secours ; aucun secret d'un déploiement GCP sans secours n'y est créé.
4. Aucune valeur secrète n'apparaît dans Terraform state affiché, Git, les logs de test ou la réponse utilisateur.

Tout ajustement d'infrastructure nécessaire est préparé de préférence en Terraform, avec un plan revu séparément. Aucun `terraform apply` et aucun push sur `cnp/cluster` avant accord explicite de l'utilisatrice.
