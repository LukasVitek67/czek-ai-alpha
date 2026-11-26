'use strict';
// Seznamy modelů od poskytovatelů z minula (src/agent.js ModelRegistry, opts.cacheFile): start nečeká na nejpomalejšího
// poskytovatele. Ověřuje: 1) bez cache se čeká na všechny (jako dřív) a seznamy se uloží; 2) s cache pomalý poskytovatel
// do waitMs dostane seznam z minula, rychlý čerstvý; 3) čerstvý seznam pomalého se doplní na pozadí do cache;
// 4) rychlá chyba (neplatný klíč) se seznamem z minula NEschová. Bez sítě. node test/registry-cache.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../src/providers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-regcache-'));
const cacheFile = path.join(dir, 'provider-models.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const behaviour = { fast: { ms: 10, ids: ['f1', 'f2'] }, slow: { ms: 10, ids: ['s1'] }, broken: { ms: 10, ids: ['b1'] } };
const fake = (id) => ({ id, name: id, needsKey: false, baseUrl: 'http://x', headers: () => ({}),
  async listModels() { const b = behaviour[id]; await wait(b.ms); if (b.fail) throw new Error('HTTP 401: bad key'); return b.ids.map((m) => ({ id: m, raw: { big: true } })); } });
providers.PROVIDERS.splice(0, providers.PROVIDERS.length, fake('fast'), fake('slow'), fake('broken'));
const { ModelRegistry } = require('../src/agent');
const settings = { providers: {} };
const ids = (r) => r.models.map((m) => m.key).sort();

(async () => {
  try {
    // 1) bez cache: čeká na všechny, uloží
    behaviour.slow.ms = 300;
    const r1 = new ModelRegistry(() => settings, { cacheFile, waitMs: 100 });
    let t = Date.now(); const a = await r1.list(); const t1 = Date.now() - t;
    assert.deepEqual(ids(a), ['broken/b1', 'fast/f1', 'fast/f2', 'slow/s1']);
    assert.ok(t1 >= 280, `bez cache se čeká na pomalého (${t1} ms)`);
    const disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.deepEqual(Object.keys(disk.providers).sort(), ['broken', 'fast', 'slow']);
    assert.ok(!JSON.stringify(disk).includes('"raw"'), 'surová data poskytovatele se neukládají');

    // 2) nový start s cache: pomalý (2 s) → seznam z minula do waitMs; rychlý čerstvý (nový model f3)
    behaviour.slow.ms = 2000; behaviour.slow.ids = ['s1', 's2']; behaviour.fast.ids = ['f1', 'f2', 'f3'];
    const r2 = new ModelRegistry(() => settings, { cacheFile, waitMs: 100 });
    t = Date.now(); const b = await r2.list(); const t2 = Date.now() - t;
    assert.ok(t2 < 600, `s cache se na pomalého nečeká (${t2} ms)`);
    assert.deepEqual(ids(b), ['broken/b1', 'fast/f1', 'fast/f2', 'fast/f3', 'slow/s1']);
    assert.equal(b.status.slow.cached, true, 'pomalý poskytovatel je ze seznamu z minula');
    assert.ok(!b.status.fast.cached, 'rychlý je čerstvý');

    // 3) čerstvý seznam pomalého se doplní na pozadí: na disku i v dalším list()
    await wait(2200);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).providers.slow.list.map((m) => m.id), ['s1', 's2']);
    behaviour.slow.ms = 10;
    assert.ok(ids(await r2.list()).includes('slow/s2'), 'další list() má čerstvý seznam pomalého');

    // 4) rychlá chyba (401) se seznamem z minula neschová
    behaviour.broken.fail = true;
    const r3 = new ModelRegistry(() => settings, { cacheFile, waitMs: 100 });
    const c = await r3.list();
    assert.equal(c.status.broken.state, 'error');
    assert.ok(!ids(c).some((k) => k.startsWith('broken/')), 'poskytovatel s chybou nemá modely z minula');

    // 5) bez cacheFile se chová jako dřív (ostatní místa v kódu a testy)
    behaviour.slow.ms = 300; behaviour.broken.fail = false;
    t = Date.now(); await new ModelRegistry(() => settings).list(); assert.ok(Date.now() - t >= 280, 'bez cacheFile se čeká');
    console.log(`registry-cache OK (bez cache ${t1} ms, s cache ${t2} ms místo ~2000 ms; čerstvý seznam doplněn na pozadí; chyba se neschová)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
