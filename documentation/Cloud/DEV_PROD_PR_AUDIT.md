# Audit des PR de redman2004 — 25 octobre 2026

Recherche GitHub : `org:Mooroon5-CNP author:redman2004`, tous les états.
Les métadonnées et diffs des 14 résultats ont été consultés. Cette liste concerne
les dépôts accessibles de l'organisation, pas les autres projets personnels.

| Dépôt / PR | État constaté | Apport |
|---|---|---|
| [cnp-portal #8](https://github.com/Mooroon5-CNP/cnp-portal/pull/8) | Fusionnée | Sélecteur de cloud, GCP actif et refus des clouds non pris en charge. |
| [ci-templates #6](https://github.com/Mooroon5-CNP/ci-templates/pull/6) | Ouverte | Actions de détection, lint et test par langage, fixtures et tests de comportement. |
| [config-repo #21](https://github.com/Mooroon5-CNP/config-repo/pull/21) | Ouverte | Contrôle des paramètres Datadog, application de référence, secrets Datadog du portail. |
| [cnp-portal #6](https://github.com/Mooroon5-CNP/cnp-portal/pull/6) | Ouverte | Paramètres Datadog générés lors de l'onboarding. |
| [cnp-portal #7](https://github.com/Mooroon5-CNP/cnp-portal/pull/7) | Fermée, non fusionnée | Assistant authentifié en lecture seule. |
| [ci-templates #5](https://github.com/Mooroon5-CNP/ci-templates/pull/5) | Ouverte | Synchronisation de DD_VERSION avec la version de l'image. |
| [cnp-test-node #1](https://github.com/Mooroon5-CNP/cnp-test-node/pull/1) | Fusionnée | Logs JSON structurés et paramètres d'observabilité sur l'application de référence. |
| [cnp-portal #5](https://github.com/Mooroon5-CNP/cnp-portal/pull/5) | Fusionnée | Suppression de npm et des outils inutiles dans l'image finale ; documentation du risque tar embarqué. |
| [ci-templates #2](https://github.com/Mooroon5-CNP/ci-templates/pull/2) | Fusionnée | Lint et tests adaptés aux langages des applications. |
| [cnp-portal #4](https://github.com/Mooroon5-CNP/cnp-portal/pull/4) | Fusionnée | Override de tar pour corriger une vulnérabilité critique transitive. |
| [ci-templates #4](https://github.com/Mooroon5-CNP/ci-templates/pull/4) | Fusionnée | Version Hadolint figée pour rendre le lint reproductible. |
| [ci-templates #3](https://github.com/Mooroon5-CNP/ci-templates/pull/3) | Fusionnée | Suppression de références GitLab obsolètes dans les commentaires du lint YAML. |
| [config-repo #19](https://github.com/Mooroon5-CNP/config-repo/pull/19) | Fusionnée | Webhook GitHub et documentation alignés ; commentaires dev/prod actualisés. |
| [cnp-portal #3](https://github.com/Mooroon5-CNP/cnp-portal/pull/3) | Fusionnée | Retrait de GitLab, standardisation GitHub et correction du remplacement d'image après changement de projet GCP. |

Aucune de ces PR ne livre le sélecteur dev/prod complet, sa persistance, les
ressources Cloud Run indépendantes et la validation de production.

## Travaux connexes d'autres auteurs

- [cnp-portal #1](https://github.com/Mooroon5-CNP/cnp-portal/pull/1), ouverte lors
  du contrôle précédent : migration générale des écritures GitOps historiques
  vers le token d'installation de la GitHub App. L'implémentation des nouveaux
  environnements utilise directement ce client App ; elle ne fusionne pas cette
  PR ni ne prétend terminer sa migration générale.
- [config-repo #14](https://github.com/Mooroon5-CNP/config-repo/pull/14), fusionnée :
  seuls les pushes de `cnp-platform-bot[bot]` sont autorisés sous
  `apps/*/crossplane/prod/**`.
- [config-repo #6](https://github.com/Mooroon5-CNP/config-repo/pull/6) documente la
  limite : ce workflow révoque les écritures non autorisées après leur push.
  Il ne remplace pas une protection Git native avant écriture.

## Compatibilité recherchée

Le nouveau mode CI doit garder par défaut les promotions historiques. Le mode
`gitops_mode: portal` construit et scanne l'image puis laisse le portail publier
dev automatiquement ou préparer la PR de production pour un manager. La PR
de production est fusionnée via la GitHub App après validation du candidat.

Les PR d'observabilité ouvertes ne sont pas fusionnées par ce travail. Les
nouveaux manifests incluent néanmoins les paramètres d'environnement et de
version afin de conserver le contrat attendu lorsqu'elles seront intégrées.
