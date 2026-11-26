#!/bin/bash
# Týdenní přeměření modelů (systemd timer czek-model-evidence.timer): ověřené modely appky = jen ty, které teď
# opravdu zvládají úlohy agenta (src/evidence.js, měření vyprší po 45 dnech).
#  1) celá appka (bench-czek) na úlohách feature, bugfix a project → vítězové kroků závodu,
#  2) kandidáti z docs/research/model-candidates.json přímo (bench-e2e, úloha bugfix),
#  3) sloučení do src/model-evidence.json, testy, commit a push.
# Spotřebuje free kvóty (~11 úloh), proto jen jednou týdně.
set -u
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
REPO_MAIN="$(cd "$(dirname "$0")/.." && pwd)"
# Vlastní dočasný worktree z origin/main: sdílená složka bývá rozdělaná od jiných session a 25. 11. tam `git pull` selhal
# („You have unstaged changes“) → běh pokračoval na starém kódu. Výsledek se commitne a pushne z worktree.
git -C "$REPO_MAIN" fetch -q origin main || exit 1
WT="$(mktemp -d)/czek-weekly"
git -C "$REPO_MAIN" worktree add -q --detach "$WT" origin/main || exit 1
ln -s "$REPO_MAIN/node_modules" "$WT/node_modules"
OUT="docs/research/model-evidence-runs/$(date +%Y-%m-%d)"
# log a výsledky vždy zpět do sdílené složky (i když se necommitne), worktree pryč
trap 'mkdir -p "$REPO_MAIN/$OUT" && cp -r "$WT/$OUT/." "$REPO_MAIN/$OUT/" 2>/dev/null; git -C "$REPO_MAIN" worktree remove --force "$WT" >/dev/null 2>&1' EXIT
REPO="$WT"
cd "$REPO" || exit 1
mkdir -p "$OUT"
LOG="$OUT/run.log"
echo "== $(date -Is) týdenní přeměření (worktree $WT z $(git rev-parse --short HEAD))" >> "$LOG"

# WEEKLY_QUICK=1: jen ověření řetězce (bez bench-czek, 1 automatický kandidát, bez commitu)
QUICK="${WEEKLY_QUICK:-0}"
if [ "$QUICK" != 1 ]; then
  for fx in feature bugfix project; do
    BENCH_TAG="weekly" BENCH_LIMIT_MIN=20 timeout 1800 node docs/research/2026-11-22-claude-e2e/bench-czek.js "$OUT" zdarma-max "$fx" >> "$LOG" 2>&1
  done
fi
FX=$(node -e "console.log(require('./docs/research/model-candidates.json').fixture)")
# kandidáti: ruční seznam + až 4 nové neměřené modely tierů Max/High, které appka teď nabízí
{
  [ "$QUICK" != 1 ] && node -e "for (const [p, m] of require('./docs/research/model-candidates.json').candidates) console.log(p + ' ' + m)"
  node tools/model-candidates-auto.js "$([ "$QUICK" = 1 ] && echo 1 || echo 4)" 2>> "$LOG"
} | awk 'NF && !seen[$0]++' > "$OUT/candidates.txt"
echo "kandidáti: $(tr '\n' ';' < "$OUT/candidates.txt")" >> "$LOG"
while read -r prov model; do
  BENCH_LIMIT_MIN=15 timeout 1200 node docs/research/2026-11-22-claude-e2e/bench-e2e.js "$prov" "$model" "$OUT" "$FX" >> "$LOG" 2>&1 < /dev/null
done < "$OUT/candidates.txt"

# výsledky do docs/research/model-evidence-runs/*/ (ingest je najde: hledá složky results i data běhů)
node tools/model-evidence.js ingest $(ls -d docs/research/*/results docs/research/model-evidence-runs/*/ 2>/dev/null) >> "$LOG" 2>&1
node tools/model-evidence.js show >> "$LOG" 2>&1
if node test/evidence.js >> "$LOG" 2>&1 && node test/tiers.js >> "$LOG" 2>&1; then
  if grep -rqE "(sk-or-v1-|nvapi-|gsk_|ghp_|AIza)[A-Za-z0-9_-]{20,}" "$OUT" src/model-evidence.json; then
    echo "KLÍČ ve výsledcích – necommituji" >> "$LOG"; exit 1
  fi
  if [ "$QUICK" = 1 ]; then echo "QUICK: bez commitu" >> "$LOG"; exit 0; fi
  git add src/model-evidence.json "$OUT"
  git commit -q -m "chore(models): weekly re-measurement $(date +%Y-%m-%d) – proven models from measurements" >> "$LOG" 2>&1
  git push -q origin HEAD:main >> "$LOG" 2>&1 || { git pull -q --rebase origin main >> "$LOG" 2>&1 && git push -q origin HEAD:main >> "$LOG" 2>&1; } || { echo "push selhal" >> "$LOG"; exit 1; }
else
  echo "testy selhaly – necommituji" >> "$LOG"; exit 1
fi
