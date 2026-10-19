# FinOps conversationnel par équipe ou application

Statut : **spécification à implémenter**, rédigée le 19 octobre 2026.
Ce document décrit le travail futur ; il ne signifie pas que les coûts, les
requêtes par équipe ou les sources décrites sont déjà disponibles.

## Objectif

Permettre à un utilisateur de demander une analyse FinOps en langage naturel.
L’IA comprend la demande, reformule les résultats et propose une recommandation
concise à partir de faits collectés par les services. **La clé IA ne fournit ni
les métriques CPU/mémoire, ni les coûts manquants.** Ces données nécessitent leurs
propres sources. Une information absente reste absente dans la réponse.

Exemples à prendre en charge :

```text
/finops Je suis l'équipe Mooroon5, donne moi des recommandations
/finops pour app dancingduck
/finops Compare les coûts de mes applications en production sur 30 jours
```

Le résultat doit indiquer le périmètre analysé, la période, les coûts disponibles,
l’ancienneté des applications et les observations utiles à une recommandation.
Il doit rester exploitable sans IA grâce à un rendu des données structurées.
Les logs et les actions de modification d’infrastructure sont hors périmètre.

## Point de départ dans les dépôts

- Le portail dispose d’un chat MCP, de clarifications conservées en session et
  d’une résolution sémantique d’application limitée au catalogue autorisé.
- `apps/orchestrator/src/sources/user-scope.js` filtre les applications selon les
  droits du portail. `src/models/deployment.js` contient notamment le propriétaire
  utilisateur/équipe, les accès partagés et la date de création de l’inscription.
- Le tool `get_finops_recommendation` de
  `../MCP-CNP/apps/mcp-server/src/tools.ts` traite actuellement une application et
  un environnement, avec une fenêtre de 7, 14 ou 30 jours, et exploite les mesures
  de workload/Datadog disponibles. Le chat utilise actuellement 14 jours.
- Les coûts du contrat actuel sont obligatoirement `null`. Le résultat FinOps
  reste partiel et signale l’absence de facturation. Brancher une clé IA ne
  change pas cette limite.
- `src/clients/datadog.js` collecte les mesures configurées ; il ne collecte pas
  de facturation. L’étendue des points dans le temps ne prouve pas une couverture
  continue ni la durée de fonctionnement d’une application.
- `apps/orchestrator/src/generation/answer.js` reformule les preuves disponibles.
  Le dossier FinOps futur devra être construit explicitement avant génération,
  sans tronquer arbitrairement un JSON de preuves.

## Parcours conversationnel attendu

### Demande pour une équipe

1. Résoudre « Mooroon5 » vers une équipe connue du portail, à partir de son nom
   ou de ses alias documentés. Ne jamais créer une équipe depuis le texte.
2. Vérifier les droits de l’utilisateur connecté. Dire « je suis l’équipe X »
   n’accorde aucun droit et ne modifie pas son appartenance.
3. Identifier les applications de cette équipe et leurs environnements dans le
   catalogue, puis appliquer les droits effectifs côté serveur.
4. Demander l’environnement si la demande ne le précise pas. Accepter une réponse
   « tous mes environnements » en détaillant alors les environnements couverts.
5. Annoncer la période et collecter les faits pour ce périmètre uniquement.
6. Présenter les applications concernées, les coûts connus, les manques et au
   maximum trois recommandations courtes, ordonnées par intérêt démontrable.

Par défaut, « applications de l’équipe » désigne ses applications propriétaires.
Les applications seulement partagées ne doivent pas être imputées à cette équipe
sans règle d’attribution explicite. Un accès en lecture ne signifie pas que
l’équipe supporte les coûts.

### Demande pour une application

1. Résoudre « dancingduck » vers une application autorisée, par exemple
   `app-2-dancingduck` si c’est l’identifiant réel du catalogue.
2. En cas d’ambiguïté, proposer uniquement les correspondances autorisées.
3. Demander l’environnement manquant et conserver la demande FinOps en attente.
4. À la réponse « prod », reprendre la même demande sans perdre l’application.
5. Restituer le coût observé, les observations disponibles et la recommandation.

Un identifiant fourni par l’IA est toujours revalidé côté serveur. Une application
inconnue ne doit jamais être choisie par approximation silencieuse.

