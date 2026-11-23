'use strict';
// Ověřené modely z MĚŘENÍ místo ručního seznamu (docs/SCORECARD.md, „Údržba“).
//
// src/model-evidence.json drží výsledky skutečných úloh agenta (bench-e2e = čisté OpenCode + jeden model,
// bench-czek = celá cesta appky, kde se počítá model, který vyhrál kroky závodu). Model je „ověřený“, když má
// v posledních MAX_AGE_DAYS aspoň jeden úspěšný běh a úspěšnost ≥ MIN_RATE. Staré měření vyprší samo, takže model,
// který poskytovatel změnil nebo stáhl, z čela tierů vypadne bez ruční úpravy; nový model se tam dostane po
// změření (`node tools/model-evidence.js ingest <složka s výsledky>`, pravidelně `tools/model-evidence-weekly.sh`).
//
// Proč ne regex: PROVEN /gemini-3(\.\d)?-flash/ pouštěl 22. 11. mezi ověřené i gemini-3.7-flash a 3.8-flash,
// které nikdo neměřil, a glyph-cluster z 8. 11. by tam zůstal navždy.

const MAX_AGE_DAYS = 45;
const QUOTA = /\b429\b|cooling down|rate.?limit|quota|too many requests|insufficient (credit|balance|quota)|credits? (exhausted|required)|exhausted|sign up for free/i;
const MIN_RATE = 0.5;
const BROAD = 3;

/** Klíč modelu: poslední část id bez cesty poskytovatele a bez přípony :free (stejný model u Kilo, OpenRouteru…). */
function modelKey(id) {
  const s = String(id || '').toLowerCase().trim().replace(/:free$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

/**
 * Výsledek benchmarku → záznamy důkazů [{ key, ok, wallS, fixture, at, source }].
 * Běh, který skončil chybou protokolu/nastavení dřív, než agent cokoli udělal (≤ 2 kroky a chyba), se nepočítá:
 * neříká nic o schopnostech modelu (např. Gemini v čistém OpenCode: 400 „Function call is missing a thought_signature“).
 */
function recordsFrom(r, source = '') {
  if (!r || typeof r !== 'object' || !r.at || !r.fixture) return [];
  const errs = Array.isArray(r.errors) ? r.errors.length : (r.error ? 1 : 0);
  if ((r.steps || 0) <= 2 && errs) return [];
  if (r.noKeys) return []; // profil bez klíčů měří limity poskytovatelů, ne modely
  // Neúspěch kvůli vyčerpanému limitu (429, „cooling down“, kredit) není neúspěch modelu: týdenní přeměření běží na
  // sdílených free kvótách a jinak by dobrý model vyřadilo jen proto, že zrovna došla kvóta (22. 11. večer po dni
  // měření: Kilo i OpenRouter neodpovídaly vůbec).
  if (!r.success) {
    const texts = [...(Array.isArray(r.errors) ? r.errors : []), r.error || '', r.lastRetry || '', ...(r.timedOut ? r.raceFailures || [] : [])].join(' ');
    if (QUOTA.test(texts)) return [];
  }
  const base = { ok: !!r.success, wallS: Number(r.wallS) || null, fixture: r.fixture, at: r.at, source };
  if (r.model) return [{ key: modelKey(r.model), ...base }];
  // bench-czek: model, který vyhrál většinu kroků závodu, nese výsledek celé úlohy
  const w = Object.entries(r.raceWinners || {}).sort((a, b) => b[1] - a[1]);
  const steps = w.reduce((s, [, n]) => s + n, 0);
  return w.filter(([, n]) => n / steps >= 0.5).map(([m]) => ({ key: modelKey(m), ...base }));
}

/** Sloučí záznamy do souhrnu po modelech (duplicitní běh = stejný klíč, úloha, čas a zdroj se nepočítá dvakrát). */
function summarize(records) {
  const seen = new Set();
  const models = {};
  for (const x of records) {
    const id = `${x.key}|${x.fixture}|${x.at}|${x.source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    (models[x.key] ||= []).push({ ok: x.ok, wallS: x.wallS, fixture: x.fixture, at: x.at, source: x.source });
  }
  for (const k of Object.keys(models)) models[k].sort((a, b) => a.at.localeCompare(b.at));
  return models;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/**
 * Ověřené modely k datu `now`: { key: { rank, runs, ok, rate, fixtures, medianS, lastOk } }.
 * Pořadí (rank 0 = nejlepší): víc různých úloh zvládnutých (nejvýš BROAD = 3) → kratší očekávaný čas (medián ÷ úspěšnost).
 * Šíře důkazů má přednost před rychlostí: model rychlý na jedné úloze nepředběhne model ověřený na třech, ale model
 * ověřený na 3 úlohách a rychlejší předběhne pomalejší ověřený na 4.
 */
function proven(models, now = Date.now(), { maxAgeDays = MAX_AGE_DAYS, minRate = MIN_RATE } = {}) {
  const since = now - maxAgeDays * 86400000;
  const out = [];
  for (const [key, runs] of Object.entries(models || {})) {
    const fresh = runs.filter((r) => Date.parse(r.at) >= since);
    const ok = fresh.filter((r) => r.ok);
    if (!ok.length || ok.length / fresh.length < minRate) continue;
    out.push({ key, runs: fresh.length, ok: ok.length, rate: ok.length / fresh.length, fixtures: new Set(ok.map((r) => r.fixture)).size,
      medianS: median(ok.map((r) => r.wallS).filter((x) => x != null)), lastOk: ok[ok.length - 1].at });
  }
  // šíře se počítá nejvýš do BROAD úloh: kdo zvládl 3 různé úlohy, je ověřený dost a dál rozhoduje rychlost
  const breadth = (x) => Math.min(x.fixtures, BROAD);
  // pak očekávaný čas do úspěchu = medián ÷ úspěšnost: jeden nepovedený běh rychlý model jen mírně odsune
  // (22. 11.: ERNIE 7/8 za medián 55 s → 63 s je pořád lepší než Nemotron 16/16 za 115 s; dřív rozhodovala
  // úspěšnost jako první a ERNIE kvůli jednomu testu z 38 spadla za 2× pomalejší model)
  const expected = (x) => (x.medianS ?? 1e6) / x.rate;
  out.sort((a, b) => breadth(b) - breadth(a) || expected(a) - expected(b));
  return Object.fromEntries(out.map((x, i) => [x.key, { rank: i, ...x }]));
}

/** Matcher se stejným rozhraním jako dřívější regex PROVEN (`.test(text)`) + `.rank(id)` pro pořadí. */
function matcher(models, now) {
  const p = proven(models, now);
  const keyOf = (text) => {
    for (const tok of String(text || '').toLowerCase().split(/\s+/)) { const k = modelKey(tok); if (p[k]) return k; }
    return null;
  };
  return {
    test: (text) => keyOf(text) != null,
    rank: (text) => { const k = keyOf(text); return k == null ? Infinity : p[k].rank; },
    list: () => p,
  };
}

function load(file = require('path').join(__dirname, 'model-evidence.json')) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')).models || {}; } catch { return {}; }
}

module.exports = { MAX_AGE_DAYS, MIN_RATE, BROAD, modelKey, recordsFrom, summarize, proven, matcher, load };
