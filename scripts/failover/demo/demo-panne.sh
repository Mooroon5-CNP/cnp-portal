#!/bin/bash
# Démonstration de bascule (soutenance) : panne réelle de la base GCP d'une app failover, puis suivi jusqu'à ce que l'app
# réponde depuis AWS, et preuve qu'aucune écriture n'est perdue. Reprend exactement le scénario du G7 réussi le 06/11/2026.
#
#   ./demo-panne.sh [app]          (défaut : cnp-test-azure)
#
# Ce que fait le script :
#   1. vérifie que l'app est saine sur GCP et que le worker surveille (WAIT_SIGNALS) ; sinon il s'arrête sans rien toucher ;
#   2. écrit une tâche « témoin » dans l'app (donc dans Cloud SQL) ;
#   3. après confirmation, met la ressource Crossplane de la base en pause (sinon Crossplane la redémarrerait aussitôt)
#      et arrête l'instance Cloud SQL (activation-policy NEVER) : c'est la panne ;
#   4. affiche une ligne à chaque changement : réponse HTTP, alarme, état du worker, DNS, base qui répond ;
#   5. une fois l'app servie par AWS : relit le témoin (aucune perte) et écrit une nouvelle tâche (AWS accepte les écritures).
#
# ÉTAT LAISSÉ : l'app vit sur AWS, Cloud SQL est arrêtée et sa ressource Crossplane en pause. Retour vers GCP :
# ./demo-retour.sh (redémarre la base, puis le manager clique « Revenir sur GCP » dans le portail).
# Prérequis : gcloud, kubectl (contexte du cluster GKE), aws (compte 804210702561), curl, dig, python3.
set -euo pipefail

APP=${1:-cnp-test-azure}
PROJECT=cnp-terraform-512313
CONTEXT=gke_cnp-terraform-512313_europe-west9-b_cnp-cluster-terraform
URL=https://$APP.apps.mooroon5.fr
CR=$APP-prod-gcp-db

state() {
  aws dynamodb get-item --region eu-west-3 --table-name cnp-failover-platform-state --consistent-read \
    --key "{\"app\":{\"S\":\"$APP\"},\"record\":{\"S\":\"CONTROL\"}}" --query 'Item.state.S' --output text 2>/dev/null || echo '?'
}
todos() { curl -s --max-time 15 "$URL/api/todos"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Contrôles avant la panne ($APP)"
[ "$(aws sts get-caller-identity --query Account --output text)" = 804210702561 ] || { echo "Mauvais compte AWS."; exit 1; }
# Nom réel de l'instance chez Google (suffixe de génération depuis le 06/11) : celui que Crossplane gère.
INSTANCE=$(kubectl --context "$CONTEXT" get databaseinstances.sql.gcp.upbound.io "$CR" \
  -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}')
[ -n "$INSTANCE" ] || { echo "Ressource Crossplane $CR introuvable."; exit 1; }
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/health")
WORKER=$(state)
SQL=$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT" --format='value(state,settings.activationPolicy)')
echo "app : HTTP $HEALTH | worker : $WORKER | Cloud SQL $INSTANCE : $SQL"
[ "$HEALTH" = 200 ] && [ "$WORKER" = WAIT_SIGNALS ] && [[ "$SQL" == RUNNABLE*ALWAYS ]] || {
  echo "L'app n'est pas dans l'état de départ attendu (HTTP 200, worker WAIT_SIGNALS, Cloud SQL RUNNABLE/ALWAYS). Rien n'a été touché."
  exit 1
}

GCP_IP=$(dig +short "$APP.apps.mooroon5.fr" A @8.8.8.8 | head -1)     # avant la panne, le DNS pointe vers GCP

step "Écriture d'un témoin sur GCP"
WITNESS="témoin soutenance $(date '+%d/%m %H:%M:%S')"
curl -s --max-time 15 -X POST -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1]}))' "$WITNESS")" "$URL/api/todos"; echo
echo "base actuelle : $(curl -s --max-time 10 "$URL/info")"

