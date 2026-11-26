'use strict';
// Kontrola zdraví a poskytovatelé bez klíče (limit na IP: Kilo, OVH, LLM7, Pollinations). Ve třídě sdílí jednu IP 30 instalací:
// 26. 11. kontrola posílala až 7 dotazů na Kilo za kolo → 30 × 7 = 210 > ~200/h a limit by vyčerpaly kontroly samy.
// Ověřuje: nejvýš 2 dotazy na takového poskytovatele za kolo (i s opakovanými pokusy u modelů v limitu), poskytovatelé s klíčem
// bez omezení, ZDARMA_PROBE_SHARED_MAX mění strop. Bez sítě. node test/omni-probe-shared.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run(env) {
  for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[require.resolve('../src/omniroute')];
  const { OmniRoute } = require('../src/omniroute');
  const hits = {}; const ids = [];
  const mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const ref = String(JSON.parse(raw || '{}').model || ''); const prov = ref.split('/')[0].replace(/^z-/, '');
      hits[prov] = (hits[prov] || 0) + 1; ids.push(ref);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-shared-'));
  try {
    const o = new OmniRoute({ dataDir: dir, log: () => {} });
    const m = (provider, id) => ({ ref: `${provider === 'nvidia' ? '' : 'z-'}${provider}/${id}`, provider, id });
    const base = [m('kilo', 'ernie'), m('kilo', 'nemo'), m('nvidia', 'ultra'), m('kilo', 'particle'), m('kilo', 'glyph'), m('ovh', 'qwen'), m('nvidia', 'kimi'), m('kilo', 'beam'), m('kilo', 'auto')];
    o.baseLists = new Map([['zdarma-max', base]]);
    // dva modely Kilo „v limitu“ se starým 429 → opakovaný pokus by je jinak přidal navíc
    o.limited = new Set(['kilo/beam', 'kilo/auto']);
    o.limitedAt = new Map([['kilo/beam', Date.now() - 3600e3], ['kilo/auto', Date.now() - 3600e3]]);
    o.ready = true; o.port = mock.address().port; o.apiKey = 'k'.repeat(32); o.syncCooldowns = async () => {};
    const r = await o.probeHeads({ combos: ['zdarma-max'], k: 20, timeoutMs: 2000, slowTimeoutMs: 0, concurrency: 8, force: true });
    return { hits, ids, probed: r.probed };
  } finally { mock.closeAllConnections?.(); await new Promise((r) => mock.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  const a = await run({ ZDARMA_PROBE_SHARED_MAX: null });
  assert.strictEqual(a.hits.kilo, 2, 'Kilo nejvýš 2 dotazy za kolo (včetně modelů v limitu): ' + JSON.stringify(a.hits));
  assert.deepStrictEqual(a.ids.filter((x) => x.startsWith('z-kilo/')).sort(), ['z-kilo/auto', 'z-kilo/beam'], 'strop dostanou přednostně modely v limitu (návrat špičky): ' + a.ids.join(','));
  assert.strictEqual(a.hits.ovh, 1, 'OVH jeho jediný model');
  assert.strictEqual(a.hits.nvidia, 2, 'poskytovatel s klíčem bez omezení');
  const b = await run({ ZDARMA_PROBE_SHARED_MAX: '5' });
  assert.strictEqual(b.hits.kilo, 5, 'strop jde změnit');
  delete process.env.ZDARMA_PROBE_SHARED_MAX;
  console.log(`omni-probe-shared OK (Kilo ${a.hits.kilo} dotazy místo 7 z 7 modelů, OVH ${a.hits.ovh}, NVIDIA ${a.hits.nvidia}; strop 5 → ${b.hits.kilo})`);
})().catch((e) => { console.error(e); process.exit(1); });
