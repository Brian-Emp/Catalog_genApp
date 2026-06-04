#!/usr/bin/env bash
# Smoke E2E V2 : appelle /api/generate avec les fixtures et verifie la shape
# de la reponse + les stats V2.
#
# Pre-requis :
#   - docker compose up -d  (serveur V2)
#   - tests/fixtures/{template.pdf, data.xlsx, assets.zip} presents
#   - claude CLI accessible depuis le container (TODO Lot 9 :
#     installation dans l'image Docker ou volume mount).
#     Pour l'instant : si claude indisponible, le test va renvoyer une
#     erreur "claude failed" exploitable pour debug.
#
# Override l'URL via SMOKE_URL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/tests/fixtures"
URL="${SMOKE_URL:-http://localhost:8080}"

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

# 1. Verif fixtures
missing=0
for f in template.pdf data.xlsx assets.zip; do
  if [[ ! -f "$FIXTURES/$f" ]]; then
    red "Fixture manquante : tests/fixtures/$f"
    missing=1
  fi
done
if (( missing )); then
  yellow "Voir la section Tests du README (fixtures attendues dans tests/fixtures/)."
  exit 1
fi

# 2. Verif serveur
if ! curl -s -m 5 "$URL/api/health" | grep -q '"ok":true'; then
  red "Serveur indisponible sur $URL — lance \`docker compose up -d\`."
  exit 1
fi

# 3. Run /api/generate
yellow "Run baseline V2 contre $URL ..."
RESP=$(curl -s -m 300 -X POST "$URL/api/generate" \
  -F "template=@$FIXTURES/template.pdf" \
  -F "data=@$FIXTURES/data.xlsx" \
  -F "assets=@$FIXTURES/assets.zip")

# 4. Parse + verifie via node (pas de Python)
parse_field() {
  local field="$1"
  node -e "
    let raw = '';
    process.stdin.on('data', d => raw += d);
    process.stdin.on('end', () => {
      try {
        let v = JSON.parse(raw);
        for (const k of '${field}'.split('.')) v = v[k];
        process.stdout.write(String(v ?? ''));
      } catch (e) {
        process.stderr.write('parse error: ' + e.message);
        process.exit(2);
      }
    });
  " <<< "$RESP"
}

# Verifie que la reponse est bien du JSON
if ! echo "$RESP" | node -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{JSON.parse(r);}catch(e){process.exit(1)}});" 2>/dev/null; then
  red "Reponse non-JSON :"
  echo "$RESP" | head -c 500
  exit 1
fi

# Si la generation a echoue (probable si claude pas dispo), affiche l'erreur
ERROR_FIELD=$(parse_field "error" 2>/dev/null || echo "")
if [[ -n "$ERROR_FIELD" && "$ERROR_FIELD" != "undefined" ]]; then
  red "Generation echouee : $ERROR_FIELD"
  ORCH_ERRORS=$(parse_field "orchestratorErrors" 2>/dev/null || echo "")
  if [[ -n "$ORCH_ERRORS" && "$ORCH_ERRORS" != "undefined" ]]; then
    yellow "Orchestrator errors : $ORCH_ERRORS"
  fi
  exit 1
fi

# 5. Verifie la shape V2
fail=0
check_present() {
  local field="$1"
  local got
  got=$(parse_field "$field")
  if [[ -n "$got" && "$got" != "undefined" && "$got" != "null" ]]; then
    green "  OK   $field = $got"
  else
    red   "  FAIL $field absent/vide"
    fail=1
  fi
}

check_int_gte() {
  local field="$1"
  local min="$2"
  local got
  got=$(parse_field "$field")
  if [[ "$got" =~ ^[0-9]+$ ]] && (( got >= min )); then
    green "  OK   $field = $got (>= $min)"
  else
    red   "  FAIL $field = $got (attendu entier >= $min)"
    fail=1
  fi
}

check_present "pdfName"
check_present "catalogUrl"
check_int_gte "productCount" 1
check_int_gte "stats.pagesKept" 1
check_int_gte "stats.productsUsed" 0
check_int_gte "stats.extractMs" 1
check_int_gte "stats.planMs" 1
check_int_gte "stats.renderMs" 1

if (( fail )); then
  red "Smoke V2 FAIL"
  echo "$RESP" | node -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{console.log(JSON.stringify(JSON.parse(r),null,2));}catch{console.log(r)}});" | head -50
  exit 1
fi

green "Smoke V2 OK"
