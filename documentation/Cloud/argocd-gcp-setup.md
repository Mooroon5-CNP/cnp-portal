# Connexion du portail à Argo CD

Suivre [la procédure Cloud complète](Cloud/README.md). Ce fichier conserve son nom
pour préserver les références existantes ; les commandes sont centralisées dans
le guide Cloud.

Le portail accepte le token existant ou le login généré par Terraform. Les comptes
humains utilisent séparément les permissions Kubernetes sur `argocd-cm` et
`argocd-secret`. Le guide explique le tunnel actuel, le futur LoadBalancer, la
régénération des identifiants et le contrôle `npm run cloud:check`.
