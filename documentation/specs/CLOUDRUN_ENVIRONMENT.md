# Variables d’application — décision et implémentation

> Proposition suivante, en attente de validation : [OpenBao cible et bucket transitoire](APPLICATION_VARIABLES_OPENBAO.md). Elle ne modifie pas le code actuel ni sa configuration.

Décision approuvée par l’utilisateur : parcours Application → Variables →
Récapitulatif → Déployer, analogue aux plateformes self-service. GCP conserve
Cloud Run via ArgoCD/Crossplane ; aucun choix Kubernetes/Cloud Run. Aucun import
.env obligatoire. Branche locale fix/cloudrun-environment, aucun push/merge main.

## Expérience développeur

1. Application : dépôt, nom, port, dev/prod et cloud, puis Suivant.
2. Variables : Ajouter une variable, saisir nom/valeur, supprimer une ligne ou
   afficher/masquer sa valeur. Les valeurs multilignes sont disponibles via le
   bouton Multiligne ; un collage multiligne est conservé sans écraser les retours
   à la ligne. Aucune variable obligatoire. Première version :
   variables au démarrage Cloud Run GCP, toutes traitées comme des secrets.
3. Récapitulatif : configuration et noms/actions des variables, jamais les valeurs
   secrètes. Précédent conserve la saisie. Déployer effectue la demande finale.

Le développeur n’a aucune commande GCP à exécuter. La plateforme vérifie sa propre
identité, ses permissions et l’activation des API avant d’accepter les variables.
Si elle n’est pas prête, l’interface l’indique avant validation finale. Même en
contournant l’interface, un échec du fournisseur ne crée pas de demande bloquée.
Un déploiement sans variable n’appelle pas le stockage de secrets.
Les champs restent en mémoire du formulaire après une erreur de soumission,
pour réessayer ; ils sont effacés à la fermeture, à la navigation et au succès.
Aucune conservation dans localStorage, cookies ou session serveur.

Le détail d’une application présente les noms des variables et un éditeur réservé
au propriétaire ou manager : garder, remplacer, ajouter, supprimer. Les valeurs
existantes ne sont pas renvoyées. Les modifications lancent une nouvelle CI dans
ce MVP ; les candidats prod restent soumis à l’approbation manager existante.
Les variables de build et Azure additionnelles sont hors périmètre de cette version.

## Contrat technique et sécurité

- Limites : 100 variables, nom 128 caractères, valeur 32 Kio, total 64 Kio.
- Clés uniques, syntaxe portable, chaînes sans caractère nul ; valeurs vides
  autorisées et indiquées dans le récapitulatif. Une valeur vide, sans contenu
  secret, est représentée par value=''; toute valeur non vide passe par Secret Manager.
- PORT/HOST/DATA_DIR/DD_ENV/DD_SERVICE/DD_VERSION/LOG_LEVEL sont réservées.
- HTTPS requis, sauf localhost en développement. Contrôles d’origine et de droits
  appliqués avant les écritures, y compris sur l’API.
- Secret Manager : un secret par clé/déploiement, version numérique figée.
  Aucune valeur secrète dans SQLite, GitOps, image, CI, erreurs HTTP ou logs applicatifs.
- Compte runtime distinct par déploiement recevant des secrets ; accès à ses seuls
  secrets. Crossplane peut agir en son nom. Le bucket éventuel suit cette identité.
- Compte de contrôle du portail distinct du compte partagé des applications.
  La vérification refuse le compte partagé et les ADC personnels en production.
- SQLite contient uniquement les références, l’identité et les suppressions.
  Une suppression empêche qu’une ancienne référence opérateur réapparaisse.
- Versions immutables : remplacer une valeur n’altère pas la version servant une
  production déjà approuvée. GitOps décrit un candidat reproductible.
- Un verrou renouvelable en base sérialise les modifications et bloque une
  publication concurrente. Un échec du déclenchement CI restaure les références
  précédentes. Les écritures cloud non publiées peuvent laisser des versions
  orphelines à nettoyer par l’opérateur.
- Les secrets et identités cloud ne sont pas détruits automatiquement lors de la
  suppression d’une application ; récupération/rotation relève de l’opérateur.
- Les anciennes références et comptes existants sont conservés. Aucune migration
  de service ni reprise implicite d’un enregistrement Kubernetes expérimental.

## Prérequis opérateur

Voir APPLICATION_VARIABLES_SETUP.md. La vérification des droits/API ne constitue
pas un essai complet de démarrage : une application de démonstration doit être
validée avant généralisation. Les tests locaux simulent les fournisseurs Google.
Le diagnostic réel de ce sandbox retourne PLATFORM_IDENTITY_UNAVAILABLE ; aucune
configuration GCP réelle n’y a été modifiée ni déclarée fonctionnelle.

Les anciens incidents SESSION_SECRET/ADMIN_INITIAL_PASSWORD concernaient le
bootstrap du portail ; leurs corrections de génération automatique restent dans
la base de la branche. OAuth requiert toujours les identifiants propres à
l’application et une URL de callback correspondant à son adresse publique.

Sources de conception :
- https://render.com/docs/configure-environment-variables
- https://docs.railway.com/variables
- https://docs.cloud.google.com/run/docs/configuring/services/secrets
- https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/testIamPermissions

## Évidence locale

- 316 tests sur 42 suites passent, avec fournisseurs simulés. Les cinq suites
  historiques qui ouvrent des sockets restent exclues dans ce sandbox.
- ESLint et compilation de 26 templates EJS passent.
- Tests du wizard (suivant/précédent, récapitulatif sans valeurs, conservation de
  la saisie sur échec), HTTP réel en mémoire, SQLite, leases, refus des écritures
  non autorisées/HTTP non sûr, versions figées, isolation des identités, état des
  API, absence de demande bloquée après échec du fournisseur et garde prod.
- Diagnostic réel local : PLATFORM_IDENTITY_UNAVAILABLE. Aucun essai Google de
  création/lecture de secrets ni déploiement cloud réel, aucun push/merge main.

Commande de validation locale :

```sh
npm run lint
npm test -- --runInBand --testPathIgnorePatterns 'deployment-environment-routes|azure-route|index.test|mcp-user-access|argocd-sync-route'
```


## Import facultatif de variables

L’éditeur propose un fichier `.env` ou `.txt` au format `NOM=valeur`, lu localement
par le navigateur (256 Kio maximum). Commentaires, préfixe `export`, valeurs vides,
valeurs entre guillemets et multilignes sont acceptés. Aucune expression shell ou
référence à une autre variable n’est évaluée. Un nom déjà présent est remplacé ;
les valeurs restent masquées et modifiables avant confirmation. Les noms réservés sont ignorés et signalés sans bloquer les autres variables.
Les doublons dans le fichier et les limites de variables sont rejetés avant
modification du formulaire. Les lignes vides du formulaire sont retirées lors d’un import valide. Le fichier lui-même n’est pas envoyé au serveur ; les
variables suivent le même stockage sécurisé que la saisie manuelle.


### Navigation et disponibilité du stockage

Le bouton Suivant valide les champs puis ouvre le récapitulatif indépendamment
de la disponibilité de Secret Manager. La disponibilité reste nécessaire pour
Déployer avec des variables : un message visible explique le blocage et invite à
revenir à Variables pour consulter le diagnostic et relancer la vérification.
La validation serveur et le refus de transmettre les valeurs sans stockage
sécurisé sont conservés.
