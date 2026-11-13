#!/usr/bin/env bash
set -euo pipefail

# Local portal startup with the Python operator required by PostgreSQL.
# Dependencies stay inside the project; cloud credentials are never displayed.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

verify_operator() {
  "$operator_python" - <<'PY'
import importlib
import sys

missing = []
for name in ('kubernetes', 'google.auth', 'google.cloud.secretmanager', 'boto3', 'psycopg', 'yaml', 'requests'):
    try:
        importlib.import_module(name)
    except ImportError:
        missing.append(name)
if missing:
    print('Python opérateur incomplet : ' + ', '.join(missing), file=sys.stderr)
    print('Installer scripts/failover/engine/requirements.platform.txt dans cet interpréteur.', file=sys.stderr)
    sys.exit(1)
print('Dépendances du Python opérateur vérifiées.')
PY
}

operator_python="${CNP_FAILOVER_OPERATOR_PYTHON:-${CNP_FAILOVER_PYTHON:-}}"
if [[ -z "$operator_python" ]]; then
  operator_python="$PWD/data/.venv-failover/bin/python"
  if [[ ! -x "$operator_python" ]] || ! "$operator_python" -m pip --version >/dev/null 2>&1; then
    bootstrap_python="${CNP_BOOTSTRAP_PYTHON:-python3}"
    if ! "$bootstrap_python" -m venv "$PWD/data/.venv-failover"; then
      printf '%s\n' 'Création du Python opérateur impossible : installez python3-venv pour votre Python, puis relancez npm run dev:postgres.' >&2
      exit 1
    fi
  fi
  fingerprint="$("$operator_python" - <<'PY'
import hashlib
import sys
from pathlib import Path
parts = [sys.version.encode()]
for name in ('requirements.txt', 'requirements.automation.txt', 'requirements.platform.txt'):
    parts.append(Path('scripts/failover/engine', name).read_bytes())
print(hashlib.sha256(b'\0'.join(parts)).hexdigest())
PY
)"
  marker="$PWD/data/.venv-failover/.cnp-operator-requirements"
  installed_fingerprint=''
  if [[ -f "$marker" ]]; then installed_fingerprint="$(cat "$marker")"; fi
  if [[ "$installed_fingerprint" != "$fingerprint" ]] \
      || ! verify_operator >/dev/null 2>&1 \
      || ! "$operator_python" -m pip check >/dev/null 2>&1; then
    printf '%s\n' 'Préparation des dépendances Python PostgreSQL (avant le démarrage du portail)…'
    if ! "$operator_python" -m pip install --prefer-binary --disable-pip-version-check -r scripts/failover/engine/requirements.platform.txt; then
      printf '%s\n' 'Installation Python incomplète ; le portail n’a pas démarré. Corrigez l’erreur pip puis relancez npm run dev:postgres.' >&2
      exit 1
    fi
    "$operator_python" -m pip check
    verify_operator
    printf '%s\n' "$fingerprint" > "$marker"
  else
    printf '%s\n' 'Environnement Python déjà prêt ; démarrage sans réinstallation.'
  fi
else
  verify_operator
fi

export CNP_FAILOVER_OPERATOR_PYTHON="$operator_python"
export CNP_FAILOVER_PYTHON="$operator_python"
exec npm run dev
