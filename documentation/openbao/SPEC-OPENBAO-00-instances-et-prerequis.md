# SPEC-OPENBAO-00 — Instances OpenBao et prérequis de raccordement

**Ordre : 0/3, préalable de plateforme.** Cette SPEC décrit le contrat nécessaire au portail et sa recette réelle.

**Statut au 18 novembre 2026 : PARTIEL, acceptation ouverte.** L'instance Azure est déployée et plusieurs tests serveur sont passés. Le JWT du pod portail, la livraison à Container Apps et la restauration isolée ne sont pas encore validés. L'état GCP et AWS doit être suivi séparément. Ne pas marquer `DONE` avant tous les contrôles d'acceptation ci-dessous.

## État des dépôts et du cloud

- `config-repo/platform/openbao/` prépare une installation **GCP opt-in** par Application Argo manuelle. Son fichier de valeurs mentionne encore le projet et le compte GCP actuels ; ce n'est pas une preuve d'installation live.
- **Azure, constat réel du 18 novembre 2026 :** `cnp/azure/openbao-server/` (commit local `41237e7` sur `cluster`) déclare la VM `cnp-openbao-az-vm`, son disque Raft persistant, le coffre d'unseal `cnpob8e885538seal`, la clé `openbao-unseal`, l'identité serveur `cnp-openbao-az-server-id` et le stockage privé des snapshots. Le serveur est initialisé, auto-unsealed et répond en HTTPS sur `https://cnpob8e885538.francecentral.cloudapp.azure.com`. L'instance est indépendante de GCP et AWS. Le plan de cette racine Terraform indique 0 création, 0 modification et 0 suppression.
- `cnp/gcp/11-vault.tf` déclare un **Vault HashiCorp** séparé, avec son propre chart et son propre stockage. Il ne constitue pas l'instance OpenBao demandée ; aucune migration ou suppression de ce Vault n'est implicite.
- Les changements de comptes GCP et AWS imposent toujours de revoir identités, réseaux, KMS et références. Pour Azure, la connexion Entra et les rôles IAM du principal Terraform sont vérifiés ; le certificat opérateur expire le 16 février 2027.

## Résultats Azure déjà obtenus

- Certificat HTTPS vérifié ; `/v1/sys/health` a répondu HTTP 200 après redémarrage de la VM.
- Identité managée du serveur testée **depuis la VM** : `get`, `wrap`, `unwrap`, `encrypt` et `decrypt` sur la seule clé d'unseal.
- KV v2 `cnp-runtime` avec CAS obligatoire : écriture/lecture, refus d'un CAS périmé et relecture de l'ancienne version avec valeurs fictives.
- Un JWT malformé est refusé. Le rôle `cnp-control` est lié au sujet numérique du compte de service GCP du portail et à l'audience de l'endpoint Azure ; un JWT réel émis au pod reste à vérifier.
- Audit fichier déclaré dans la configuration OpenBao 2.6 ; snapshot Raft transféré au conteneur privé ; auto-unseal et données Raft conservés après redémarrage.
- Les cinq parts de récupération, seuil trois, sont chiffrées avec le certificat opérateur et sauvegardées dans un blob privé. Leur distribution à plusieurs responsables et la révocation du jeton initial sont requises avant la production.

Le runbook `cnp/azure/openbao-server/README.md` fournit les noms, commandes,
limites et coût. Les fichiers sont disponibles dans la copie locale de travail
`cnp-cluster/azure/openbao-server/`.

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
2. Le JWT **réel du portail** peut écrire puis lire une version KV v2 dans son périmètre ; un client applicatif ne peut pas accéder à une autre application ou à l'autre environnement. Le rôle de contrôle du portail a, par conception, accès à toutes les applications qu'il administre : vérifier séparément les contrôles d'appartenance dans le portail et les identités runtime bornées à leur coffre.
3. Le domaine AWS reste lisible sans GCP pour le mode GCP PostgreSQL prod ; aucun secret des modes GCP sans secours n'y est créé.
4. Aucune valeur secrète n'apparaît dans Terraform state affiché, Git, les logs de test ou la réponse utilisateur.

Pour la recette Azure de bout en bout, appliquer les identités fédérées et les coffres par application/environnement de `cnp/azure/14-openbao-runtime-identities.tf` uniquement après un plan ciblé sans modification ni suppression de ressources existantes. Configurer puis déployer le portail, exécuter le scénario Container App et tester la restauration isolée. L'accord de l'utilisatrice autorise l'`apply` Azure après pull de `cluster`, sous la contrainte explicite de ne retirer aucune ressource cloud. Aucun push sur branche protégée n'est implicite.