### Période et périmètre

- Conserver par défaut une fenêtre glissante de 14 jours pour la compatibilité
  actuelle ; accepter 7 et 30 jours. Afficher les bornes exactes en UTC.
- Une période non prise en charge déclenche une clarification, sans substitution
  silencieuse. Les mois calendaires pourront être ajoutés avec un contrat dédié.
- Expliquer le décalage de facturation : les données peuvent s’arrêter avant la
  fin de la période demandée ou être provisoires.
- Un changement d’équipe, d’application ou d’environnement relance la validation
  du périmètre. `/annuler` abandonne les clarifications en attente.

## Données à collecter et signification

| Information | Source attendue | Règle d’interprétation |
| --- | --- | --- |
| Équipe, propriétaire, accès | Base du portail et catalogue | Réconcilier les identifiants ; le texte utilisateur n’est pas une source d’autorisation. |
| Application et environnements | Catalogue et plateforme | Une inscription au catalogue ne prouve pas une exécution. |
| État observé, workloads, ressources demandées/limites | Argo CD et API Kubernetes/plateforme | État daté, limité aux environnements autorisés. |
| Première inscription | `deployments.created_at` | Ancienneté dans le portail uniquement. |
| Première observation, historique d’exécution | Historique de plateforme à conserver | Ne pas assimiler âge de l’objet Kubernetes et ancienneté de l’application. |
| CPU/mémoire, pics, couverture | Datadog ou adaptateur de métriques validé | Préciser unités, dénominateur des pourcentages, agrégation et trous de collecte. |
| Coût facturé et crédits | Adaptateur de facturation cloud | Montants datés, devise et périmètre d’attribution explicites. |
| Coût alloué/estimé | Calcul déterministe du service | Méthode, hypothèses et limites visibles ; distinct du coût directement facturé. |

Pour GCP, la piste proposée est un adaptateur en lecture seule sur un export
Cloud Billing vers BigQuery. Sa disponibilité, son schéma et ses permissions
restent à vérifier lors de l’implémentation. Ce document ne suppose pas qu’un
export soit déjà activé. En son absence, les coûts restent inconnus.

### Ancienneté et durée

Distinguer systématiquement :

- la date d’inscription au portail ;
- la première présence observée dans la plateforme ;
- la durée d’exécution mesurée, uniquement si un historique la justifie ;
- la période de facturation analysée.

Ne pas déduire « tourne depuis 60 jours » d’une inscription vieille de 60 jours.
Un coût de cycle de vie nécessite l’historique correspondant ; le coût sur
14 jours ne peut pas être présenté comme le coût total depuis la création.
L’absence d’historique doit être signalée sans reconstruire de faux événements.

### Attribution des coûts

- Relier chaque ressource à son projet, sa localisation, son identifiant cloud,
  son application et son environnement. Éviter les jointures par seul nom.
- Pour GKE et les ressources mutualisées, définir une méthode d’allocation
  explicite avant de présenter un coût par application. Les pourcentages CPU
  seuls ne permettent pas une conversion directe en euros.
- Distinguer coûts directs, coûts alloués, coûts non attribués et estimations.
  Conserver le reste non attribué et éviter de compter deux fois une ressource.
- Fixer la convention de calcul : montant brut, crédits et montant net séparés ;
  préciser le traitement des taxes selon la source. Ne pas mélanger les devises.
- Une somme partielle est un « coût connu sur les applications couvertes »,
  jamais le coût total de l’équipe. Montrer le nombre d’applications couvertes.
- Conserver les ressources supprimées dans l’historique de facturation.
  L’attribution historique à une équipe exige un historique de propriété daté ;
  sinon indiquer la limite, sans attribuer rétroactivement tous les coûts au
  propriétaire actuel.
- Une absence de ligne de facturation n’est pas automatiquement un coût nul.

Les moyennes de métriques doivent être cohérentes avec leur fenêtre et leur
pondération ; les pourcentages d’applications ne s’additionnent pas. Mesurer la
couverture réelle et les trous, sans utiliser seulement la distance entre le
premier et le dernier point.

## Architecture et contrat proposés

