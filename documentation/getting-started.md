# Prise en main — CNP Portal

## Prérequis

- Un compte GitHub avec accès à l'organisation `Mooroon5-CNP`
- Une invitation envoyée par un `manager` CNP

## Connexion

1. Rendez-vous sur l'URL du portail CNP
2. Cliquez sur **Se connecter avec GitHub**
3. Autorisez l'application OAuth CNP Portal sur GitHub
4. Votre compte est créé en attente de validation : un `manager` ou `devops` doit l'approuver depuis **Admin → Utilisateurs**
5. Une fois approuvé, vous êtes redirigé vers le dashboard

Votre rôle initial est `dev`. Un `manager` peut le modifier depuis l'interface Admin.

## Rôles disponibles

| Rôle | Description |
|------|-------------|
| `manager` | Accès complet, gestion des utilisateurs et des droits |
| `devops` | Opérations infrastructure, CI/CD, K8s, observabilité |
| `dev` | Déploiement de ses propres apps, lecture des métriques |

## Premier déploiement

1. Allez dans **Déploiements → + Nouveau déploiement**
2. Renseignez l'URL de votre dépôt GitHub (`https://github.com/org/mon-app`), le nom de l'application et son port
3. Choisissez l'équipe propriétaire et le cloud cible
4. Validez : le portail ajoute le workflow GitHub Actions dans votre dépôt et crée les manifests dans `config-repo`

À chaque push sur `main`, le pipeline GitHub Actions construit l'image, la pousse dans Artifact Registry et met à jour `config-repo` ; ArgoCD synchronise ensuite le déploiement. Voir [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) pour le détail.

## Accès Datadog / ArgoCD

Si vous n'avez pas accès à ces outils, utilisez les formulaires de demande d'accès dans les sections correspondantes. Un manager sera notifié pour approuver votre demande.
