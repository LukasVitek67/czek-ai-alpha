// Monitor (src/monitor.js): z volání OmniRoute, úplného záznamu volání, stavu závodu a OmniRoute, událostí relací
// OpenCode a logu guardu složí stav modelů (funguje / mrtvý / limit / nespolehlivý / pomalý / pauza / odsunutý,
// úspěšnost, medián, čas do první odpovědi, tokeny/s) a upozornění (OmniRoute neběží, většina pokusů selhává, model
// opakovaně selhává, dlouhý krok, záloha závodu, zmlklý vítěz, relace opakuje / chyba / stojí, zásahy guardu).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Monitor, alertText } = require('../src/monitor');

const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-monitor-'));
const m = new Monitor({ logDir: () => dir });

// falešné OmniRoute: combo se třemi modely, stav modelů
const omniEngine = {
  baseLists: new Map([['zdarma-max', [
    { ref: 'z-kilo/nemotron:free', provider: 'kilo', id: 'nemotron:free' },
    { ref: 'gemini/gemini-3-flash', provider: 'gemini', id: 'gemini-3-flash' },
    { ref: 'nvidia/kimi-k3.1-pro', provider: 'nvidia', id: 'kimi-k3.1-pro' },
    { ref: 'huggingface/x', provider: 'huggingface', id: 'x' },
  ]]]),
  nodeToProvider: new Map([['n-kilo', 'kilo']]),
  deadProviders: new Set(['huggingface']), deadModels: new Set(), limited: new Set(['gemini/gemini-3-flash']), flaky: new Set(), slow: new Set(['nvidia/kimi-k3.1-pro']),
};
let id = 0;
const row = (requested, status, min, duration = 3000, error = '') => ({ id: 'r' + (++id), timestamp: ago(min), provider: 'p', model: requested.split('/').pop(), requestedModel: requested, status, duration, error, path: '/v1/chat/completions' });
m.addOmniRows([
  ...[1, 2, 3, 4, 5, 6].map((x) => row('z-kilo/nemotron:free', 200, x, 2500)),
  row('z-kilo/nemotron:free', 499, 1, 900), // poražený v závodě – ne selhání
  ...[1, 2, 3, 4].map((x) => row('gemini/gemini-3-flash', 429, x, 200, 'All credentials cooling down')),
  row('nvidia/kimi-k3.1-pro', 499, 2, 45000), // visel do limitu – selhání
  row('huggingface/x', 402, 70), // starší než hodina – v tabulce ne
  { id: 'sync', timestamp: ago(1), model: 'model-sync', status: 200 }, // interní – ven
  { id: 'old', timestamp: ago(200), requestedModel: 'z-kilo/nemotron:free', status: 200 }, // > 2 h – zahozeno
]);
assert.ok(!m.omniRows.has('old') && !m.omniRows.has('sync'));

// úplný záznam volání (souhrny z src/callLog.js)
const calls = [
  { id: 'c1', t: now - 60000, kind: 'agent', combo: 'zdarma-max', model: 'z-kilo/nemotron:free', ttftMs: 2100, totalMs: 6000, outTokens: 300, tokPerS: 77, finish: 'tool_calls', tools: ['edit'], race: { n: 3, winner: 'z-kilo/nemotron:free', rank: 0, fallback: false, stalled: false, failed: [] } },
  { id: 'c2', t: now - 50000, kind: 'agent', combo: 'zdarma-max', model: 'z-kilo/nemotron:free', ttftMs: 2900, totalMs: 150000, outTokens: 9000, tokPerS: 61, finish: 'stop', tools: [], race: { n: 3, winner: 'z-kilo/nemotron:free', rank: 0 } },
  { id: 'c3', t: now - 40000, kind: 'agent', combo: 'zdarma-max', model: 'zdarma-max', ttftMs: 9000, totalMs: 20000, tools: [], race: { n: 3, winner: null, fallback: true } },
  { id: 'c4', t: now - 30000, kind: 'agent', combo: 'zdarma-max', model: 'nvidia/kimi-k3.1-pro', ttftMs: 1000, totalMs: 91000, tools: [], error: 'czek-ai: model přestal odpovídat', race: { n: 3, winner: 'nvidia/kimi-k3.1-pro', stalled: true } },
  { id: 'c5', t: now - 20000, kind: 'bez nástrojů', combo: 'zdarma-low', model: 'zdarma-low', error: 'zrušeno klientem (OpenCode)', tools: [] },
];