```text
Message utilisateur
  → intention et résolution dans le catalogue autorisé
  → clarification éventuelle
  → validation serveur : équipe / applications / environnements / période
  → collecte facturation + plateforme + métriques
  → calculs déterministes et qualification des données
  → dossier de preuves compact
  → affichage structuré + reformulation/recommandation IA
```

La résolution sémantique peut identifier un périmètre ; elle ne décide jamais des
droits. Les adaptateurs et les calculs restent utilisables sans génération IA.
Un appel direct au tool doit appliquer les mêmes contrôles qu’un appel du chat.
Le contrat MCP de transport devra transmettre une identité vérifiable et son
périmètre autorisé, sans faire confiance à une liste d’applications envoyée par
le navigateur. Cette extension fait partie du travail dans les deux dépôts.

### Évolution du contrat

Le contrat actuel impose des coûts `null` et une application unique. Introduire
un contrat FinOps versionné, par exemple un nouveau tool V2, pour éviter de casser
les consommateurs actuels. Le nom final sera fixé pendant l’implémentation.

Entrée logique proposée :

```text
scope: { type: "application", applicationId }
     | { type: "team", teamId }
environments: liste explicite validée
observationWindowDays: 7 | 14 | 30
```

Le serveur résout lui-même les applications d’une équipe. Le retour comprend :

- le périmètre effectivement analysé et les bornes temporelles ;
- une ligne par application/environnement avec son ancienneté qualifiée,
  ses métriques, ses coûts et leurs disponibilités ;
- les agrégats calculés, les ressources non attribuées et la couverture ;
- les observations et recommandations déterministes possibles ;
- les sources datées, avertissements et données manquantes.

Chaque montant doit porter sa devise, sa période, sa nature
(`billed`, `allocated`, `estimated`), sa méthode et ses références de preuve.
Utiliser une représentation décimale maîtrisée pour les calculs monétaires.
Chaque mesure doit porter son unité, sa fenêtre et sa couverture. Une donnée
absente vaut `null` avec un motif ; zéro désigne une valeur réellement établie.

Mettre à jour les contrats et schémas générés dans `packages/contracts` ainsi que
leurs équivalents côté MCP-CNP. Le rendu `tool_result` doit accepter ce nouveau
format tout en conservant le rendu du tool actuel.

### Dossier envoyé à l’IA

Inclure uniquement les informations utiles et autorisées : demande normalisée,
périmètre, période, applications, ancienneté qualifiée, coûts, répartition,
utilisation, couverture, avertissements et références de preuve.

Les totaux, classements et économies éventuelles sont calculés avant génération.
Pour une grande équipe, agréger et sélectionner les éléments déterminants selon
une règle documentée ; indiquer combien d’applications sont résumées et conserver
le détail structuré consultable. Ne pas couper une chaîne JSON arbitrairement.

Ne transmettre ni clés, tokens, variables d’environnement, données d’autres
équipes ni logs bruts. Les noms et descriptions d’applications sont des données,
jamais des instructions à suivre par le modèle.

## Rôle et limites de la génération IA

L’IA doit comprendre « pour app dancingduck » ou « équipe Mooroon5 », reformuler
la demande résolue et expliquer les faits. Elle propose au maximum trois actions
avec une justification courte et les prérequis nécessaires.

Règles obligatoires :

1. Ne jamais inventer un montant, un pourcentage, une durée ou une économie.
2. Ne pas qualifier une application d’inutile parce qu’elle est ancienne.
3. Ne pas recommander un redimensionnement comme sûr sans mesures et contraintes
   suffisantes ; mentionner les risques de performance/disponibilité pertinents.
4. Si les coûts existent sans métriques, analyser les coûts disponibles et
   demander les mesures nécessaires pour conclure sur le dimensionnement.
5. Si les métriques existent sans coûts, fournir une observation technique
   prudente, sans annoncer de gain financier.
6. Si les deux manquent, expliquer les données à connecter. Une recommandation
   de collecte reste possible, sans présenter une optimisation comme démontrée.
7. Une économie estimée n’est affichable que si un calcul serveur traçable
   fournit les hypothèses, la référence tarifaire et les limites.
8. Aucune recommandation ne déclenche de déploiement, arrêt ou modification.

