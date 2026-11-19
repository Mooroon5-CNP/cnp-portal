# SPEC-OPENBAO-01 — Contrat de variables et routage OpenBao

**Ordre : 1/3.** Dépend du service OpenBao fourni par l'utilisatrice ; l'implémentation du portail peut être développée et testée avec un faux service. Le déploiement des instances OpenBao n'est pas dans cette SPEC.

**Statut au 18 novembre 2026 : PARTIEL, acceptation à faire.** Client JWT/KV v2, CAS, routage, métadonnées sans valeurs et validation de génération sont codés et testés localement. Sur OpenBao Azure réel, KV v2, CAS et versionnement ont été vérifiés avec des valeurs fictives ; le rôle JWT est configuré et un JWT invalide est refusé. Le JWT du pod et les refus d'accès croisé n'ont pas encore été testés en réel ; la SPEC n'est pas `DONE`.

## Résultat fonctionnel

Le portail reçoit un ensemble de paires `NOM=valeur` pour une application et un environnement (`dev` ou `prod`), l'enregistre dans OpenBao et garde une référence de version. Un nom identique en dev et prod désigne deux valeurs indépendantes. Le portail ne garde pas les valeurs en SQLite, Git, session navigateur, erreur ou journal.

| Hébergement choisi | Domaine source | Domaine supplémentaire |
| --- | --- | --- |
| Azure | OpenBao Azure | Aucun. |
| GCP SQLite dev/prod ou GCP PostgreSQL dev | OpenBao GCP | Aucun. |
| GCP PostgreSQL prod, secours AWS obligatoire dans le flux actuel | OpenBao GCP | OpenBao AWS, avec la même version logique validée avant publication. |

Le formulaire ne présente pas de choix de serveur OpenBao ni de nouvelle option de secours. Le routage découle exclusivement du choix d'hébergement, de données et d'environnement existant. Le chemin direct AWS n'est pas proposé par le formulaire actuel ; il n'est pas activé implicitement par cette SPEC. Les déploiements historiques restent inchangés tant qu'une migration explicite n'est pas demandée.

Pour Azure, le formulaire du portail reçoit temporairement la valeur avant son écriture dans OpenBao Azure. Cette décision explicite remplace, pour ce parcours, l'ancienne hypothèse de SPEC-014 selon laquelle le portail public ne manipulerait jamais une valeur privée. Le portail ne la persiste pas ; le transport jusqu'au domaine Azure est chiffré et authentifié.

## Contrat technique

- Un client OpenBao par domaine configuré par URL HTTPS, CA éventuelle, mount KV v2, méthode d'authentification et rôle. Les URLs et identités sont des paramètres de déploiement ; aucun compte cloud codé en dur.
- Chemins distincts par application et environnement. Le rôle OpenBao **du portail** a accès aux chemins des applications qu'il administre ; le portail vérifie l'appartenance avant l'appel. Les applications Azure ne reçoivent pas de token OpenBao : leurs identités Container Apps doivent être bornées à leur propre Key Vault d'environnement. Tester séparément ces deux frontières.
- KV v2 versionné avec écriture conditionnelle (CAS) pour empêcher qu'une mise à jour concurrente écrase une valeur plus récente. La version logique et les versions physiques par domaine sont consignées sans valeur secrète.
- Pour GCP PostgreSQL prod, la publication attend la présence vérifiée de la même révision logique dans GCP et AWS. Une écriture partielle reste non publiable et peut être reprise sans créer deux versions fonctionnelles différentes. Aucune réplication automatique d'OpenBao n'est présumée.
- Un refus, une indisponibilité ou une lecture incomplète empêche la publication concernée avec un message opérable, sans afficher de valeur. Les applications déjà publiées gardent leurs références existantes.
- Un jeu vide de variables préserve exactement le parcours de déploiement actuel et ne crée aucune dépendance OpenBao.

## Critères d'acceptation

1. Une écriture et une lecture autorisées rendent les noms et versions attendus, sans valeur dans les métadonnées du portail.
2. Une application, une équipe ou un environnement non autorisé ne peut ni lire ni modifier les variables d'un autre périmètre.
3. GCP SQLite et GCP PostgreSQL dev ne contactent ni ne créent de données dans OpenBao AWS ; Azure ne contacte que son domaine.
4. GCP PostgreSQL prod n'est publiable que si les versions attendues sont présentes dans les deux domaines.
5. Une panne OpenBao ou un conflit CAS est explicite et ne modifie pas une publication précédente.

## Préconditions fournies par le déploiement de la plateforme

Endpoint et CA de chaque domaine, montages KV v2, identités/permissions du portail, et connectivité depuis le portail. L'endpoint Azure est disponible ; sa connectivité depuis le pod reste à prouver. Aucune clé racine ou token permanent ne doit être transmis au code ou au chat. Pour tout changement Azure, respecter l'autorisation donnée après pull de `cluster` et refuser un plan qui modifie ou supprime l'existant ; aucun push protégé n'est implicite.
