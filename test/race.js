// Závod modelů (src/race.js) proti falešnému OmniRoute: každý krok agenta (stream + nástroje) jde na několik modelů
// najednou, vyhraje první odpovídající (silnější model má přednost GRACE ms), poražení se zruší, při selhání všech
// jde dotaz na celé combo; ostatní dotazy (titulky, /v1/models) se jen přeposílají. Plus výběr závodníků
// (OmniRoute.raceCandidates) a to, že zrušení poražení (krátké 499) nekazí statistiky modelů.
'use strict';
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { createRaceProxy, meaningful } = require('../src/race');
const { OmniRoute } = require('../src/omniroute');

const GRACE = 300;
const sse = (o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const role = { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] };
const text = (t) => ({ choices: [{ index: 0, delta: { content: t } }] });
const tool = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] };
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

// falešný OmniRoute: chování podle modelu v těle dotazu
let behave = {};
const seen = []; // { model, closedEarly, headers }
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"zdarma-max"}]}'); return; }
    const body = JSON.parse(raw || '{}');
    const rec = { model: body.model, closedEarly: false, headers: req.headers, body };
    seen.push(rec);
    const b = behave[body.model] || { delay: 50 };
    let done = false;
    res.on('close', () => { if (!done) rec.closedEarly = true; });
    const timers = [];
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    res.on('close', () => timers.forEach(clearTimeout));
    if (b.status) { later(b.delay || 0, () => { done = true; res.writeHead(b.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fake ' + b.status } })); }); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(role)); // role hned (OmniRoute to tak dělá), nesmí se počítat jako odpověď
    if (b.hang) return;
    if (b.streamError) { later(b.delay || 0, () => { done = true; res.end(sse({ error: { message: 'upstream 503' } })); }); return; }
    later(b.delay, () => {
      res.write(sse(b.tool ? tool : text('od ' + body.model)));
      if (b.cut) { later(20, () => res.destroy()); return; }
      if (b.stall) return; // po prvním obsahu už nic (spojení otevřené)
      later(30, () => { res.write(sse(text(' konec'))); res.write(sse(stop)); res.write(sse('[DONE]')); done = true; res.end(); });
    });
  });
});

let n = 3;
let cands = ['m/a', 'm/b', 'm/c'];
let racersN = null; // jako OmniRoute.raceCandidates: kolik prvních smí závodit
let poolSize = 3; // kolik kandidátů vrací falešné OmniRoute (víc než n = náhradníci)
const logs = [];
const proxy = createRaceProxy({
  hedgeMs: 0, // souběžný závod (logika přednosti, náhradníků, pauz); odstupňovaný start: test/race-hedge.js
  sticky: false, // testy jednotlivých závodů (stejné zprávy = jedna konverzace); věrnost vítězi: test/race-sticky.js
  target: () => `http://127.0.0.1:${fake.address().port}`,
  candidates: (model, k) => { const x = model === 'zdarma-max' ? cands.slice(0, Math.min(k, poolSize)) : []; if (racersN != null) x.racers = racersN; return x; },
  n: () => n,
  log: (m) => logs.push(m),
  graceMs: GRACE,
  firstOutputMs: 1500,
  stallMs: 800,
});