// události relací OpenCode
const ev = (type, properties, directory = 'C:\\proj') => ({ directory, payload: { type, properties } });
m.onOcEvent(ev('session.status', { sessionID: 's1', status: { type: 'busy' } }), now - 600000);
m.onOcEvent(ev('message.part.updated', { part: { id: 'p1', sessionID: 's1', type: 'step-finish', tokens: { input: 40000, output: 300 } } }), now - 420000);
m.onOcEvent(ev('message.part.updated', { part: { id: 'p1', sessionID: 's1', type: 'step-finish', tokens: { input: 40000, output: 300 } } }), now - 420000); // stejný díl znovu
m.onOcEvent(ev('message.updated', { info: { id: 'm1', sessionID: 's1', role: 'assistant', providerID: 'opencode-omniroute', modelID: 'zdarma-max' } }), now - 420000);
m.onOcEvent(ev('session.status', { sessionID: 's2', status: { type: 'retry', attempt: 2, message: 'Rate limit exceeded' } }));
m.onOcEvent(ev('session.error', { sessionID: 's3', error: { name: 'UnknownError', data: { message: 'stream_stalled' } } }));
const s1 = m.sessions.get('s1');
assert.strictEqual(s1.steps, 1, 'krok se počítá jednou');
assert.strictEqual(s1.tokensIn, 40000);
assert.strictEqual(s1.dir, 'C:\\proj');

// log guardu (czek-guard v OpenCode)
fs.writeFileSync(path.join(dir, 'guard.jsonl'), [
  { t: ago(1), kind: 'retry-abort', msg: 'relace s2: pokus 3 – zastavuji', session: 's2' },
  { t: ago(2), kind: 'note', msg: 'běžná poznámka' },
  { t: ago(3), kind: 'continue', msg: 'projekt nejde přeložit → pokračování', why: 'broken', session: 's1' },
].map((x) => JSON.stringify(x)).join('\n') + '\n');

const coolMap = new Map([['gemini/gemini-3-flash', now + 60000]]);
const lagMap = new Map([['nvidia/kimi-k3.1-pro', { n: 0, until: now + 300000 }]]);
const x = {
  version: '0.15.22',
  omni: { ready: false, starting: false, error: 'port obsazený' },
  omniEngine,
  opencode: { url: 'http://127.0.0.1:4096/', running: true, expected: true },
  race: { url: 'http://127.0.0.1:20139', n: 3, stats: { races: 10, fallbacks: 1, stalls: 1, lastMs: [2000, 3000], won: { 'z-kilo/nemotron:free': 9 } }, cool: coolMap, lag: lagMap, active: [{ id: 'a1', combo: 'zdarma-max', kind: 'agent', ms: 1200, runners: [] }] },
  fullLog: { on: true, file: 'x.jsonl' }, callLog: { on: true, todayBytes: 123456, dir: 'calls' },
  calls, keyHealth: { at: now, items: [{ provider: 'ovh', ok: false }, { provider: 'zai', ok: true }] }, diskFree: 1.5 * 1024 ** 3,
};
const snap = m.snapshot(x, now);

