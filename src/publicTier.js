// Veřejný tierlist (uživatel 23. 11.: „public site na vercelu, kde bude veřejný tierlist, který se bude díky
// uživatelům sám updatovat … appka si vybere ten, co považuje za spolehlivější“).
//
// Odesílání: souhrn volání modelů z OmniRoute (/api/usage/call-logs) → POST <url>/api/report. Jen id modelu, počty
// (ok / chyba / 429 / 402 / timeout) a medián doby. Žádné dotazy, odpovědi, klíče ani jména. Instalace = náhodné
// id (ne odvozené od uživatele), server ho i IP ukládá jen jako hash se solí. Zapnuté bez ptaní (rozhodnutí
// uživatele 23. 11.), vypínač v menu czek-ai, testy (ZDARMA_HIDDEN) nikdy na produkci.
//
// Použití: „dav jen shazuje“ (rozhodnutí uživatele 23. 11.). Model, který u ≥ 5 různých instalací za 3 dny skoro
// nefunguje, jde v combo za spolehlivé (OmniRoute.crowd, stejně jako nespolehlivé). Nahoru model nikdy neposune –
// o tom rozhoduje jen naše měření (src/evidence.js). Podvržená data tak můžou nanejvýš odsunout dobrý model.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_URL = 'https://czek-ai-tierlist.vercel.app';
const isCombo = (m) => /^zdarma-|^auto\//.test(String(m || ''));

/** Pravidlo „dav jen shazuje“: které modely z veřejného souhrnu odsunout. */
function demoted(rows, o = {}) {
  const minInstalls = o.minInstalls ?? 5;
  const minCalls = o.minCalls ?? 30;
  const maxSuccess = o.maxSuccess ?? 0.25;
  const okWithinMs = o.okWithinMs ?? 6 * 3600000;
  const now = o.now ?? Date.now();
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.model !== 'string') continue;
    const calls = Number(r.ok || 0) + Number(r.fail || 0);
    const success = calls ? Number(r.ok || 0) / calls : 1;
    const recentOk = r.last_ok && now - Date.parse(r.last_ok) < okWithinMs;
    if (Number(r.installs || 0) >= minInstalls && calls >= minCalls && success < maxSuccess && !recentOk) out.add(r.model);
  }
  return out;
}

/** Řádek volání OmniRoute → klíč modelu „poskytovatel/id“ (stejný jako v combo czek-ai), nebo null. */
function keyOf(r, omni) {
  const req = r.requestedModel || r.requested_model;
  if (req && !isCombo(req)) {
    for (const base of omni?.baseLists?.values?.() || []) {
      const x = base.find((b) => b?.ref === req);
      if (x) return `${x.provider}/${x.id}`;
    }
  }
  if (!r.model) return null;
  const prov = omni?.nodeToProvider?.get?.(r.provider) || r.provider;
  if (!prov) return null;
  const k = `${prov}/${r.model}`;
  try { return omni?.matchKey ? omni.matchKey(k) || k : k; } catch { return k; }
}

/** Druh výsledku jednoho volání; null = nepočítat (rozpracované, poražený v závodě, chyba klíče uživatele). */
function outcome(r) {
  const st = Number(r.status) || 0;
  const dur = Number(r.duration) || 0;
  if (st === 0) return null;
  if (st >= 200 && st < 300) return 'ok';
  if (st === 499 && dur < 30000) return null; // poražený v závodě / zrušeno klientem
  if (st === 401 || st === 403) return null; // špatný klíč uživatele, ne stav modelu
  if (st === 429) return 'rate_limited';
  if (st === 402) return 'no_credit';
  if (st === 408 || st === 504 || st === 499 || /timeout|timed out/i.test(String(r.error || ''))) return 'timeout';
  return 'fail';
}

/** Souhrn řádků podle modelu (to, co se posílá). */
function summarize(items) {
  const per = new Map();
  for (const it of items) {
    const m = per.get(it.key) || { model: it.key, ok: 0, fail: 0, rate_limited: 0, no_credit: 0, timeout: 0, durs: [] };
    if (it.kind === 'ok') { m.ok++; if (it.duration > 0) m.durs.push(it.duration); } else {
      m.fail++;
      if (it.kind !== 'fail') m[it.kind]++;
    }
    per.set(it.key, m);
  }
  return [...per.values()].map(({ durs, ...m }) => {
    const s = durs.sort((a, b) => a - b);
    return { ...m, p50_ms: s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null };
  });
}

class PublicTier {
  /**
   * @param {{ dataDir: () => string, version: string, settings: () => object, saveSettings: () => void,
   *   getOmni: () => any, log?: (...a: any[]) => void, url?: string, fetch?: typeof fetch }} o
   */
  constructor(o) {
    this.o = o;
    this.pending = new Map(); // id řádku → { key, kind, duration }
    this.sent = new Set(); // id už odeslaných (posledních ~5000)
    this.tier = null; // poslední veřejný souhrn
    this.crowd = new Set(); // odsunuté modely
    this.lastSend = null; // { at, ok, n, error }
    this.lastPull = null;
  }