/** Dotaz jako plugin OpenCode; vrátí { status, winner, text, ms } (ms = do prvního obsahu). */
function ask(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const t0 = Date.now(); let first = 0;
    const req = http.request(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...extraHeaders } }, (res) => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', (c) => { out += c; if (!first && /"content":"[^"]|tool_calls/.test(out)) first = Date.now() - t0; });
      res.on('end', () => resolve({ status: res.statusCode, winner: res.headers['x-czek-race-winner'], text: out, ms: first, total: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const step = (extra = {}) => ({ model: 'zdarma-max', stream: true, messages: [{ role: 'user', content: 'ahoj' }], tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }], ...extra });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const url = await proxy.listen(0);

  // 0) meaningful: role/prázdný text ne, text/uvažování/nástroj ano
  assert.strictEqual(meaningful(role), false);
  assert.strictEqual(meaningful(text('  ')), false);
  assert.strictEqual(meaningful(text('x')), true);
  assert.strictEqual(meaningful(tool), true);
  assert.strictEqual(meaningful({ choices: [{ delta: { reasoning_content: 'hm' } }] }), true);

  // 1) nejvýš postavený odpoví první → vyhraje hned, ostatní zrušeni
  behave = { 'm/a': { delay: 100 }, 'm/b': { delay: 900 }, 'm/c': { delay: 900 } };
  seen.length = 0;
  let r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/a');
  assert.ok(r.ms < 400, `hned, ne po GRACE (${r.ms} ms)`);
  assert.ok(/od m\/a konec/.test(r.text.replace(/"\},.*?"content":"/g, '')) || (r.text.includes('od m/a') && r.text.includes(' konec')), 'celá odpověď vítěze');
  assert.ok(r.text.includes('[DONE]'));
  assert.ok(!r.text.includes('od m/b') && !r.text.includes('od m/c'), 'nic od poražených');
  await tick(50);
  assert.deepStrictEqual(seen.map((s) => s.model).sort(), ['m/a', 'm/b', 'm/c'], 'tři souběžné dotazy, každý na jeden model');
  assert.ok(seen.find((s) => s.model === 'm/b').closedEarly && seen.find((s) => s.model === 'm/c').closedEarly, 'poražení zrušeni');
  assert.ok(seen.every((s) => s.body.tools && s.body.stream && s.body.messages[0].content === 'ahoj'), 'stejné tělo, jen jiný model');

  // 2) slabší (3.) odpoví za 100 ms, silnější neodpovídají → vyhraje po GRACE; ne čekání na pomalé
  behave = { 'm/a': { delay: 3000 }, 'm/b': { delay: 3000 }, 'm/c': { delay: 100 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/c');
  assert.ok(r.ms >= GRACE && r.ms < GRACE + 400, `po GRACE (${r.ms} ms)`);

  // 3) silnější odpoví do GRACE po slabším → vyhraje silnější
  behave = { 'm/a': { delay: 250 }, 'm/b': { delay: 3000 }, 'm/c': { delay: 60 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/a', 'silnější model v rámci GRACE má přednost');
  assert.ok(!r.text.includes('od m/c'));

  // 4) 1. hned 429, 2. odpoví → vyhraje 2. hned (nikdo výš už nečeká); volání nástroje se počítá jako odpověď
  behave = { 'm/a': { status: 429, delay: 20 }, 'm/b': { delay: 120, tool: true }, 'm/c': { delay: 1000 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/b');
  assert.ok(r.ms < GRACE, `bez GRACE (${r.ms} ms)`);
  assert.ok(r.text.includes('tool_calls'));

  // 5) chyba ve streamu / visení / 503 → všichni venku → dotaz na celé combo (OmniRoute zkouší po jednom)
  behave = { 'm/a': { streamError: true, delay: 30 }, 'm/b': { hang: true }, 'm/c': { status: 503, delay: 10 }, 'zdarma-max': { delay: 20 } };
  seen.length = 0;
  r = await ask(url, step());
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('od zdarma-max'), 'záloha přes combo');
  assert.strictEqual(r.winner, undefined);
  assert.ok(seen.some((s) => s.model === 'zdarma-max'));
  assert.ok(r.total >= 1500 && r.total < 2500, `visící vypadl po limitu první odpovědi (${r.total} ms)`);
  assert.strictEqual(proxy.stats.fallbacks, 1);

  proxy.cool.clear(); // vypadlí z 5) by se jinak 1–3 min nezkoušeli
  // 6) odpovídající závodník spadne před výhrou → nesmí vyhrát useknutý, vyhraje další
  behave = { 'm/a': { delay: 1000 }, 'm/b': { delay: 50, cut: true }, 'm/c': { delay: 150 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/c', 'useknutý m/b nevyhrál');
  assert.ok(r.text.includes('[DONE]'));

  // 7) bez nástrojů (titulek), tool_choice none, n=1, model mimo tier → jen přeposlat, jeden dotaz
  behave = { 'zdarma-max': { delay: 10 }, 'zdarma-low': { delay: 10 } };
  for (const [label, body, nn] of [['bez nástrojů', step({ tools: undefined }), 3], ['tool_choice none', step({ tool_choice: 'none' }), 3], ['vypnuto', step(), 1], ['jiný model', step({ model: 'zdarma-low' }), 3], ['bez streamu', step({ stream: false }), 3]]) {
    n = nn; seen.length = 0;
    r = await ask(url, body);
    assert.strictEqual(seen.length, 1, label + ': jeden dotaz');
    assert.strictEqual(seen[0].model, body.model, label + ': model beze změny');
    assert.strictEqual(r.winner, undefined, label);
  }
  n = 3;

  // 8) ostatní cesty (GET /v1/models) projdou beze změny
  const models = await new Promise((resolve) => http.get(url + '/v1/models', (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s))); }));
  assert.strictEqual(models.data[0].id, 'zdarma-max');

  proxy.cool.clear();
  // 9) klient chce gzip / posílá chunked tělo → závodníci dostanou identity a správnou délku, odpověď čitelná
  behave = { 'm/a': { delay: 30 }, 'm/b': { delay: 500 }, 'm/c': { delay: 500 } };
  seen.length = 0;
  r = await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br', 'transfer-encoding': 'chunked' } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => { const b = Buffer.concat(parts); resolve({ winner: res.headers['x-czek-race-winner'], enc: res.headers['content-encoding'], text: (res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(b) : b).toString() }); });
    });
    req.on('error', reject);
    const s = JSON.stringify(step());
    req.write(s.slice(0, 20)); req.end(s.slice(20));
  });
  assert.strictEqual(r.winner, 'm/a');
  assert.ok(r.text.includes('od m/a'));
  assert.ok(seen.every((s) => s.headers['accept-encoding'] === 'identity' && !s.headers['transfer-encoding'] && Number(s.headers['content-length']) > 0), 'hlavičky pro OmniRoute');

  proxy.cool.clear();
  // 10) klient dotaz zruší uprostřed závodu → všichni závodníci zrušeni
  behave = { 'm/a': { hang: true }, 'm/b': { hang: true }, 'm/c': { hang: true } };
  seen.length = 0;
  await new Promise((resolve) => {
    const req = http.request(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify(step()));
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await tick(150);
  assert.strictEqual(seen.length, 3);
  assert.ok(seen.every((s) => s.closedEarly), 'po zrušení klientem nic nevisí');

  // 10b) náhradníci: 1. a 2. hned vypadnou, 3. visí → hned nastoupí 4. a 5. z pořadí (ne čekat 1,5 s na visícího
  //      a pak na combo); bench 20. 11.: první krok relace 97 s místo ~2 s
  proxy.cool.clear(); poolSize = 5; cands = ['m/a', 'm/b', 'm/c', 'm/d', 'm/e'];
  behave = { 'm/a': { status: 429, delay: 20 }, 'm/b': { streamError: true, delay: 40 }, 'm/c': { hang: true }, 'm/d': { delay: 100 }, 'm/e': { delay: 700 } };
  seen.length = 0;
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/d', 'vyhrál náhradník');
  assert.ok(r.total < 1200, `bez čekání na visícího a combo (${r.total} ms)`);
  assert.deepStrictEqual(seen.map((x) => x.model).sort(), ['m/a', 'm/b', 'm/c', 'm/d', 'm/e'], 'za každého vypadlého jeden náhradník');
  await tick(100);
  assert.ok(seen.find((x) => x.model === 'm/c').closedEarly && seen.find((x) => x.model === 'm/e').closedEarly, 'visící a pomalejší náhradník zrušeni');
  assert.ok(logs.some((l) => l.includes('místo m/a nastupuje m/d')));

  // 10c) paměť selhání: m/a (429) a m/b (chyba streamu) se teď nezkouší; poražení (m/c, m/e) ano; vítěz bez trestu
  behave = { 'm/a': { delay: 10 }, 'm/b': { delay: 10 }, 'm/c': { delay: 60 }, 'm/d': { delay: 60 }, 'm/e': { delay: 60 } };
  seen.length = 0;
  r = await ask(url, step());
  assert.deepStrictEqual(seen.map((x) => x.model).sort(), ['m/c', 'm/d', 'm/e'], 'nedávno vypadlí vynecháni: ' + seen.map((x) => x.model));
  assert.strictEqual(r.winner, 'm/c');
  assert.ok(proxy.cool.get('m/a') - Date.now() > 60000, '429 → 90 s');
  assert.ok(proxy.cool.get('m/b') - Date.now() < 61000, 'chyba streamu → 60 s');
  // 413 (kontext moc velký pro model) → 10 min
  proxy.cool.delete('m/a'); behave['m/a'] = { status: 413, delay: 5 }; seen.length = 0;
  await ask(url, step());
  assert.ok(proxy.cool.get('m/a') - Date.now() > 500000, '413 → 10 min');
  behave['m/a'] = { delay: 10 };
  // všichni kromě jednoho vypadlí → jen přeposlat na combo (OmniRoute je zkusí po jednom)
  for (const m of ['m/c', 'm/d', 'm/e']) proxy.cool.set(m, Date.now() + 60000);
  proxy.cool.delete('m/a');
  seen.length = 0;
  behave['zdarma-max'] = { delay: 10 };
  r = await ask(url, step());
  assert.deepStrictEqual(seen.map((x) => x.model), ['zdarma-max'], 'méně než 2 kandidáti → combo');
  proxy.cool.clear(); poolSize = 3; cands = ['m/a', 'm/b', 'm/c'];

  // 10d) mlčící: 1. v pořadí nikdy nezačne (jen se zruší) → 3× čekání GRACE, pak jde za ostatní a 2. vyhrává hned
  //      (bench 20. 11.: Kimi K3.1 Pro první v každém závodě, ani jednou neodpověděl)
  behave = { 'm/a': { hang: true }, 'm/b': { delay: 60 }, 'm/c': { delay: 400 } };
  const lagMs = [];
  for (let i = 0; i < 4; i++) { seen.length = 0; r = await ask(url, step()); assert.strictEqual(r.winner, 'm/b'); lagMs.push(r.ms); }
  assert.ok(lagMs.slice(0, 3).every((ms) => ms >= GRACE), 'první 3 závody čekají na silnější m/a: ' + lagMs);
  assert.ok(lagMs[3] < GRACE, '4. závod bez čekání, m/a je za ostatními: ' + lagMs);
  assert.ok(proxy.lag.get('m/a').until > Date.now(), 'm/a odsunutý na 10 min');
  assert.ok(!seen.some((x) => x.model === 'm/a'), 'odsunutý se nespouští (jen náhradník) – žádný dotaz navíc');
  assert.ok(logs.some((l) => l.includes('m/a 3× za sebou nezačal včas')));
  // když ostatní vypadnou, nastoupí jako náhradník; když vyhraje, odsunutí končí
  behave = { 'm/a': { delay: 30 }, 'm/b': { status: 429, delay: 5 }, 'm/c': { status: 503, delay: 5 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/a');
  assert.ok(!proxy.lag.has('m/a'), 'vítěz bez odsunutí');
  proxy.lag.clear(); proxy.cool.clear(); // m/b, m/c vypadly výš

  // 10f) jen jeden spolehlivý (racers = 1): běží sám, ostatní nespouští; po jeho selhání nastoupí náhradník
  racersN = 1; behave = { 'm/a': { delay: 40 }, 'm/b': { delay: 40 }, 'm/c': { delay: 40 } }; seen.length = 0;
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/a'); await tick(50);
  assert.deepStrictEqual(seen.map((x) => x.model), ['m/a'], 'jediný závodník, žádný dotaz navíc');
  behave['m/a'] = { status: 429, delay: 10 }; seen.length = 0;
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/b', 'po selhání nastoupil náhradník');
  racersN = null; proxy.cool.clear();

  // 10e) vítěz po prvním obsahu zmlkne → po stallMs chyba ve streamu (OpenCode krok zopakuje), model na pauze
  //      (bench 20. 11.: Mistral Large 4 začal za 2,5 s, pak 6,5 min nic)
  behave = { 'm/a': { delay: 30, stall: true }, 'm/b': { delay: 900 }, 'm/c': { delay: 900 } };
  r = await ask(url, step());
  assert.strictEqual(r.winner, 'm/a');
  assert.ok(r.total >= 800 && r.total < 1600, `ukončeno po stallMs (${r.total} ms)`);
  assert.ok(r.text.includes('"code":"stream_stalled"'), 'chyba ve streamu pro klienta');
  assert.ok(proxy.cool.get('m/a') - Date.now() > 100000, 'zmlklý vítěz na pauze');
  assert.ok(logs.some((l) => l.includes('vítěz m/a') && l.includes('neposlal data')));
  // běžný stream do konce hlídač nezastaví
  proxy.cool.clear();
  behave = { 'm/a': { delay: 30 }, 'm/b': { delay: 900 }, 'm/c': { delay: 900 } };
  r = await ask(url, step());
  assert.ok(!r.text.includes('stream_stalled') && r.text.includes('[DONE]'));
  proxy.cool.clear();

  // 11) OmniRoute neběží → 502, ne pád proxy
  const dead = createRaceProxy({ target: () => null, candidates: () => ['m/a', 'm/b'], n: () => 3 });
  const durl = await dead.listen(0);
  r = await ask(durl, step());
  assert.strictEqual(r.status, 502);
  await dead.close();

  // 12) stálý port: obsazený → jiný volný
  const p1 = createRaceProxy({ target: () => null, candidates: () => [], n: () => 0 });
  const p2 = createRaceProxy({ target: () => null, candidates: () => [], n: () => 0 });
  const u1 = await p1.listen(0);
  const port = Number(new URL(u1).port);
  const u2 = await p2.listen(port);
  assert.notStrictEqual(u2, u1, 'obsazený port → jiný');
  await p1.close(); await p2.close();

  // 13) výběr závodníků: v pořadí combo, každý od jiného poskytovatele a přednostně jiný model, nejdřív spolehliví; < 2 → nezávodit
  const base = [
    { ref: 'zai/glm-4.7-flash', provider: 'zai', id: 'glm-4.7-flash' },
    { ref: 'zai/glm-4.5-flash', provider: 'zai', id: 'glm-4.5-flash' },
    { ref: 'z-kilo/nemotron', provider: 'kilo', id: 'nemotron' },
    { ref: 'openrouter/nemotron:free', provider: 'openrouter', id: 'nemotron:free' },
    { ref: 'gemini/gemini-3-flash', provider: 'gemini', id: 'gemini-3-flash' },
  ];
  const now = Date.now(); let seq = 0;
  const row = (provider, model, status, minAgo, duration = 6000) => ({ id: 'r' + (seq++), timestamp: new Date(now - minAgo * 60000).toISOString(), provider, model, status, duration, path: '/chat/completions' });
  const mk = async (rows) => {
    const o = new OmniRoute({ dataDir: 'x' });
    o.nodeToProvider = new Map([['zai', 'zai'], ['n-kilo', 'kilo'], ['openrouter', 'openrouter'], ['gemini', 'gemini']]);
    o.baseLists = new Map([['zdarma-max', base], ['zdarma-one', base.slice(0, 2)]]);
    o.api = async () => rows; await o.loadSpeed();
    return o;
  };
  let o = await mk([]);
  // Nemotron od OpenRouteru = stejný model jako od Kila → místo něj Gemini (různé modely, bench 20. 11.)
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 3)], ['zai/glm-4.7-flash', 'z-kilo/nemotron', 'gemini/gemini-3-flash']);
  // s náhradníky: další poskytovatelé v pořadí (i stejný model)
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 7)], ['zai/glm-4.7-flash', 'z-kilo/nemotron', 'gemini/gemini-3-flash', 'openrouter/nemotron:free']);
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 1)], [], 'n < 2 → nezávodit');
  assert.deepStrictEqual([...o.raceCandidates('zdarma-one', 3)], [], 'jen jeden poskytovatel → nezávodit');
  assert.deepStrictEqual([...o.raceCandidates('neznamy', 3)], []);
  o.comboIdName = new Map([['029f092d-b7d8-49d9-89b8-19159118fbe3', 'zdarma-max']]); // dynamický katalog pluginu posílá id combo
  assert.strictEqual(o.raceCandidates('029f092d-b7d8-49d9-89b8-19159118fbe3', 3).length, 3, 'combo i podle id');
  // GLM 4.7 jen selhává → za spolehlivé, místo něj GLM 4.5 (stejný poskytovatel); 429 OpenRouter → doplní Gemini
  o = await mk([row('zai', 'glm-4.7-flash', 529, 1, 500), ...[1, 2, 3, 4, 5, 6, 7, 8].map((m) => row('openrouter', 'nemotron:free', 429, m, 300))]);
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 3)], ['zai/glm-4.5-flash', 'z-kilo/nemotron', 'gemini/gemini-3-flash']);

  // 13b) závodníci jen z prvních 6 v pořadí (různý model hlouběji v tieru nezávodí), náhradníci smějí i níž
  const deep = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => ({ ref: `${p}/nemotron`, provider: p, id: 'nemotron' }))
    .concat([{ ref: 'g/mistral-large', provider: 'g', id: 'mistral-large' }, { ref: 'h/gpt-oss', provider: 'h', id: 'gpt-oss' }]);
  o = await mk([]);
  o.nodeToProvider = new Map('abcdefgh'.split('').map((p) => [p, p]));
  o.baseLists = new Map([['zdarma-max', deep]]);
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 3, 3)], ['a/nemotron', 'b/nemotron', 'c/nemotron'], 'Mistral/gpt-oss (7./8.) nezávodí');
  assert.deepStrictEqual([...o.raceCandidates('zdarma-max', 7, 3)].slice(3), ['d/nemotron', 'e/nemotron', 'g/mistral-large', 'h/gpt-oss'], 'náhradníci: napřed spolehliví ze špičky tieru, pak i hlouběji');

  // 13c) závodit smějí jen spolehliví: pomalý / nespolehlivý jen jako náhradník (živě 20. 11.: Kimi 57 závodů bez odpovědi)
  o = await mk([row('zai', 'glm-4.7-flash', 529, 1, 500), row('zai', 'glm-4.5-flash', 529, 2, 500)]); // zai jen selhává
  const rcs = o.raceCandidates('zdarma-max', 6, 2);
  assert.strictEqual(rcs.racers, 3, 'spolehliví kilo, openrouter, gemini');
  assert.ok(rcs.indexOf('zai/glm-4.7-flash') >= rcs.racers || rcs.indexOf('zai/glm-4.5-flash') >= rcs.racers, 'nespolehlivý Z.ai jen za závodníky: ' + rcs);

  // 14) zrušení poražení (499 do 30 s) nejsou selhání: 8× 499 po 0,8 s bez jediné odpovědi → model dál spolehlivý
  o = await mk([1, 2, 3, 4, 5, 6, 7, 8].map((m) => row('zai', 'glm-4.7-flash', 499, m, 800)));
  assert.strictEqual(o.flaky.size, 0, 'krátké 499 se nepočítají');
  assert.strictEqual(o.deadModels.size, 0);
  assert.strictEqual(o.arrange(base)[0].ref, 'zai/glm-4.7-flash');
  // visení 499 po 45 s se počítá dál
  o = await mk([1, 2].map((m) => row('zai', 'glm-4.7-flash', 499, m, 45000)));
  assert.ok(o.deadModels.has('zai/glm-4.7-flash'), 'visení do limitu se počítá dál');

  await proxy.close();
  fake.close();
  console.log(`race OK (${proxy.stats.races} závodů, záloha ${proxy.stats.fallbacks}×; ${logs.length} řádků logu)`);
})().catch((e) => { console.error(e); process.exit(1); });
