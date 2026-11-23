// Stream přes OmniRoute: rozbité kusy tool_calls od modelů se musí ke klientovi dostat jako celá volání.
// Dřív šly syrové kusy rovnou do OpenCode → „Expected 'function.name' to be a string“ (screenshot 7. 11.).
// Klient tu kontroluje stejné pravidlo jako @ai-sdk/openai-compatible: nové volání = id + function.name.
'use strict';
const http = require('http');
const assert = require('assert');
const { createProxy, listen } = require('../src/proxy');

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  res.end();
};
const ch = (delta, finish = null, extra = {}) => ({ id: 'up1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

const SCENARIOS = {
  // jméno až ve druhém kusu, "name":"assistant" v delta, poslední kus argumentů s jiným indexem bez jména
  broken: [
    ch({ role: 'assistant', name: 'assistant', content: '' }),
    ch({ name: 'assistant', content: 'Přečtu soubor.' }),
    ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { arguments: '' } }] }),
    ch({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"pa' } }] }),
    ch({ tool_calls: [{ index: 1, function: { arguments: 'th":"a.txt"}' } }] }),
    ch({}, 'tool_calls'),
    { id: 'up1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    '[DONE]',
  ],
  // dvě paralelní volání, jméno po kouscích, bez [DONE]
  parallel: [
    ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'a', function: { name: 're', arguments: '' } }] }),
    ch({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"path":"x"}' } }] }),
    ch({ tool_calls: [{ index: 1, id: 'b', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }] }),
    ch({}, 'stop'), // některé modely hlásí stop i s voláním
  ],
  text: [ch({ role: 'assistant', content: 'Ahoj' }), ch({ content: ' světe' }), ch({}, 'stop'), '[DONE]'],
};

(async () => {
  let scenario = 'broken';
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => sse(res, SCENARIOS[scenario])); });
  const upPort = await listen(up, 0);
  const eng = { url: `http://127.0.0.1:${upPort}`, comboFor: () => 'zdarma-max', modelKeyFrom: () => null, keyForModel: () => 'ovh/gpt-oss-120b' };
  const registry = { textMode: new Set(), list: async () => ({ models: [] }), provider: () => null, providers: () => [], autoOrder: () => [], isCooling: () => false, coolingInfo: () => null, cool: () => {} };
  const traces = [];
  const server = createProxy({ registry, getSettings: () => ({ tiers: {} }), omni: () => eng, trace: (e) => traces.push(e) });
  const port = await listen(server, 0);

  async function run(name, includeUsage = false) {
    scenario = name;
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'zdarma/max', stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'user', content: 'x' }], tools: ['read', 'glob'].map((n) => ({ type: 'function', function: { name: n, parameters: { type: 'object', properties: {} } } })) }),
    });
    const text = await r.text();
    const events = text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6));
    assert.equal(events[events.length - 1], '[DONE]', name + ': končí [DONE]');
    const objs = events.slice(0, -1).map((e) => JSON.parse(e));
    // pravidlo ai-sdk
    const seenIdx = new Set();
    const calls = [];
    let content = '', finish = null, usage = null;
    for (const o of objs) {
      if (o.usage) usage = o.usage;
      for (const c of o.choices || []) {
        if (c.delta?.content) content += c.delta.content;
        assert.ok(!('name' in (c.delta || {})), name + ': žádné "name" v delta');
        for (const t of c.delta?.tool_calls || []) {
          if (!seenIdx.has(t.index)) {
            assert.equal(typeof t.id, 'string', name + ": Expected 'id' to be a string");
            assert.equal(typeof t.function?.name, 'string', name + ": Expected 'function.name' to be a string");
            seenIdx.add(t.index);
            calls[t.index] = { name: t.function.name, args: '' };
          }
          calls[t.index].args += t.function?.arguments || '';
        }
        if (c.finish_reason) finish = c.finish_reason;
      }
    }
    return { calls, content, finish, usage };
  }

  const b = await run('broken');
  assert.deepEqual(b.calls, [{ name: 'read', args: '{"path":"a.txt"}' }]);
  assert.equal(b.content, 'Přečtu soubor.');
  assert.equal(b.finish, 'tool_calls');
  assert.equal(b.usage, null, 'usage jen na požádání');
  assert.equal(traces.at(-1).attempts[0].badArgs, 0);

  const b2 = await run('broken', true);
  assert.equal(b2.usage?.total_tokens, 15, 'usage, když o něj klient žádá');

  const p = await run('parallel');
  assert.deepEqual(p.calls.map((c) => c.name), ['read', 'glob']);
  assert.equal(p.calls[1].args, '{"pattern":"*.js"}');
  assert.equal(p.finish, 'tool_calls', 'stop s voláním → tool_calls');

  const t = await run('text');
  assert.equal(t.content, 'Ahoj světe');
  assert.equal(t.finish, 'stop');
  assert.equal(t.calls.length, 0);

  server.close(); up.close();
  console.log('omni-stream OK');
})().catch((e) => { console.error(e); process.exit(1); });