// modely
const mod = (ref) => snap.models.find((y) => y.model === ref);
const kilo = mod('z-kilo/nemotron:free');
assert.deepStrictEqual(kilo.states, [], 'Nemotron funguje');
assert.strictEqual(kilo.calls, 7); assert.strictEqual(kilo.ok, 6); assert.strictEqual(kilo.aborted, 1); assert.strictEqual(kilo.okPct, 100, 'zrušení poražení se do úspěšnosti nepočítají');
assert.strictEqual(kilo.medianMs, 2500); assert.strictEqual(kilo.ttftMs, 2100); assert.strictEqual(kilo.tokPerS, 61); assert.strictEqual(kilo.winsTotal, 9);
const gem = mod('gemini/gemini-3-flash');
assert.deepStrictEqual(gem.states, ['limited', 'cooling']); assert.strictEqual(gem.okPct, 0); assert.strictEqual(gem.lastErr.status, 429);
assert.deepStrictEqual(mod('nvidia/kimi-k3.1-pro').states, ['slow', 'lagging']);
assert.strictEqual(mod('nvidia/kimi-k3.1-pro').fail, 1, 'visení 45 s je selhání');
assert.ok(!mod('huggingface/x'), 'volání starší než hodina v tabulce ne');
assert.strictEqual(snap.models[0].model, 'z-kilo/nemotron:free', 'řazeno podle počtu pokusů');

// součásti
const comp = (cid) => snap.components.find((c) => c.id === cid);
assert.strictEqual(comp('omniroute').state, 'down');
assert.strictEqual(comp('race').state, 'ok'); assert.strictEqual(comp('race').detail.firstMs, 2000);
assert.strictEqual(comp('keys').state, 'warn');
assert.strictEqual(comp('disk').state, 'warn');
assert.strictEqual(snap.active.length, 1);

// upozornění
const codes = snap.alerts.map((a) => a.code);
for (const c of ['omniDown', 'badKeys', 'disk', 'modelFails', 'slowCall', 'fallback', 'stalled', 'retry', 'sessionError', 'stuck', 'guard_retryabort', 'guardContinue']) assert.ok(codes.includes(c), 'chybí upozornění ' + c + ': ' + codes.join(','));
assert.ok(!codes.includes('callError') || !snap.alerts.some((a) => a.code === 'callError' && /zrušeno klientem/.test(a.params.error)), 'zrušení klientem není chyba');
assert.ok(!snap.alerts.some((a) => a.code === 'modelFails' && a.params.model.includes('nemotron')), 'Nemotron bez upozornění');
assert.strictEqual(snap.alerts[0].level, 'error', 'chyby první');
assert.strictEqual(snap.ok, false);
assert.ok(!snap.guard.some((g) => g.kind === 'note'), 'běžné poznámky guardu ne');
// většina pokusů selhává
const m2 = new Monitor({});
m2.addOmniRows([1, 2, 3, 4, 5].map((k) => row('gemini/gemini-3-flash', 503, k)).concat([row('z-kilo/nemotron:free', 200, 1)]));
assert.ok(m2.snapshot({ omni: { ready: true }, opencode: { running: true } }, now).alerts.some((a) => a.code === 'mostFail' && a.params.bad === 5 && a.params.all === 6));

// změny upozornění pro úplný log: poprvé všechna nová, podruhé nic, po zmizení „skončilo“
let ch = m.alertChanges(snap.alerts, now);
assert.strictEqual(ch.added.length, snap.alerts.length);
ch = m.alertChanges(snap.alerts, now);
assert.strictEqual(ch.added.length + ch.ended.length, 0);
ch = m.alertChanges(snap.alerts.filter((a) => a.code !== 'omniDown'), now);
assert.deepStrictEqual(ch.ended, ['omniDown']);
assert.match(alertText(snap.alerts.find((a) => a.code === 'modelFails')), /gemini\/gemini-3-flash: 4 selhání za 10 min \(poslední 429/);

// vše v pořádku: bez upozornění
const ok = new Monitor({}).snapshot({ omni: { ready: true, url: 'u', providers: 3, combos: 6 }, opencode: { running: true, expected: true }, race: { url: 'r', n: 3, stats: {} }, fullLog: { on: true }, callLog: { on: true }, keyHealth: { at: now, items: [{ ok: true }] }, diskFree: 50 * 1024 ** 3 }, now);
assert.deepStrictEqual(ok.alerts, []);
assert.strictEqual(ok.ok, true);

console.log(`monitor OK (${snap.models.length} modely se stavem a rychlostí, ${snap.alerts.length} upozornění ze 13 druhů, relace, guard, změny pro log)`);
