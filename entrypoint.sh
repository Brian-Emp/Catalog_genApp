#!/bin/sh
# Entrypoint catalog-gen-app : smoke du binaire C++ + statut IA, puis serveur.
set -e

# 1. Valide que catgen-pdf est present et que libpdfium.so est bien linkee.
#    `catgen-pdf --version` init/destroy PDFium : echoue (exit != 0 / segfault)
#    si la lib est introuvable au runtime. On arrete tot avec un message clair
#    plutot que de laisser la 1ere generation planter en plein milieu.
if ! catgen-pdf --version >/dev/null 2>&1; then
  echo "[entrypoint] FATAL: catgen-pdf indisponible ou libpdfium.so non linkee." >&2
  exit 1
fi

# 2. Statut des features IA (informatif, jamais bloquant).
if command -v claude >/dev/null 2>&1; then
  if [ -f "${HOME:-/home/app}/.claude/.credentials.json" ]; then
    echo "[entrypoint] IA: Claude CLI + credentials → enrichissements actifs."
  else
    echo "[entrypoint] IA: Claude CLI present mais SANS credentials → mode degrade (PDF deterministe OK)."
  fi
else
  echo "[entrypoint] IA: image lean (WITH_AI=0) → pipeline deterministe complet, enrichissements desactives."
fi

# 3. Lance la commande (CMD) en remplacant le shell : PID 1 propre, signaux OK.
exec "$@"
