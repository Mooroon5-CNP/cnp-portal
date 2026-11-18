#!/bin/bash
# Bascule de la base de prod d'une app Azure entre son serveur France et son serveur de copie (Italie), à la main.
#
#   ./azure-bascule.sh status                     état de la réplication de toutes les apps de prod (lecture seule)
#   ./azure-bascule.sh switch   <app>             bascule planifiée sans perte (vers l'autre serveur ; retour compris)
#   ./azure-bascule.sh failover <app>             bascule quand le serveur actif ne répond plus
#
# Le moteur (engine/azure_replication.py) tourne dans le job Azure cnp-sov-fr-dbrepl (azure/14-db-replication.tf). Ce
# script lance UNE exécution ponctuelle de ce job avec d'autres arguments, attend sa fin et affiche son journal : seule
# l'identité du job a les mots de passe (Key Vault) et l'accès au réseau privé des serveurs. Aucun secret ne transite ici.
#
# `az containerapp job start --args` ne convient pas : il remplace tout le gabarit du job. On relit donc le gabarit et on
# ne change que les arguments du conteneur (appel REST .../start).
# Prérequis : az (connecté à l'abonnement Azure de la plateforme), python3.
set -euo pipefail

SUBSCRIPTION=${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}
RG=${CNP_AZURE_RG:-cnp-sov-fr-rg}
JOB=${CNP_AZURE_REPLICATION_JOB:-cnp-sov-fr-dbrepl}
WORKSPACE=${CNP_AZURE_WORKSPACE:-cnp-sov-fr-law}
API=2024-03-01
URL="https://management.azure.com/subscriptions/$SUBSCRIPTION/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB"

case "${1:-}" in
  status) ARGS='["status"]' ;;
  switch|failover)
    [ -n "${2:-}" ] || { echo "usage : $0 $1 <app>" >&2; exit 2; }
    [[ "$2" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] || { echo "nom d'app invalide : $2" >&2; exit 2; }
    ARGS="[\"$1\", \"$2\"]" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac

BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
az rest --method get --url "$URL?api-version=$API" | ARGS="$ARGS" python3 -c '
import json, os, sys
tpl = json.load(sys.stdin)["properties"]["template"]
for c in tpl["containers"]:
    if c["name"] == "replication":
        c["args"] = json.loads(os.environ["ARGS"])
json.dump({"containers": tpl["containers"], "initContainers": tpl.get("initContainers") or []}, sys.stdout)' > "$BODY"

EXECUTION=$(az rest --method post --url "$URL/start?api-version=$API" --body @"$BODY" --query name -o tsv)
echo "$(date +%T)  exécution $EXECUTION : $ARGS"
while :; do
  STATUS=$(az containerapp job execution show -g "$RG" -n "$JOB" --job-execution-name "$EXECUTION" --query properties.status -o tsv 2>/dev/null || true)
  case "$STATUS" in Succeeded|Failed|Stopped) break ;; esac
  sleep 5
done
echo "$(date +%T)  $STATUS"

# Les journaux arrivent dans Log Analytics avec 30 s à 2 min de retard. Deux tables possibles : ContainerAppConsoleLogs_CL
# (envoi direct, avant le 16/11) et ContainerAppConsoleLogs (paramètre de diagnostic, depuis l'envoi des logs à Datadog,
# cnp azure/17-datadog-logs.tf). La requête lit les deux ; isfuzzy tolère celle qui n'existe pas.
WS=$(az monitor log-analytics workspace show -g "$RG" -n "$WORKSPACE" --query customerId -o tsv)
for _ in $(seq 1 12); do
  LOGS=$(az monitor log-analytics query -w "$WS" --analytics-query \
    "union isfuzzy=true (ContainerAppConsoleLogs_CL | project TimeGenerated, Group=ContainerGroupName_s, Line=Log_s), (ContainerAppConsoleLogs | project TimeGenerated, Group=ContainerGroupName, Line=Log) | where Group startswith '$EXECUTION' | order by TimeGenerated asc | project Line" -o tsv 2>/dev/null || true)
  [ -n "$LOGS" ] && break
  sleep 10
done
echo "${LOGS:-(journal pas encore disponible : relancer la requête dans une minute)}"
[ "$STATUS" = Succeeded ]
