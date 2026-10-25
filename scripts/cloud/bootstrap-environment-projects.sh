#!/usr/bin/env bash
# Préparer uniquement les AppProjects ; ne pas activer les scanners globaux d'apps.
set -euo pipefail

usage() {
  echo "Usage: $0 --project ID --cluster NAME --location ZONE_OR_REGION --config-repo PATH [--apply]" >&2
}
project_id=""; cluster_name=""; cluster_location=""; config_repo=""; apply=false
while (($#)); do
  case "$1" in
    --project|--cluster|--location|--config-repo)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --project) project_id="$2" ;;
        --cluster) cluster_name="$2" ;;
        --location) cluster_location="$2" ;;
        --config-repo) config_repo="$2" ;;
      esac
      shift 2 ;;
    --apply) apply=true; shift ;;
    --help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[[ -n "$project_id" && -n "$cluster_name" && -n "$cluster_location" && -n "$config_repo" ]] || { usage; exit 2; }
for environment in dev prod; do
  [[ -f "$config_repo/argocd/projects/team-cnp-$environment.yaml" ]] || {
    echo "AppProject absent : $config_repo/argocd/projects/team-cnp-$environment.yaml" >&2
    exit 2
  }
done

# Le contexte personnel de l'opérateur reste inchangé.
cnp_kubeconfig=$(mktemp)
trap 'rm -f -- "$cnp_kubeconfig"' EXIT
export KUBECONFIG="$cnp_kubeconfig"
gcloud container clusters get-credentials "$cluster_name" --project "$project_id" --location "$cluster_location"
for environment in dev prod; do
  kubectl apply --dry-run=server -f "$config_repo/argocd/projects/team-cnp-$environment.yaml"
done
if "$apply"; then
  for environment in dev prod; do
    kubectl apply -f "$config_repo/argocd/projects/team-cnp-$environment.yaml"
  done
else
  echo "Validation terminée. Ajouter --apply pour créer ou mettre à jour les deux AppProjects."
fi
