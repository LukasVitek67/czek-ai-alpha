// Synchronizace přeskakuje combo, která už v OmniRoute stojí beze změny (po restartu Zdarmy je paměť prázdná),
// a zapisuje souběžně (nejvýše 6). Falešné API OmniRoute drží combo v jeho tvaru ({ model: "<ref>", ... }).
'use strict';
const assert = require('assert');
const { OmniRoute } = require('../src/omniroute');

const PROVIDERS = [
  { p: { id: 'groq', name: 'Groq' }, enabled: true, key: 'test-key-groq' },
  { p: { id: 'cerebras', name: 'Cerebras' }, enabled: true, key: 'test-key-cerebras' },
];
// 24 modelů: společné slugy u obou poskytovatelů (sjednocené combo) i jednotlivé
const models = [];
for (let i = 0; i < 24; i++) {
  const slug = `model-${String(i).padStart(2, '0')}-${i % 3 ? 'pro' : 'flash'}`;
  models.push({ key: `groq/${slug}`, provider: 'groq', id: slug, name: slug, usable: true, tools: true });
  if (i % 2 === 0) models.push({ key: `cerebras/${slug}`, provider: 'cerebras', id: slug, name: slug, usable: true, tools: true });
}
const registry = {
  providers: () => PROVIDERS,
  autoOrder: (ms) => ms,
  isUncensored: () => false,
  familyRank: () => -1,
};
const settings = {};

// Falešné API: stav combo a připojení jako v OmniRoute; zápisy se zdrží 5 ms, aby šla měřit souběžnost
function fakeOmni(store) {
  const st = { store, puts: 0, posts: 0, inflight: 0, maxInflight: 0, comboWrites: [], conns: [] };
  const toStored = (body, id) => ({
    id, name: body.name, displayName: body.displayName, description: body.description,
    strategy: body.strategy, context_length: body.context_length, config: body.config,
    models: body.models.map((ref, i) => ({ id: `${body.name}-model-${i + 1}`, kind: 'model', model: ref, providerId: ref.split('/')[0], weight: 0 })),
  });
  st.api = async (method, p, body) => {
    if (method === 'GET' && p === '/api/provider-nodes') return { nodes: [] };
    if (method === 'GET' && p === '/api/providers') return { connections: st.conns };
    if (method === 'POST' && p === '/api/providers') {
      const c = { id: 'conn-' + (st.conns.length + 1), provider: body.provider, name: body.name };
      st.conns.push(c);
      return { connection: c };
    }
    if (method === 'PUT' && p.startsWith('/api/providers/')) { st.connPuts = (st.connPuts || 0) + 1; return {}; }
    if (method === 'GET' && p === '/api/combos') return { combos: st.store.slice() }; // kopie jako ze skutečného API (mazání za běhu nepřeskočí prvky)
    if (method === 'GET' && p.startsWith('/api/usage/call-logs')) return st.rows || [];
    if (method === 'GET' && p.startsWith('/api/provider-models')) return { models: [] };
    if (method === 'POST' && p === '/api/combos/import') { // hromadný import nových combo (mode merge)
      st.comboWrites.push(`${method} ${p}`);
      st.imports = (st.imports || 0) + 1;
      if (st.failImport) throw new Error('500 import nejde');
      const created = [], skipped = [];
      for (const b of body.combos) {
        if (st.store.some((c) => c.name === b.name)) { skipped.push(b.name); continue; }
        st.store.push(toStored(b, 'combo-' + (st.store.length + 1))); st.imported = (st.imported || 0) + 1; created.push(b.name);
      }
      return { mode: body.mode, created, skipped, removed: 0, warnings: [] };
    }
    if (method === 'POST' || method === 'PUT') {
      if (p.startsWith('/api/combos')) {
        st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
        await new Promise((r) => setTimeout(r, 5));
        st.inflight--;
        st.comboWrites.push(`${method} ${p}`);
        if (method === 'POST') {
          st.posts++;
          const id = 'combo-' + (st.store.length + 1);
          st.store.push(toStored(body, id));
          return { id };
        }
        const id = decodeURIComponent(p.split('/').pop());
        const i = st.store.findIndex((c) => c.id === id);
        st.store[i] = toStored(body, id);
        st.puts++;
        return {};
      }
    }
    if (method === 'DELETE') {
      if (p.startsWith('/api/combos/')) { const id = decodeURIComponent(p.split('/').pop()); const i = st.store.findIndex((c) => c.id === id); if (i >= 0) st.store.splice(i, 1); }
      return {};
    }
    throw new Error('neočekávané volání ' + method + ' ' + p);
  };
  return st;
}

function engine(st, dataDir = 'x') {
  const eng = new OmniRoute({ dataDir, log: () => {} });
  eng.ready = true;
  eng.dashboard = true;
  eng.api = st.api;
  return eng;
}

