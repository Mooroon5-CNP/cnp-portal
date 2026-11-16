# Cohabitation des applications historiques et des environnements dev/prod

Les applications récentes utilisent les scanners `crossplane-autodiscovery-dev`
et `crossplane-autodiscovery-prod`. Leurs chemins GitOps restent distincts :

- `apps/<app>/crossplane/dev` → `<app>-dev` ;
- `apps/<app>/crossplane/prod` → `<app>-prod`.

Le scanner historique `cloudrun-autodiscovery` est conservé pour les applications
qui ont un véritable manifeste à la racine `apps/<app>/crossplane`. Il découvre
désormais les fichiers racine, et non tous les dossiers parents :

```yaml
files:
  - path: apps/*/crossplane/kustomization.yaml
  - path: apps/*/crossplane/*/kustomization.yaml
    exclude: true
```

L’exclusion explicite des sous-dossiers évite de reprendre les environnements
dev/prod, y compris avec le comportement historique des globs du générateur Git.
Les templates du scanner historique restent inchangés.

Le portail ne crée plus de `kustomization.yaml` parent vide à l’enregistrement.
Les protections contre l’adoption d’un ancien déploiement et contre l’écrasement
de manifests existants restent actives. Le nettoyage sait encore retirer les
anciens parents vides lors de la suppression du dernier environnement.

## Migration du 10 novembre 2026

Modification autorisée de `config-repo`, commit
`d2bc79244114eee70971e4c05cd31445fe912ebd` : changement du scanner historique et
retrait du seul parent vide de `app-2-dancingduck`. Aucun manifeste dev/prod ni
aucun scanner dev/prod n’a été modifié.

Avant le retrait, l’application `app-2-dancingduck-cloudrun` ne déclarait aucune
ressource, et le parent contenait strictement `resources: []`. Après la mise à
jour du scanner et son rafraîchissement, l’entrée historique a disparu.
L’application `app-2-dancingduck-dev` a conservé son UID et ses ressources.

Pour une autre application, vérifier le contenu du manifeste parent et les
ressources de l’application historique avant tout retrait. Un manifeste vide
ne suffit pas à prouver qu’aucune ressource n’est encore gérée côté cluster.

La correction du scanner est appliquée dans Git et dans le cluster. La correction
du portail doit être incluse dans la version du portail utilisée pour les futurs
enregistrements ; une ancienne version peut encore créer des parents vides.
