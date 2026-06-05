# Prise en main — CNP Portal

## Prérequis

- Un compte GitLab.com avec accès à l'organisation CNP
- Une invitation envoyée par un `manager` CNP

## Connexion

1. Rendez-vous sur l'URL du portail CNP
2. Cliquez sur **Se connecter avec GitLab**
3. Autorisez l'application OAuth CNP Portal sur GitLab
4. Vous êtes redirigé automatiquement vers le dashboard

Votre rôle initial est `dev`. Un `manager` peut le modifier depuis l'interface Admin.

## Rôles disponibles

| Rôle | Description |
|------|-------------|
| `manager` | Accès complet, gestion des utilisateurs et des droits |
| `devops` | Opérations infrastructure, CI/CD, K8s, observabilité |
| `dev` | Déploiement de ses propres apps, lecture des métriques |

## Premier déploiement

1. Allez dans **Déploiements → Nouveau déploiement**
2. Sélectionnez votre repo GitLab (connecté via OAuth)
3. Choisissez la branche cible (par défaut: `main`)
4. Cliquez sur **Déclencher le déploiement**

Le pipeline GitLab CI/CD associé à votre repo sera automatiquement déclenché.

## Accès Datadog / ArgoCD

Si vous n'avez pas accès à ces outils, utilisez les formulaires de demande d'accès dans les sections correspondantes. Un manager sera notifié pour approuver votre demande.