(async () => {
  // 1) prázdné OmniRoute: všechna nová combo jedním importem (dřív 160× POST po jednom: 13 s na skutečném OmniRoute)
  const store = [];
  const first = fakeOmni(store);
  const e1 = engine(first);
  await e1.sync({ registry, models, settings });
  assert.equal(first.imports, 1, 'jeden hromadný import');
  assert.ok(first.imported >= 10, `importem založeno víc combo (dostal jsem ${first.imported})`);
  assert.equal(first.posts, 0, 'žádný POST po jednom');
  assert.equal(first.puts, 0);
  for (const name of e1.baseLists.keys()) assert.ok(e1.applied.get(name)?.startsWith('{'), 'importované combo je v paměti zapsaných: ' + name);

  // 1b) import selže → postaru po jednom, souběžně 2–6, výsledek stejný
  const storeB = [];
  const firstB = fakeOmni(storeB);
  firstB.failImport = true;
  await engine(firstB).sync({ registry, models, settings });
  assert.equal(firstB.posts, first.imported, 'po selhání importu stejný počet combo po jednom');
  assert.ok(firstB.maxInflight >= 2 && firstB.maxInflight <= 6, `souběžnost zápisů 2–6 (je ${firstB.maxInflight})`);
  assert.deepEqual(storeB.map((c) => c.name).sort(), store.map((c) => c.name).sort(), 'import i záloha založí stejná combo');

  // 2) nová instance (paměť prázdná), OmniRoute má stejná combo → 0 zápisů combo
  const second = fakeOmni(store);
  const e2 = engine(second);
  const r2 = await e2.sync({ registry, models, settings });
  assert.deepEqual(second.comboWrites, [], 'beze změny se combo nezapisuje');
  assert.equal(r2.combos, e2.combos.size);
  // paměť se naplní stejným tvarem jako rebalance (JSON s „{“)
  for (const name of e2.baseLists.keys()) assert.ok(e2.applied.get(name).startsWith('{'), name);

  // 3) rebalance bez změny rychlostí nezapíše žádné combo
  const r3 = await e2.rebalance();
  assert.equal(r3.changed, 0);
  assert.deepEqual(second.comboWrites, [], 'rebalance po synchronizaci nic nepřepisuje');

  // 4) jedno combo se v OmniRoute liší (smazaný model) → přesně 1 zápis
  const target = store[0];
  target.models = target.models.slice(1);
  const third = fakeOmni(store);
  const e3 = engine(third);
  await e3.sync({ registry, models, settings });
  assert.deepEqual(third.comboWrites, [`PUT /api/combos/${encodeURIComponent(target.id)}`], 'jen změněné combo');

  // 5) změněný displayName v OmniRoute → 1 zápis (jiné pole než modely)
  const t2 = store[1];
  t2.displayName = 'Ručně přejmenováno';
  const fourth = fakeOmni(store);
  await engine(fourth).sync({ registry, models, settings });
  assert.equal(fourth.comboWrites.length, 1, 'displayName se porovnává');

  // 6) OmniRoute vrátí stejné sjednocené combo s jiným pořadím poskytovatelů v závorce (živé skóre) → 0 zápisů
  const united = store.filter((c) => c.description === 'zdarma-united' && c.name !== t2.name && /\(.*, .*\)$/.test(c.displayName));
  assert.ok(united.length >= 2, 'testovací data mají sjednocená combo se dvěma poskytovateli');
  const [uOrder, uModels] = united;
  uOrder.displayName = uOrder.displayName.replace(/\(([^)]*)\)$/, (_, p) => `(${p.split(', ').reverse().join(', ')})`);
  const fifth = fakeOmni(store);
  await engine(fifth).sync({ registry, models, settings });
  assert.deepEqual(fifth.comboWrites, [], 'pořadí poskytovatelů v závorce se nepočítá jako změna');

  // 7) změněné pořadí MODELŮ v combo (strategie lkgp podle něj vybírá) → přesně 1 zápis
  uModels.models = [uModels.models[1], uModels.models[0], ...uModels.models.slice(2)];
  const sixth = fakeOmni(store);
  await engine(sixth).sync({ registry, models, settings });
  assert.deepEqual(sixth.comboWrites, [`PUT /api/combos/${encodeURIComponent(uModels.id)}`], 'změna pořadí modelů se zapíše');

  // 8) mrtvý model (4× po sobě visel 45 s): první start ho z combo vyhodí, DRUHÝ start už nic nezapíše.
  //    Dřív se pořadí při startu skládalo bez znalosti mrtvých → model se vrátil a rebalance ho zase vyhazoval.
  const clean = [];
  await engine(fakeOmni(clean)).sync({ registry, models, settings });
  const probe = engine(fakeOmni(clean));
  await probe.sync({ registry, models, settings });
  const auto = [...probe.baseLists.keys()].find((n) => /auto/.test(n));
  const victim = probe.baseLists.get(auto)[0];
  const hangs = [4, 3, 2, 1].map((m, i) => ({ id: 'h' + i, timestamp: new Date(Date.now() - m * 60000).toISOString(), provider: victim.provider, model: victim.id, status: 499, duration: 45000, path: '/chat/completions' }));
  const withDead = fakeOmni(clean);
  withDead.rows = hangs;
  const eD = engine(withDead);
  await eD.sync({ registry, models, settings });
  assert.ok(eD.deadModels.has(`${victim.provider}/${victim.id}`), 'visící model je mrtvý už při synchronizaci');
  assert.ok(withDead.comboWrites.length >= 1, 'combo s mrtvým modelem se přepíšou');
  assert.ok(clean.filter((c) => c.models.some((m) => m.model === victim.ref)).length === 0, 'mrtvý model není v žádném uloženém combo');
  const again = fakeOmni(clean);
  again.rows = hangs;
  await engine(again).sync({ registry, models, settings });
  assert.deepEqual(again.comboWrites, [], 'další start: mrtvý model se do combo nevrací, žádný zápis');
  // test připojení (200) mrtvý model ani poskytovatele neoživí
  const tested = fakeOmni(clean);
  tested.rows = [...hangs, { id: 't1', timestamp: new Date().toISOString(), provider: victim.provider, model: 'connection-test', status: 200, duration: 300, path: '/api/providers/test' }];
  const eT = engine(tested);
  await eT.sync({ registry, models, settings });
  assert.ok(eT.deadModels.has(`${victim.provider}/${victim.id}`) && tested.comboWrites.length === 0, 'connection-test nic nemění');

  // 9) otisky klíčů přežijí restart (soubor v dataDir): druhý start připojení nepřepisuje, změněný klíč ano (1×)
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'zd-synchash-'));
  try {
    const cs = [];
    const k1 = fakeOmni(cs); const conns = k1.conns;
    await engine(k1, dir).sync({ registry, models, settings });
    assert.equal(k1.connPuts, PROVIDERS.length, 'první start zapíše klíč každého připojení');
    const saved = require('fs').readFileSync(require('path').join(dir, 'zdarma-sync.json'), 'utf8');
    assert.ok(!PROVIDERS.some((p) => saved.includes(p.key)), 'v souboru jsou jen otisky, žádný klíč');
    const k2 = fakeOmni(cs); k2.conns = conns;
    await engine(k2, dir).sync({ registry, models, settings });
    assert.equal(k2.connPuts || 0, 0, 'druhý start: žádný zápis připojení');
    const k3 = fakeOmni(cs); k3.conns = conns;
    const changed = PROVIDERS.map((p, i) => (i ? p : { ...p, key: 'test-key-groq-NEW' }));
    await engine(k3, dir).sync({ registry: { ...registry, providers: () => changed }, models, settings });
    assert.equal(k3.connPuts, 1, 'změněný klíč se zapíše (jen ten jeden)');
  } finally { require('fs').rmSync(dir, { recursive: true, force: true }); }

  // 10) sjednocený model bez živého poskytovatele (všichni členové mrtví: účet bez kreditu 402) se nezapíše a zmizí
  //     z nabídky; sjednocený model s aspoň jedním živým poskytovatelem zůstane; tierlisty zůstanou vždy
  const deadStore = [];
  const pre = fakeOmni(deadStore);
  const preEng = engine(pre);
  await preEng.sync({ registry, models, settings });
  const unitedBefore = deadStore.filter((c) => c.description === 'zdarma-united');
  const groqOnly = unitedBefore.filter((c) => c.models.every((m) => m.model.startsWith('groq/')));
  assert.ok(groqOnly.length >= 3, 'testovací data mají sjednocené modely jen od groq: ' + groqOnly.length);
  const d = fakeOmni(deadStore);
  d.rows = [{ id: 'p402', timestamp: new Date().toISOString(), provider: 'groq', model: groqOnly[0].models[0].model.replace(/^groq\//, ''), status: 402, duration: 300, path: '/chat/completions' }];
  d.conns = pre.conns; // stejná připojení a otisky klíčů jako při 2. startu (klíč se nezměnil → 402 pořád platí)
  const eDead = engine(d);
  eDead.keyHashes = new Map(preEng.keyHashes);
  await eDead.sync({ registry, models, settings });
  const unitedAfter = deadStore.filter((c) => c.description === 'zdarma-united');
  assert.ok(unitedAfter.every((c) => c.models.some((m) => !m.model.startsWith('groq/'))), 'žádný sjednocený model jen s mrtvým poskytovatelem');
  assert.strictEqual(unitedAfter.length, unitedBefore.length - groqOnly.length, 'smazané jsou přesně ty bez živého poskytovatele');
  assert.ok(!groqOnly.some((c) => eDead.combos.has(c.name)), 'nejsou ani v seznamu combo appky');
  assert.ok(deadStore.some((c) => c.description === 'zdarma-tier'), 'tierlisty zůstávají');

  console.log(`omni-sync-skip OK (1. start ${first.imported} combo jedním importem, záloha po jednom souběžně max ${firstB.maxInflight}; druhý start 0 zápisů; rebalance 0; změněné combo 1)`);
})().catch((e) => { console.error(e); process.exit(1); });
