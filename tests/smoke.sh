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

# 1. Select fixtures : prefer real ones (gitignored), else fall back to the
#    committed SYNTHETIC set (zero client data, AI disabled so no credentials
#    are needed). This lets `npm run smoke` work out of the box for anyone.
QS=""
if [[ -f "$FIXTURES/template.pdf" && -f "$FIXTURES/data.xlsx" && -f "$FIXTURES/assets.zip" ]]; then
  TEMPLATE="$FIXTURES/template.pdf"; DATA="$FIXTURES/data.xlsx"; ASSETS="$FIXTURES/assets.zip"
  yellow "Fixtures : tests/fixtures/ (real)"
elif [[ -f "$FIXTURES/synthetic/template.pdf" ]]; then
  TEMPLATE="$FIXTURES/synthetic/template.pdf"; DATA="$FIXTURES/synthetic/data.xlsx"; ASSETS="$FIXTURES/synthetic/assets.zip"
  QS="?descriptions=0&audit=0&enrich=0&coherence=0"
  yellow "Fixtures : tests/fixtures/synthetic/ (synthetic, no client data, AI disabled)"
else
  red "Aucune fixture trouvee (ni reelle ni synthetique)."
  yellow "Lance \`npm run fixtures:synth\` pour generer le jeu synthetique."
  exit 1
fi

# 2. Verif serveur
if ! curl -s -m 5 "$URL/api/health" | grep -q '"ok":true'; then
  red "Serveur indisponible sur $URL — lance \`docker compose up -d\`."
  exit 1
fi

# 3. Run /api/generate
yellow "Run baseline V2 contre $URL ..."
RESP=$(curl -s -m 300 -X POST "$URL/api/generate$QS" \
  -F "template=@$TEMPLATE" \
  -F "data=@$DATA" \
  -F "assets=@$ASSETS")

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
check_present "stats.extractMs"
check_present "stats.substituteMs"
check_present "stats.renderMs"
check_present "stats.profileSource"

if (( fail )); then
  red "Smoke V2 FAIL"
  echo "$RESP" | node -e "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>{try{console.log(JSON.stringify(JSON.parse(r),null,2));}catch{console.log(r)}});" | head -50
  exit 1
fi

green "Smoke V2 OK"