step "Panne"
read -r -p "Arrêter la base GCP de $APP maintenant ? (oui/non) " ANSWER
[ "$ANSWER" = oui ] || { echo "Annulé. Le témoin reste dans l'app, rien d'autre n'a changé."; exit 0; }
kubectl --context "$CONTEXT" annotate databaseinstances.sql.gcp.upbound.io "$CR" crossplane.io/paused=true --overwrite >/dev/null
T0=$(date +%s); echo "T0 = $(date '+%H:%M:%S') : Crossplane en pause, arrêt de Cloud SQL…"
gcloud sql instances patch "$INSTANCE" --project "$PROJECT" --activation-policy=NEVER --quiet >/dev/null 2>&1
echo "Cloud SQL arrêtée à $(date '+%H:%M:%S')"

step "Bascule (une ligne par changement ; compter environ 7 min)"
last=""
for _ in $(seq 1 120); do
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/health" || true)
  ALARM=$(aws cloudwatch describe-alarms --region us-east-1 --alarm-names "cnp-failover-platform-$APP" \
    --query 'MetricAlarms[0].StateValue' --output text 2>/dev/null || echo '?')
  WORKER=$(state)
  # L'ALB AWS répond sur plusieurs adresses qui alternent : seul le côté compte.
  DNS=$(dig +short "$APP.apps.mooroon5.fr" A @8.8.8.8 | head -1)
  [ "$DNS" = "$GCP_IP" ] && DNS=GCP || DNS="AWS($DNS)"; DNS=${DNS%%(*}
  BASE=$(curl -s --max-time 8 "$URL/info" | python3 -c "import json,sys
try: d=json.load(sys.stdin); print(d.get('version','?')[:30], 'lecture-seule=' + str(d.get('read_only')))
except Exception: print('-')" 2>/dev/null || echo '-')
  NOW="HTTP=$HEALTH alarme=$ALARM worker=$WORKER dns=$DNS base=[$BASE]"
  if [ "$NOW" != "$last" ]; then printf '+%3ds %s %s\n' $(( $(date +%s) - T0 )) "$(date +%H:%M:%S)" "$NOW"; last=$NOW; fi
  case "$WORKER" in
    AWS_ACTIVE|GCP_FENCE_PENDING) [ "$HEALTH" = 200 ] && break ;;
    # Un blocage n'est pas définitif : le worker réessaie chaque minute. Observé le 06/11 : le processus de réplication de
    # RDS reste coincé ~2 min sur sa connexion vers GCP, le worker bloque une fois puis termine la bascule au passage suivant.
    BLOCKED*) ;;
  esac
  sleep 15
done
[ "$HEALTH" = 200 ] || { echo "Pas de bascule au bout de 30 min."; exit 1; }
echo "App servie par AWS en $(( ($(date +%s) - T0) / 60 )) min $(( ($(date +%s) - T0) % 60 )) s."

step "Preuves"
# L'API échappe les accents (é) : comparer après décodage JSON, pas sur le texte brut.
if todos | python3 -c 'import json,sys; sys.exit(0 if any(t.get("title") == sys.argv[1] for t in json.load(sys.stdin)) else 1)' "$WITNESS"
then echo "✅ témoin écrit sur GCP avant la panne présent sur AWS : aucune perte"
else echo "❌ témoin absent sur AWS"; fi
echo "écriture sur AWS : $(curl -s --max-time 15 -X POST -H 'Content-Type: application/json' \
  -d "{\"title\": \"écrit sur AWS après bascule $(date '+%H:%M:%S')\"}" "$URL/api/todos")"
echo "base : $(curl -s --max-time 10 "$URL/info")"
echo "journal du worker :"
aws dynamodb query --region eu-west-3 --table-name cnp-failover-platform-state \
  --key-condition-expression 'app = :a AND begins_with(#r, :e)' --expression-attribute-names '{"#r":"record"}' \
  --expression-attribute-values "{\":a\":{\"S\":\"$APP\"},\":e\":{\"S\":\"EVENT#\"}}" \
  --query 'Items[].[state.S,at.N]' --output text | tail -8 | while read -r s t; do echo "  $(date -r "$t" '+%H:%M:%S') $s"; done
echo
echo "L'app reste sur AWS (Cloud SQL arrêtée, ressource Crossplane en pause). Retour vers GCP : ./scripts/failover/demo/demo-retour.sh $APP"
