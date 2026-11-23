// Úplný záznam volání modelů (src/callLog.js + odbočka v src/race.js): každý dotaz a odpověď celé, zprávy jednou za
// den (otisky), klíče zamaskované, čtení celého volání zpět, souhrny pro monitor; z proxy závodu záznam vítěze,
// poražených (co stihli napsat), zálohy přes combo, přeposlaného dotazu bez nástrojů a dotazu zrušeného klientem.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { CallLog, assemble } = require('../src/callLog');
const { createRaceProxy } = require('../src/race');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const ch = (d, f = null, extra = {}) => ({ choices: [{ index: 0, delta: d, finish_reason: f }], ...extra });

(async () => {
  // 1) skládání odpovědi ze streamu: text, uvažování, nástroj po kouscích, konec, tokeny
  let a = assemble([ch({ role: 'assistant', content: '' }), ch({ reasoning_content: 'Nejdřív ' }), ch({ reasoning_content: 'přečtu.' }), ch({ content: 'Čtu ' }),
    ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: '{"filePath":' } }] }),
    ch({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }), ch({}, 'tool_calls', { usage: { prompt_tokens: 900, completion_tokens: 42 }, model: 'm/x' }), { done: true }]);
  assert.strictEqual(a.text, 'Čtu ');
  assert.strictEqual(a.reasoning, 'Nejdřív přečtu.');
  assert.deepStrictEqual(a.toolCalls, [{ id: 'c1', name: 'read', arguments: '{"filePath":"a.txt"}' }]);
  assert.strictEqual(a.finish, 'tool_calls');
  assert.strictEqual(a.usage.completion_tokens, 42);
  a = assemble([{ choices: [{ message: { role: 'assistant', content: 'Titulek' }, finish_reason: 'stop' }] }]);
  assert.strictEqual(a.text, 'Titulek'); // odpověď bez streamu

  // 2) záznam: zprávy jednou (otisky), čtení zpět, maskování, souhrn
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-calllog-'));
  const secret = 'tajny-klic-uzivatele-12345';
  let cl = new CallLog({ dir, secrets: () => [secret] });
  const sys = { role: 'system', content: 'Jsi agent. ' + 'x'.repeat(5000) };
  const u1 = { role: 'user', content: 'oprav build, klíč sk-or-v1-' + 'a'.repeat(40) + ' a ' + secret };
  const tools = [{ type: 'function', function: { name: 'bash', parameters: {} } }];
  const resp = assemble([ch({ content: 'Hotovo.' }), ch({}, 'stop', { usage: { completion_tokens: 3 } })]);
  cl.record({ id: 'c-1', t: Date.now(), kind: 'agent', combo: 'zdarma-max', params: { model: 'zdarma-max', stream: true }, messages: [sys, u1], tools, response: resp, ttftMs: 800, totalMs: 1200,
    race: { tried: ['m/a', 'm/b'], winner: 'm/a', rank: 0 }, runners: [{ model: 'm/a', won: true }, { model: 'm/b', why: 'HTTP 429 limit' }] });
  const a2 = { role: 'assistant', content: 'Hotovo.' };
  cl.record({ id: 'c-2', t: Date.now(), kind: 'agent', combo: 'zdarma-max', params: {}, messages: [sys, u1, a2, { role: 'user', content: 'díky' }], tools, response: resp, ttftMs: 500, totalMs: 900 });
  const day = new Date().toISOString().slice(0, 10);
  const msgLines = fs.readFileSync(path.join(dir, day + '.msgs.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(msgLines.length, 4, 'systémový prompt a první zpráva uloženy jen jednou (4 různé zprávy, 6 odeslaných)');
  assert.strictEqual(fs.readFileSync(path.join(dir, day + '.tools.jsonl'), 'utf8').trim().split('\n').length, 1, 'nástroje jednou');
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!all.includes('a'.repeat(40)) && !all.includes(secret), 'klíče zamaskované ve všech souborech');
  const back = cl.read('c-2');
  assert.strictEqual(back.messages.length, 4);
  assert.strictEqual(back.messages[0].content, sys.content, 'celý systémový prompt zpět');
  assert.ok(back.messages[1].content.includes('***klíč***'));
  assert.strictEqual(back.toolDefs[0].function.name, 'bash');
  assert.strictEqual(back.response.text, 'Hotovo.');
  assert.strictEqual(cl.read('neni'), null);
  const s1 = cl.recent.find((x) => x.id === 'c-1');
  assert.strictEqual(s1.model, 'm/a'); assert.strictEqual(s1.ttftMs, 800); assert.strictEqual(s1.outTokens, 3);
  assert.deepStrictEqual(s1.race.failed, [{ model: 'm/b', why: 'HTTP 429 limit' }]);
  // po restartu: otisky z disku (zprávy se neuloží znovu), souhrny z konce souboru
  cl = new CallLog({ dir, secrets: () => [secret] });
  assert.strictEqual(cl.recent.length, 2, 'historie po restartu');
  cl.record({ id: 'c-3', t: Date.now(), kind: 'agent', combo: 'zdarma-max', params: {}, messages: [sys, u1], tools, response: resp });
  assert.strictEqual(fs.readFileSync(path.join(dir, day + '.msgs.jsonl'), 'utf8').trim().split('\n').length, 4, 'po restartu se známé zprávy neukládají znovu');
  // nad denním limitem jen metadata
  const capped = new CallLog({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zd-calllog-cap-')), maxDayBytes: 10 });
  capped.record({ id: 'big', t: Date.now(), messages: [sys], response: { text: 'y'.repeat(3000) } });
  capped.record({ id: 'big2', t: Date.now(), messages: [{ role: 'user', content: 'nová' }], response: { text: 'y'.repeat(3000) } });
  const b2 = capped.read('big2');
  assert.ok(b2.capped && b2.response.text.length < 700, 'nad limitem zkrácený text');
  // staré dny se mažou (výchozí 7 dní)
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
  new CallLog({ dir });
  assert.ok(!fs.existsSync(path.join(dir, '2020-01-01.jsonl')), 'starý den smazán');

  // 3) odbočka v proxy závodu
  let behave = {};
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const b = behave[body.model] || { delay: 30 };
      if (b.status) { res.writeHead(b.status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fake ' + b.status + '"}}'); return; }
      if (!body.stream) { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'Titulek relace' }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } })); }, b.delay); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch {} };
      w(ch({ role: 'assistant', content: '' }));
      if (b.hang) return;
      setTimeout(() => {
        w(ch({ reasoning_content: 'myslím ' + body.model }));
        w(ch({ content: 'odpověď ' + body.model }));
        setTimeout(() => { w(ch({}, 'stop', { usage: { completion_tokens: 7 } })); try { res.end('data: [DONE]\n\n'); } catch {} }, b.tail ?? 40);
      }, b.delay);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const calls = [];
  let cands = ['m/a', 'm/b', 'm/c'];
  const proxy = createRaceProxy({ target: () => `http://127.0.0.1:${fake.address().port}`, candidates: (m) => (m === 'zdarma-max' ? cands : []), n: () => 3, graceMs: 200, firstOutputMs: 800, hedgeMs: 0, onCall: (r) => calls.push(r) });
  const url = await proxy.listen(0);
  const ask = (body, abortMs) => new Promise((resolve) => {
    const req = http.request(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-tajne-' + 'b'.repeat(30) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(s)); res.on('error', () => resolve(s));
    });
    req.on('error', () => resolve(null));
    req.end(JSON.stringify(body));
    if (abortMs) setTimeout(() => req.destroy(), abortMs);
  });
  const step = { model: 'zdarma-max', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ahoj' }], tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }], reasoning_effort: 'medium' };

  // vítěz + poražený, který už začal psát (m/b) + vypadlý (m/c 429)
  behave = { 'm/a': { delay: 50, tail: 300 }, 'm/b': { delay: 120, tail: 2000 }, 'm/c': { status: 429 } };
  const pending = ask(step);
  await tick(90);
  const act = proxy.active();
  assert.strictEqual(act.length, 1, 'běžící dotaz v monitoru');
  assert.ok(act[0].runners.some((r) => r.model === 'm/a' && /odpovídá|vyhrál/.test(r.state)), 'stav závodníků: ' + JSON.stringify(act[0].runners));
  const out = await pending;
  assert.ok(out.includes('odpověď m/a'));
  await tick(50);
  let rec = calls.at(-1);
  assert.strictEqual(rec.kind, 'agent');
  assert.strictEqual(rec.combo, 'zdarma-max');
  assert.strictEqual(rec.messages.length, 2, 'celé zprávy v záznamu');
  assert.strictEqual(rec.tools[0].function.name, 'bash');
  assert.strictEqual(rec.params.reasoning_effort, 'medium', 'parametry dotazu');
  assert.ok(!JSON.stringify(rec.headers).includes('sk-tajne'), 'bez hlavičky authorization');
  assert.strictEqual(rec.race.winner, 'm/a');
  assert.strictEqual(rec.response.text, 'odpověď m/a');
  assert.strictEqual(rec.response.reasoning, 'myslím m/a');
  assert.strictEqual(rec.response.usage.completion_tokens, 7);
  assert.ok(rec.ttftMs >= 40 && rec.totalMs >= rec.ttftMs + 250, `časy: první ${rec.ttftMs} ms, celkem ${rec.totalMs} ms`);
  const rb = rec.runners.find((r) => r.model === 'm/b');
  const rc = rec.runners.find((r) => r.model === 'm/c');
  assert.ok(rc.why.startsWith('HTTP 429') && rc.status === 429, 'proč vypadl');
  assert.ok(rb.aborted || rb.partial, 'poražený zrušen: ' + JSON.stringify(rb));
  assert.strictEqual(proxy.active().length, 0, 'po konci nic neběží');

  // všichni vypadnou → záloha přes combo, záznam se závodem i odpovědí combo
  proxy.cool.clear(); // m/c (429) z minulého kola je jinak na pauze
  behave = { 'm/a': { status: 503 }, 'm/b': { status: 503 }, 'm/c': { status: 429 }, 'zdarma-max': { delay: 20 } };
  await ask(step);
  await tick(50);
  rec = calls.at(-1);
  assert.ok(rec.race.fallback, 'záloha v záznamu');
  assert.strictEqual(rec.runners.length, 3);
  assert.strictEqual(rec.response.text, 'odpověď zdarma-max', 'odpověď combo složená z přeposlaného streamu');
  assert.strictEqual(rec.upstream.status, 200);

  // dotaz bez nástrojů a bez streamu (titulek) → přeposlán, klient dostane přesně odpověď, záznam má text
  const title = await ask({ model: 'zdarma-low', messages: [{ role: 'user', content: 'dej titulek' }] });
  assert.strictEqual(JSON.parse(title).choices[0].message.content, 'Titulek relace', 'odpověď klientovi beze změny');
  await tick(50);
  rec = calls.at(-1);
  assert.strictEqual(rec.kind, 'bez nástrojů');
  assert.strictEqual(rec.response.text, 'Titulek relace');
  assert.strictEqual(rec.race, undefined);

  // klient zruší dotaz uprostřed závodu → záznam s chybou, nic neběží
  proxy.cool.clear();
  behave = { 'm/a': { hang: true }, 'm/b': { hang: true }, 'm/c': { hang: true } };
  await ask(step, 150);
  await tick(100);
  rec = calls.at(-1);
  assert.match(rec.error, /zrušeno klientem/);
  assert.strictEqual(proxy.active().length, 0);

  // zápis do CallLog z proxy: celé kolo
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-calllog-px-'));
  const cl2 = new CallLog({ dir: dir2 });
  for (const r of calls) cl2.record(r);
  const first = cl2.read(calls[0].id);
  assert.strictEqual(first.messages[1].content, 'ahoj');
  assert.strictEqual(first.runners.length, 3);
  assert.strictEqual(cl2.recent.length, calls.length);
  const sm = cl2.recent[0];
  assert.ok(sm.modelTtftMs != null && sm.modelTtftMs <= sm.ttftMs, 'první odpověď vítěze od jeho startu: ' + sm.modelTtftMs + ' / ' + sm.ttftMs);

  await proxy.close(); fake.close();
  console.log(`call-log OK (${calls.length} volání z proxy zaznamenáno celé; zprávy jednou za den, klíče zamaskované, čtení zpět, souhrny pro monitor)`);
})().catch((e) => { console.error(e); process.exit(1); });