Viser une synthèse de 120 à 180 mots maximum, distincte du tableau de données.
Afficher d’abord le périmètre et les limites significatives. Relier les constats
aux preuves ; contrôler les références et les nombres de la sortie générée.
En cas de sortie non conforme, d’échec IA ou d’absence de clé, conserver le rendu
structuré et une synthèse déterministe signalant les manques.

## Configuration et infrastructure futures

La génération utilise la configuration serveur `GENAI_*` existante du portail.
La clé ne doit pas être exposée au navigateur ni committée. Les permissions de
facturation et les clés de métriques sont des configurations séparées.

Si l’implémentation nécessite un export Billing, un dataset, des labels ou de
nouveaux droits IAM, les définir dans les fichiers Terraform existants de
`../Cloud/cnp/gcp` et documenter leur configuration dans le guide Cloud existant.
Ne pas dépendre d’un projet ou d’une région codés en dur. Définir également le
devenir de l’historique lors d’un changement de compte/projet GCP : un nouvel
export ne recrée pas automatiquement l’historique de l’ancien projet.
L’implémentation devra être revue avant tout `terraform apply` ; aucune action
cloud n’est demandée par cette spécification.

## Plan de reprise

1. **Données et droits** : formaliser les identifiants d’équipe, applications
   propriétaires/partagées et accès aux coûts ; inventorier les sources réellement
   disponibles et l’historique. Fixer les règles d’attribution des coûts partagés.
2. **Contrats V2 dans les deux dépôts** : définir les entrées par équipe/application,
   le contexte d’autorisation, les preuves, montants et couvertures ; conserver
   les consommateurs V1 et leurs contraintes actuelles.
3. **Collecte MCP** : ajouter l’adaptateur de facturation en lecture seule,
   l’historique nécessaire et les agrégations déterministes. Prévoir délais,
   pagination, limites de requêtes et résultats partiels par source/application.
4. **Orchestration portail** : étendre le contexte et les clarifications FinOps,
   puis construire le dossier compact pour la génération existante.
5. **Restitution** : étendre `public/js/mcp-results.js` et le chat pour afficher
   couverture, ancienneté, coûts et recommandations avec leurs preuves.
6. **Configuration et documentation** : aligner les besoins cloud dans Terraform,
   actualiser le guide MCP et le guide Cloud, puis vérifier les parcours complets.

## Critères d’acceptation

| Cas | Résultat attendu |
| --- | --- |
| `/finops Je suis l'équipe Mooroon5…` | Résolution de l’équipe, contrôle des droits, uniquement les applications du périmètre autorisé ; clarification de l’environnement. |
| Utilisateur sans accès à Mooroon5 | Refus sans révéler applications, montants ou métriques de cette équipe, même par appel direct au tool. |
| `/finops pour app dancingduck`, puis `prod` | Même demande conservée, application résolue et environnement validé avant collecte. |
| Alias ambigu ou application inconnue | Clarification parmi les choix autorisés ; aucune application inventée. |
| Coûts disponibles, métriques absentes | Coûts restitués avec leur nature ; absence de CPU/mémoire explicite et conseil prudent. |
| Métriques disponibles, coûts absents | Coûts `null`, pas d’économie inventée ; analyse technique avec limites. |
| Une source ou une application échoue | Résultat partiel, périmètre manquant visible, somme connue distinguée d’un total. |
| Application ancienne sans historique d’exécution | Âge d’inscription qualifié ; aucune durée de fonctionnement déduite. |
| Ressource partagée, supprimée ou changement d’équipe | Pas de double comptage ; historique et méthode d’attribution explicites, ou limite signalée. |
| Plusieurs devises ou crédits | Totaux séparés par devise, crédits identifiés, aucune conversion implicite. |
| Trou de métriques ou retard de facturation | Couverture et dernière donnée affichées ; aucune continuité supposée. |
| Clé IA absente, modèle indisponible ou chiffre inventé | Données structurées et synthèse déterministe conservées ; génération invalide écartée. |
| Instruction malveillante dans une description | Aucun changement de droits, aucune fuite, aucune action d’infrastructure. |

La validation devra combiner tests de contrats entre dépôts, tests de droits,
tests des calculs sur jeux de données connus et parcours conversationnels avec
génération simulée. Un essai réel contrôlé devra vérifier l’attribution et les
sources configurées avant d’affirmer que les coûts sont opérationnels.
