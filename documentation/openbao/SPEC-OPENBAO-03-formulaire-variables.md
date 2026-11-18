# SPEC-OPENBAO-03 — Variables dans le formulaire de déploiement

**Ordre : 3/3, dernière SPEC à implémenter pour ce parcours.** Dépend des SPEC-OPENBAO-01 et 02 et de leurs tests hors interface.

**Statut : IMPLÉMENTÉ LOCALEMENT, ACCEPTATION À FAIRE (15/11/2026).** Interface et validation serveur implémentées sur `feat/OpenBao-Vault`, tests locaux passés. La démonstration d'acceptation sur les trois clouds reste à effectuer après installation des instances et des identités décrites dans `instances_openBao.md` ; la SPEC n'est pas `DONE`.

## Parcours utilisateur

Dans le formulaire « Nouveau déploiement », après le choix application, environnement et hébergement, une section « Variables d'environnement » permet de :

1. Ajouter manuellement autant de lignes `NOM` / `valeur` que nécessaire ; supprimer ou corriger une ligne avant envoi.
2. Importer un fichier `.env` local ; le portail détecte les lignes `NOM=valeur`, ignore lignes vides et commentaires, et montre une prévisualisation des **noms**, du nombre de variables et des conflits, avec valeurs masquées.
3. Combiner import et saisie manuelle. Un doublon demande une résolution explicite ; aucune valeur n'est écrasée silencieusement.
4. Appuyer sur « Déployer » : les variables sont enregistrées dans le ou les domaines OpenBao déterminés automatiquement par le mode existant (Azure, GCP SQLite, GCP PostgreSQL dev ou GCP PostgreSQL prod avec secours AWS), puis la procédure de déploiement habituelle reprend.

Le formulaire ne demande pas à l'utilisateur de sélectionner une instance OpenBao et n'ajoute aucune nouvelle option de secours. Le choix GCP PostgreSQL en production garde son secours AWS obligatoire ; le comportement des autres modes reste identique.

## Validation et confidentialité

- Accepter les noms `[A-Za-z_][A-Za-z0-9_]*` avec comparaison sensible à la casse, sous réserve des noms réservés par la plateforme (`PORT`, `DB_*`, `DD_*`, `CNP_*`, etc.) ; refuser les noms réservés au serveur et au client.
- Fichier `.env` UTF-8 de taille bornée. Gérer `export NOM=valeur`, valeurs vides, guillemets et commentaires selon une grammaire documentée ; refuser les substitutions de shell, doublons ambigus, lignes malformées et encodage invalide. Ne jamais exécuter le fichier.
- Ne pas déposer le `.env` sur disque ni dans Git ; ne pas conserver les valeurs en session, dans un brouillon, dans une URL ou dans un message flash. Sur erreur, redemander les valeurs sensibles sans les réafficher.
- Contrôler les droits de déploiement et l'appartenance de l'application avant l'écriture des valeurs. Le serveur revalide taille, noms et conflits indépendamment du navigateur.
- Une absence de variables reste un chemin valide et identique au formulaire actuel.

## Démonstration d'acceptation

Déployer une application témoin dont une route vérifie la présence et la valeur attendue de variables fictives **sans les afficher**. Saisir une variable manuellement et en importer une seconde depuis `.env`, déployer, constater que l'application les lit après démarrage et redémarrage, puis répéter pour Azure, GCP sans secours et GCP avec secours AWS. Vérifier les domaines OpenBao ciblés, l'absence de valeurs dans Git/logs et la persistance de la validation manager en prod. Ne pas utiliser une vraie clé dans cette démonstration.