  url() { return (process.env.ZDARMA_SHARE_URL || this.o.url || DEFAULT_URL).replace(/\/+$/, ''); }

  /** Odesílat? Vypínač v menu; testy (ZDARMA_HIDDEN) jen s vlastním ZDARMA_SHARE_URL, nikdy na produkci. */
  sharing() {
    if (process.env.ZDARMA_NO_SHARE) return false;
    if (process.env.ZDARMA_HIDDEN && !process.env.ZDARMA_SHARE_URL) return false;
    return this.o.settings().shareStats !== false;
  }

  /** Stahovat veřejný souhrn? Čtení nic neposílá, jen v testech zase ne na produkci. */
  pulling() { return !(process.env.ZDARMA_HIDDEN && !process.env.ZDARMA_SHARE_URL) && !process.env.ZDARMA_NO_PUBLIC_TIER; }

  installId() {
    const s = this.o.settings();
    if (!/^[0-9a-f]{32}$/.test(s.installId || '')) { s.installId = crypto.randomBytes(16).toString('hex'); this.o.saveSettings(); }
    return s.installId;
  }

  /** Nové řádky z OmniRoute (každý jen jednou). */
  ingest(rows) {
    const omni = this.o.getOmni();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.timestamp || r.model === 'model-sync' || /connection-test|model-sync/.test(String(r.requestedModel || r.requested_model || ''))) continue;
      if (r.path && !/chat\/completions|\/messages|\/responses/.test(String(r.path))) continue;
      const id = String(r.id ?? `${r.timestamp}|${r.provider}|${r.model}|${r.status}`);
      if (this.sent.has(id) || this.pending.has(id)) continue;
      const kind = outcome(r);
      if (!kind) continue;
      const key = keyOf(r, omni);
      if (!key || key.length > 120) continue;
      this.pending.set(id, { key, kind, duration: Number(r.duration) || 0 });
    }
    if (this.pending.size > 5000) for (const id of [...this.pending.keys()].slice(0, this.pending.size - 5000)) this.pending.delete(id);
  }

  /** Odeslat souhrn čekajících řádků. Vrací počet modelů, nebo 0. */
  async flush(timeoutMs = 10000) {
    if (!this.sharing() || !this.pending.size) return 0;
    const ids = [...this.pending.keys()];
    const rows = summarize([...this.pending.values()]).slice(0, 150);
    const f = this.o.fetch || fetch;
    try {
      const r = await f(`${this.url()}/api/report`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `czek-ai/${this.o.version}` },
        body: JSON.stringify({ install: this.installId(), version: this.o.version, rows }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
      for (const id of ids) { this.pending.delete(id); this.sent.add(id); }
      if (this.sent.size > 6000) this.sent = new Set([...this.sent].slice(-5000));
      this.lastSend = { at: Date.now(), ok: true, n: rows.length };
      this.o.log?.('[tierlist] odesláno', rows.length, 'modelů,', ids.length, 'volání');
      return rows.length;
    } catch (e) {
      this.lastSend = { at: Date.now(), ok: false, n: rows.length, error: e.message };
      this.o.log?.('[tierlist] odeslání selhalo', e.message);
      return 0;
    }
  }

  cacheFile() { return path.join(this.o.dataDir(), 'public-tier.json'); }

  /** Veřejný souhrn ze serveru (nebo z cache do 24 h) → odsunuté modely. */
  async pull(timeoutMs = 10000) {
    if (!this.pulling()) return this.crowd;
    const f = this.o.fetch || fetch;
    let rows = null;
    try {
      const r = await f(`${this.url()}/api/tierlist`, { headers: { 'user-agent': `czek-ai/${this.o.version}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      rows = Array.isArray(j?.models) ? j.models : null;
      if (rows) try { fs.writeFileSync(this.cacheFile(), JSON.stringify({ at: Date.now(), models: rows })); } catch {}
    } catch (e) {
      this.o.log?.('[tierlist] veřejný souhrn nejde stáhnout', e.message);
      try {
        const c = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8'));
        if (Date.now() - c.at < 24 * 3600000) rows = c.models;
      } catch {}
    }
    if (!rows) return this.crowd;
    this.tier = rows;
    this.lastPull = Date.now();
    const next = demoted(rows);
    const changed = next.size !== this.crowd.size || [...next].some((k) => !this.crowd.has(k));
    this.crowd = next;
    const omni = this.o.getOmni();
    if (omni) omni.crowd = new Set([...next].map((k) => { try { return omni.matchKey ? omni.matchKey(k) || k : k; } catch { return k; } }));
    if (changed) this.o.log?.('[tierlist] odsunuté podle veřejných dat:', [...next].join(', ') || 'žádné', `(z ${rows.length} modelů)`);
    return this.crowd;
  }
}

module.exports = { PublicTier, demoted, summarize, outcome, keyOf, DEFAULT_URL };
