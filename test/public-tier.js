// Veřejný tierlist (src/publicTier.js): souhrn volání, pravidlo „dav jen shazuje“, odesílání s falešným serverem,
// testy nikdy na produkci (ZDARMA_HIDDEN bez ZDARMA_SHARE_URL), cache souhrnu, odsunutí v pořadí combo (OmniRoute.arrange).
// node test/public-tier.js   (~1 s, bez sítě)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PublicTier, demoted, summarize, outcome, keyOf } = require('../src/publicTier');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ptier-'));
  try {
    // 1) druh výsledku: poražený v závodě a špatný klíč uživatele se nepočítají
    assert.strictEqual(outcome({ status: 200 }), 'ok');
    assert.strictEqual(outcome({ status: 499, duration: 2000 }), null, 'race loser ignored');
    assert.strictEqual(outcome({ status: 401 }), null, 'user key error ignored');
    assert.strictEqual(outcome({ status: 429 }), 'rate_limited');
    assert.strictEqual(outcome({ status: 402 }), 'no_credit');
    assert.strictEqual(outcome({ status: 504 }), 'timeout');
    assert.strictEqual(outcome({ status: 500, error: 'Request timed out' }), 'timeout');
    assert.strictEqual(outcome({ status: 500 }), 'fail');

    // 2) souhrn
    const s = summarize([{ key: 'a/x', kind: 'ok', duration: 100 }, { key: 'a/x', kind: 'ok', duration: 300 }, { key: 'a/x', kind: 'rate_limited' }, { key: 'b/y', kind: 'fail' }]);
    const ax = s.find((r) => r.model === 'a/x');
    assert.deepStrictEqual(ax, { model: 'a/x', ok: 2, fail: 1, rate_limited: 1, no_credit: 0, timeout: 0, p50_ms: 100 });

    // 3) dav jen shazuje: málo instalací / málo volání / nedávný úspěch → nic
    const now = Date.parse('2026-11-23T12:00:00Z');
    const rows = [
      { model: 'p/dead', installs: 6, ok: 2, fail: 60, last_ok: '2026-11-22T12:00:00Z' },
      { model: 'p/few', installs: 3, ok: 0, fail: 90, last_ok: null },
      { model: 'p/recent', installs: 8, ok: 5, fail: 80, last_ok: '2026-11-23T11:00:00Z' },
      { model: 'p/good', installs: 9, ok: 90, fail: 5, last_ok: '2026-11-23T11:59:00Z' },
      { model: 'p/little', installs: 7, ok: 0, fail: 10, last_ok: null },
    ];
    assert.deepStrictEqual([...demoted(rows, { now })], ['p/dead'], 'only broadly failing model demoted');

    // 4) klíč modelu jako v combo (ref → poskytovatel/id)
    const omni = { baseLists: new Map([['zdarma-max', [{ ref: 'nvidia/meta/llama-x', provider: 'nvidia', id: 'meta/llama-x' }]]]), nodeToProvider: new Map([['node-1', 'kilo']]), matchKey: (k) => k };
    assert.strictEqual(keyOf({ requestedModel: 'nvidia/meta/llama-x', model: 'llama-x' }, omni), 'nvidia/meta/llama-x');
    assert.strictEqual(keyOf({ requestedModel: 'zdarma-max', provider: 'node-1', model: 'particle-1:free' }, omni), 'kilo/particle-1:free');

    // 5) testy nikdy na produkci: ZDARMA_HIDDEN bez ZDARMA_SHARE_URL → nic neposílá ani nestahuje
    const settings = { shareStats: undefined };
    let calls = [];
    const fakeFetch = async (url, o) => {
      calls.push({ url, body: o?.body ? JSON.parse(o.body) : null });
      if (url.endsWith('/api/tierlist')) return { ok: true, json: async () => ({ models: rows }) };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const mk = () => new PublicTier({ dataDir: () => dir, version: '0.15.40', settings: () => settings, saveSettings: () => {}, getOmni: () => omni, fetch: fakeFetch });
    process.env.ZDARMA_HIDDEN = '1';
    delete process.env.ZDARMA_SHARE_URL;
    let pt = mk();
    assert.strictEqual(pt.sharing(), false, 'hidden test app never shares to production');
    assert.strictEqual(pt.pulling(), false);
    pt.ingest([{ id: 1, timestamp: '2026-11-23T11:00:00Z', requestedModel: 'nvidia/meta/llama-x', model: 'llama-x', status: 200, duration: 900, path: '/v1/chat/completions' }]);
    assert.strictEqual(await pt.flush(), 0);
    assert.strictEqual(calls.length, 0, 'no network in hidden mode');

    // 6) s vlastním serverem: odešle souhrn (bez dotazů/klíčů), podruhé stejné řádky ne; vypínač vypne
    process.env.ZDARMA_SHARE_URL = 'http://127.0.0.1:9';
    pt = mk();
    const row = { id: 7, timestamp: '2026-11-23T11:00:00Z', requestedModel: 'nvidia/meta/llama-x', model: 'llama-x', status: 200, duration: 900, path: '/v1/chat/completions', request: 'TAJNÝ DOTAZ', apiKey: 'nvapi-xxx' };
    pt.ingest([row, { ...row, id: 8, status: 429 }, { ...row, id: 9, status: 499, duration: 100 }]);
    assert.strictEqual(await pt.flush(), 1);
    const sent = calls.at(-1);
    assert.ok(sent.url.endsWith('/api/report'));
    assert.match(sent.body.install, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(sent.body.rows, [{ model: 'nvidia/meta/llama-x', ok: 1, fail: 1, rate_limited: 1, no_credit: 0, timeout: 0, p50_ms: 900 }]);
    assert.ok(!JSON.stringify(sent.body).includes('TAJNÝ') && !JSON.stringify(sent.body).includes('nvapi'), 'no prompts or keys sent');
    pt.ingest([row]);
    assert.strictEqual(await pt.flush(), 0, 'same rows not sent twice');
    settings.shareStats = false;
    pt.ingest([{ ...row, id: 10 }]);
    assert.strictEqual(await pt.flush(), 0, 'menu switch off → nothing sent');
    settings.shareStats = undefined;

    // 7) stažení souhrnu → odsunuté modely do OmniRoute.crowd + cache pro start bez sítě
    const crowd = await pt.pull();
    assert.deepStrictEqual([...crowd], ['p/dead']);
    assert.deepStrictEqual([...omni.crowd], ['p/dead']);
    assert.ok(fs.existsSync(path.join(dir, 'public-tier.json')), 'cached');
    const off = new PublicTier({ dataDir: () => dir, version: '0.15.40', settings: () => settings, saveSettings: () => {}, getOmni: () => null, fetch: async () => { throw new Error('offline'); } });
    assert.deepStrictEqual([...(await off.pull())], ['p/dead'], 'offline: demotions from the cached summary');

    // 8) pořadí combo: odsunutý model jde za spolehlivé (OmniRoute.arrange), ale v combo zůstane
    const { OmniRoute } = require('../src/omniroute');
    const o = Object.create(OmniRoute.prototype);
    o.deadProviders = new Set(); o.deadModels = new Set(); o.limited = new Set(); o.flaky = new Set(); o.slow = new Map();
    o.isSlow = () => false;
    o.crowd = new Set(['p/dead']);
    const base = [{ provider: 'p', id: 'dead', ref: 'p/dead' }, { provider: 'q', id: 'ok1', ref: 'q/ok1' }, { provider: 'r', id: 'ok2', ref: 'r/ok2' }];
    assert.deepStrictEqual(o.arrange(base).map((x) => x.ref), ['q/ok1', 'r/ok2', 'p/dead'], 'crowd-demoted model moved behind reliable ones, still present');
    console.log('public-tier OK');
  } finally {
    delete process.env.ZDARMA_HIDDEN; delete process.env.ZDARMA_SHARE_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
