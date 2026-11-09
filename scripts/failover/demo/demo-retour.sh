#!/bin/bash
# Démonstration du retour vers GCP (soutenance), après demo-panne.sh : GCP revient, le voyant « GCP disponible » s'allume
# dans le portail, le manager clique « Revenir sur GCP », et le script suit le retour jusqu'à la surveillance rétablie.
#
#   ./demo-retour.sh [app]          (défaut : cnp-test-azure)
#
# Ce que fait le script :
#   1. vérifie que l'app est servie par AWS (worker AWS_ACTIVE) ; sinon il s'arrête sans rien toucher ;
#   2. après confirmation, retire la pause de la ressource Crossplane de la base : Crossplane redémarre Cloud SQL
#      (activation-policy ALWAYS, celle de Git). C'est le « retour » de GCP ;
#   3. attend que le worker ait joint et clôturé la base GCP (GCP_FENCED) : le voyant du portail s'allume ;
#   4. demande de cliquer « Revenir sur GCP » dans le portail, puis affiche une ligne à chaque changement ;
#   5. à la fin : relit les tâches (toutes celles écrites sur AWS doivent être sur GCP) et vérifie que l'écriture marche.
#
# Le retour lui-même n'est fait QUE par le portail (même chemin qu'en production) : ce script ne touche aucune base.
# Prérequis : kubectl (contexte du cluster GKE), gcloud, aws (compte 804210702561), curl, dig, python3.
set -euo pipefail

APP=${1:-cnp-test-azure}
PROJECT=cnp-terraform-512313
CONTEXT=gke_cnp-terraform-512313_europe-west9-b_cnp-cluster-terraform
URL=https://$APP.apps.mooroon5.fr
CR=$APP-prod-gcp-db

field() {
  aws dynamodb get-item --region eu-west-3 --table-name cnp-failover-platform-state --consistent-read \
    --key "{\"app\":{\"S\":\"$APP\"},\"record\":{\"S\":\"CONTROL\"}}" --query "Item.$1.S" --output text 2>/dev/null || echo '?'
}
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
titles() { curl -s --max-time 15 "$URL/api/todos" | python3 -c 'import json,sys; print("\n".join(sorted(t["title"] for t in json.load(sys.stdin))))'; }

step "Contrôles avant le retour ($APP)"
[ "$(aws sts get-caller-identity --query Account --output text)" = 804210702561 ] || { echo "Mauvais compte AWS."; exit 1; }
[ "$(field state)" = AWS_ACTIVE ] || { echo "L'app n'est pas servie par AWS (worker : $(field state)). Rien n'a été touché."; exit 1; }
INSTANCE=$(kubectl --context "$CONTEXT" get databaseinstances.sql.gcp.upbound.io "$CR" \
  -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}')
echo "worker : AWS_ACTIVE | Cloud SQL $INSTANCE : $(gcloud sql instances describe "$INSTANCE" --project "$PROJECT" --format='value(state,settings.activationPolicy)')"
BEFORE=$(titles)
echo "tâches servies par AWS : $(echo "$BEFORE" | grep -c . || true)"

step "Retour de GCP"
read -r -p "Redémarrer la base GCP de $APP (retrait de la pause Crossplane) ? (oui/non) " ANSWER
[ "$ANSWER" = oui ] || { echo "Annulé. Rien n'a changé."; exit 0; }
kubectl --context "$CONTEXT" annotate databaseinstances.sql.gcp.upbound.io "$CR" crossplane.io/paused- >/dev/null
T0=$(date +%s); echo "T0 = $(date '+%H:%M:%S') : Crossplane reprend la base."
for _ in $(seq 1 80); do
  SQL=$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT" --format='value(state)' 2>/dev/null || echo '?')
  FENCE=$(field source_fence)
  printf '+%3ds Cloud SQL=%s clôture=%s\n' $(( $(date +%s) - T0 )) "$SQL" "$FENCE"
  [ "$SQL" = RUNNABLE ] && [ "$FENCE" = GCP_FENCED ] && break
  sleep 15
done
[ "$(field source_fence)" = GCP_FENCED ] || { echo "GCP pas encore joint par le worker au bout de 20 min."; exit 1; }

step "Dans le portail : la page de l'app affiche « GCP disponible » (jusqu'à 1 min). Cliquer « Revenir sur GCP »."
read -r -p "Appuyer sur Entrée une fois le bouton cliqué… " _
T1=$(date +%s); last=""
for _ in $(seq 1 160); do
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/health" || true)
  STATE=$(field state)
  DNS=$(dig +short "$APP.apps.mooroon5.fr" A @8.8.8.8 | head -1)
  # Adresse du répartiteur GCP de la plateforme (profil gcp_lb_ip) ; l'ALB AWS répond sur des adresses qui alternent.
  [ "$DNS" = 34.54.71.90 ] && DNS=GCP || DNS=AWS
  NOW="HTTP=$HEALTH worker=$STATE dns=$DNS"
  if [ "$NOW" != "$last" ]; then printf '+%3ds %s %s\n' $(( $(date +%s) - T1 )) "$(date +%H:%M:%S)" "$NOW"; last=$NOW; fi
  [ "$STATE" = WAIT_SIGNALS ] && [ "$HEALTH" = 200 ] && [ "$DNS" = GCP ] && break
  sleep 15
done
[ "$(field state)" = WAIT_SIGNALS ] || { echo "Surveillance pas encore rétablie au bout de 40 min ; voir le portail."; exit 1; }
echo "Retour terminé en $(( ($(date +%s) - T1) / 60 )) min $(( ($(date +%s) - T1) % 60 )) s ; secours AWS reconstruit, surveillance rétablie."

step "Preuves"
AFTER=$(titles)
if [ -z "$(comm -23 <(echo "$BEFORE") <(echo "$AFTER"))" ]; then echo "✅ toutes les tâches servies par AWS sont sur GCP : aucune perte"
else echo "❌ tâches absentes de GCP :"; comm -23 <(echo "$BEFORE") <(echo "$AFTER"); fi
echo "écriture sur GCP : $(curl -s --max-time 15 -X POST -H 'Content-Type: application/json' \
  -d "{\"title\": \"écrit sur GCP après le retour $(date '+%H:%M:%S')\"}" "$URL/api/todos")"
echo "base : $(curl -s --max-time 10 "$URL/info")"
