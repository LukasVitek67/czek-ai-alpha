#!/usr/bin/env node
'use strict';
// Noví kandidáti pro týdenní přeměření (tools/model-evidence-weekly.sh): free modely silných tierů (Max/High) s nástroji,
// které teď appka nabízí, ale nemají čerstvé měření (src/model-evidence.json). Bez toho by se nový free model mezi
// ověřené dostal, jen kdyby ho někdo ručně připsal do docs/research/model-candidates.json.
//   node tools/model-candidates-auto.js [počet=4]   → řádky „<poskytovatel> <model>“
const path = require('path');
const repo = path.join(__dirname, '..');
const { ModelRegistry } = require(path.join(repo, 'src/agent'));
const { PROVIDERS } = require(path.join(repo, 'src/providers'));
const tiers = require(path.join(repo, 'src/tiers'));
const E = require(path.join(repo, 'src/evidence'));

const N = Number(process.argv[2]) || 4;
// poskytovatelé, které umí docs/research/2026-11-22-claude-e2e/bench-e2e.js; Groq/HF ne (free limity neutáhnou úlohu)
const BENCHABLE = new Set(['mistral', 'zai', 'openrouter', 'gemini', 'nvidia', 'github', 'kilo', 'pollinations']);

(async () => {
  let keys = {};
  try { keys = require(path.join(repo, 'private/keys.json')).providers || {}; } catch {}
  const settings = {
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, keys[p.id] ? { enabled: true, key: keys[p.id] } : {}])),
    customProviders: [], favorites: [], model: 'auto', fallback: true, tiers: {}, router: 'omniroute', preferFamilies: [],
  };
  const reg = new ModelRegistry(() => settings);
  const { models } = await reg.list(true);
  const fresh = E.proven(E.load(), Date.now(), { minRate: 0 }); // měřené (i neúspěšně) v posledních 45 dnech
  const measured = new Set();
  const all = E.load();
  const since = Date.now() - E.MAX_AGE_DAYS * 86400000;
  for (const [k, runs] of Object.entries(all)) if (runs.some((r) => Date.parse(r.at) >= since)) measured.add(k);
  const seen = new Set();
  const out = [];
  // 1) ověřené modely, jejichž poslední úspěšné měření je starší než 30 dní: přeměřit dřív, než vyprší (jinak by
  //    spadly z tieru Max podle názvu – src/tiers.js – a do týdenního výběru Max/High by se už nevrátily)
  const stale = Object.values(E.proven(all)).filter((p) => Date.now() - Date.parse(p.lastOk) > 30 * 86400000).map((p) => p.key);
  for (const m of reg.autoOrder(models.filter((x) => x.usable && x.tools !== false && BENCHABLE.has(x.provider)), false)) {
    const k = E.modelKey(m.id);
    if (!stale.includes(k) || seen.has(k) || out.length >= N) continue;
    seen.add(k); out.push(`${m.provider} ${m.id}`);
  }
  for (const m of reg.autoOrder(models.filter((x) => x.usable && x.tools !== false && BENCHABLE.has(x.provider)), false)) {
    const k = E.modelKey(m.id);
    if (measured.has(k) || fresh[k] || seen.has(k)) continue;
    if (!['max', 'high'].includes(tiers.classify(m))) continue;
    seen.add(k);
    out.push(`${m.provider} ${m.id}`);
    if (out.length >= N) break;
  }
  console.log(out.join('\n'));
})().catch((e) => { console.error('model-candidates-auto:', e.message); process.exit(1); });
