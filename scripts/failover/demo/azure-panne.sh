#!/bin/bash
# Démonstration de la bascule AUTOMATIQUE Azure (option C, soutenance) : vraie panne du serveur France de la prod d'une app,
# bascule automatique vers la copie en Italie, puis retour automatique en France une fois le serveur revenu.
#
#   ./azure-panne.sh [app]          (défaut : cnp-demo)
#
# Ce que fait le script :
#   1. vérifie l'état de départ (app saine, alias sur la France) ; sinon il s'arrête sans rien toucher ;
#   2. après confirmation, ARRÊTE le serveur PostgreSQL France de la prod (az postgres flexible-server stop) ;
#   3. attend que le job de réplication bascule l'alias sur l'Italie (environ 2 min), puis que l'app réponde de nouveau ;
#   4. redémarre le serveur France et attend le retour automatique (environ 15 min : la France doit d'abord recopier
#      l'Italie puis rester répliquée 10 min) ;
#   5. pour l'app de démo (API /api/todos), écrit une ligne avant, pendant et après la panne et les relit à la fin.
#
# La bascule et le retour sont faits par le job (cnp-sov-fr-dbrepl, CNP_AUTO_FAILOVER=true) : ce script ne touche ni aux
# bases ni à l'alias. Il n'arrête que le serveur France, et le redémarre. Interrompu : relancer le serveur à la main
# (az postgres flexible-server start -g cnp-sov-fr-rg -n <serveur>).
# Prérequis : az (abonnement Azure de la plateforme), curl, python3. Bascule automatique activée (azure/terraform.tfvars).
set -uo pipefail

APP=${1:-cnp-demo}
RG=${CNP_AZURE_RG:-cnp-sov-fr-rg}
ZONE_RG=${CNP_AZURE_ZONE_RG:-cnp-sov-shared-rg}
ZONE=cnp-sov.postgres.database.azure.com
URL=https://$APP.${CNP_PUBLIC_DOMAIN:-eu.mooroon5.fr}

log() { printf '%s %s\n' "$(date +%T)" "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
FR=$(az postgres flexible-server list -g "$RG" --query "[?tags.\"cnp-app\"=='$APP' && tags.\"cnp-env\"=='prod' && tags.\"cnp-role\"=='app-db'].name | [0]" -o tsv 2>/dev/null)
[ -n "$FR" ] || { echo "Serveur France de la prod de $APP introuvable."; exit 1; }
alias_target() { az network private-dns record-set cname show -g "$ZONE_RG" -z "$ZONE" -n "$APP-prod-db" --query cnameRecord.cname -o tsv 2>/dev/null | cut -d. -f1; }
reason() { az network private-dns record-set cname show -g "$ZONE_RG" -z "$ZONE" -n "$APP-prod-db" --query metadata.reason -o tsv 2>/dev/null; }
health() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/health"; }
where() { curl -s --max-time 10 "$URL/where" | python3 -c 'import json,sys; w=json.load(sys.stdin); print("base en", w.get("database_country") or "?")' 2>/dev/null || echo "bandeau indisponible"; }
DEMO=$([ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/todos")" = 200 ] && echo 1 || echo 0)
write() {
  [ "$DEMO" = 1 ] || return 0
  for _ in 1 2 3 4 5 6; do
    curl -s --max-time 15 -X POST -H 'Content-Type: application/json' -d "{\"title\":\"$1\"}" "$URL/api/todos" | grep -q '"id"' \
      && { log "écrit : $1"; return 0; }
    sleep 10
  done
  log "ÉCHEC d'écriture : $1"
}

step "État de départ"
log "app=$APP  serveur France=$FR  adresse=$URL"
log "alias=$(alias_target)  health=$(health)  $(where)"
[ "$(alias_target)" = "$FR" ] && [ "$(health)" = 200 ] || { echo "Départ inattendu (alias pas sur la France ou app pas saine). Rien n'a été touché."; exit 1; }
read -r -p "Arrêter le serveur France de la prod de $APP (vraie panne, écritures coupées ~2 min) ? [o/N] " ok
[ "$ok" = o ] || { echo "Abandon, rien n'a été touché."; exit 0; }
write "démo C — avant la panne (France)"

step "Panne : arrêt du serveur France"
az postgres flexible-server stop -g "$RG" -n "$FR" -o none 2>/dev/null; T0=$(date +%s)
log "serveur France : $(az postgres flexible-server show -g "$RG" -n "$FR" --query state -o tsv 2>/dev/null)"
until [ "$(alias_target)" != "$FR" ]; do
  [ $(( $(date +%s) - T0 )) -gt 1200 ] && { log "Pas de bascule après 20 min : bascule automatique activée ? Serveur à redémarrer à la main."; exit 2; }
  log "  en attente de la bascule automatique (health=$(health))"; sleep 20
done
log "BASCULE AUTOMATIQUE vers $(alias_target) après $(( $(date +%s) - T0 )) s (raison : $(reason))"
until [ "$(health)" = 200 ]; do sleep 5; done
log "app de nouveau saine après $(( $(date +%s) - T0 )) s — $(where)"
write "démo C — pendant la panne (Italie)"

step "Retour : redémarrage du serveur France"
az postgres flexible-server start -g "$RG" -n "$FR" -o none 2>/dev/null; T1=$(date +%s)
log "serveur France : $(az postgres flexible-server show -g "$RG" -n "$FR" --query state -o tsv 2>/dev/null)"
until [ "$(alias_target)" = "$FR" ]; do
  [ $(( $(date +%s) - T1 )) -gt 2400 ] && { log "Pas de retour après 40 min (azure-bascule.sh status $APP pour voir où en est la réplication)."; exit 3; }
  sleep 60; log "  en attente du retour automatique (la France recopie l'Italie, puis 10 min de réplication stable)"
done
log "RETOUR AUTOMATIQUE en France $(( $(date +%s) - T1 )) s après le redémarrage (raison : $(reason))"
sleep 40
write "démo C — de retour en France"

step "Bilan"
log "alias=$(alias_target)  health=$(health)  $(where)"
[ "$DEMO" = 1 ] && curl -s "$URL/api/todos" | python3 -c 'import json,sys; [print("   ", t["id"], t["title"]) for t in json.load(sys.stdin)]'
