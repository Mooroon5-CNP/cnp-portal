# SPEC-OPENBAO-01 — Contrat de variables et routage OpenBao

**Ordre : 1/3.** Dépend du service OpenBao fourni par l'utilisatrice ; l'implémentation du portail peut être développée et testée avec un faux service. Le déploiement des instances OpenBao n'est pas dans cette SPEC.

## Résultat fonctionnel

Le portail reçoit un ensemble de paires `NOM=valeur` pour une application et un environnement (`dev` ou `prod`), l'enregistre dans OpenBao et garde une référence de version. Un nom identique en dev et prod désigne deux valeurs indépendantes. Le portail ne garde pas les valeurs en SQLite, Git, session navigateur, erreur ou journal.

| Hébergement choisi | Domaine source | Domaine supplémentaire |
| --- | --- | --- |
| Azure | OpenBao Azure | Aucun. |
| GCP sans secours AWS | OpenBao GCP | Aucun. |
| GCP avec secours AWS | OpenBao GCP | OpenBao AWS, avec la même version logique validée avant publication. |

Le formulaire ne présente pas de choix de serveur OpenBao. Le routage découle exclusivement du choix d'hébergement et de l'option de secours. Le chemin direct AWS n'est pas proposé par le formulaire actuel ; il n'est pas activé implicitement par cette SPEC. Les déploiements historiques restent inchangés tant qu'une migration explicite n'est pas demandée.

Pour Azure, le formulaire du portail reçoit temporairement la valeur avant son écriture dans OpenBao Azure. Cette décision explicite remplace, pour ce parcours, l'ancienne hypothèse de SPEC-014 selon laquelle le portail public ne manipulerait jamais une valeur privée. Le portail ne la persiste pas ; le transport jusqu'au domaine Azure est chiffré et authentifié.

## Contrat technique

- Un client OpenBao par domaine configuré par URL HTTPS, CA éventuelle, mount KV v2, méthode d'authentification et rôle. Les URLs et identités sont des paramètres de déploiement ; aucun compte cloud codé en dur.
- Chemins distincts par application et environnement. Les permissions du portail et les rôles de lecture runtime respectent cette frontière ; une application ne lit jamais celle d'une autre ou l'autre environnement.
- KV v2 versionné avec écriture conditionnelle (CAS) pour empêcher qu'une mise à jour concurrente écrase une valeur plus récente. La version logique et les versions physiques par domaine sont consignées sans valeur secrète.
- Pour un secours demandé, la publication attend la présence vérifiée de la même révision logique dans GCP et AWS. Une écriture partielle reste non publiable et peut être reprise sans créer deux versions fonctionnelles différentes. Aucune réplication automatique d'OpenBao n'est présumée.
- Un refus, une indisponibilité ou une lecture incomplète empêche la publication concernée avec un message opérable, sans afficher de valeur. Les applications déjà publiées gardent leurs références existantes.
- Un jeu vide de variables préserve exactement le parcours de déploiement actuel et ne crée aucune dépendance OpenBao.

## Critères d'acceptation

1. Une écriture et une lecture autorisées rendent les noms et versions attendus, sans valeur dans les métadonnées du portail.
2. Une application, une équipe ou un environnement non autorisé ne peut ni lire ni modifier les variables d'un autre périmètre.
3. GCP sans secours ne contacte ni ne crée de données dans OpenBao AWS ; Azure ne contacte que son domaine.
4. GCP avec secours n'est publiable que si les versions attendues sont présentes dans les deux domaines.
5. Une panne OpenBao ou un conflit CAS est explicite et ne modifie pas une publication précédente.

## Préconditions fournies par le déploiement de la plateforme

Endpoint et CA de chaque domaine, montages KV v2, identités/permissions du portail, et connectivité depuis le portail. Aucune clé racine ou token permanent ne doit être transmis au code ou au chat. Les éventuels changements d'identité/réseau sont déclarés en Terraform si nécessaires ; ni `terraform apply` ni push sur `cnp/cluster` avant accord explicite de l'utilisatrice.
