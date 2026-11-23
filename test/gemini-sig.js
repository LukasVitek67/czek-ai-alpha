// Gemini 3: proxy si pamatuje thought_signature z volání nástrojů a vrací ho v další otázce
// (OpenCode ho zahodí). Falešný Gemini odmítne historii bez podpisu stejně jako skutečný (HTTP 400).
'use strict';
const http = require('http');
const assert = require('assert');
const { createProxy, listen, withSignatures, rememberSignature } = require('../src/proxy');
const { PROVIDERS } = require('../src/providers');

// čistá funkce
rememberSignature('call_a', { google: { thought_signature: 'SIG-A' } });
const out = withSignatures([
  { role: 'user', content: 'x' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'assistant', content: null, tool_calls: [{ id: 'neznamy', type: 'function', function: { name: 'read', arguments: '{}' } }, { id: 'druhy', type: 'function', function: { name: 'read', arguments: '{}' } }] },
]);
assert.equal(out[1].tool_calls[0].extra_content.google.thought_signature, 'SIG-A');
assert.equal(out[2].tool_calls[0].extra_content.google.thought_signature, 'skip_thought_signature_validator');
assert.equal(out[2].tool_calls[1].extra_content, undefined, 'paralelní volání: podpis jen u prvního');

(async () => {
  let turn = 0;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const body = JSON.parse(raw);
      const calls = body.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls);
      if (calls.length && !calls[0].extra_content?.google?.thought_signature) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.' } }));
      }
      turn++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (turn === 1) {
        res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' }, extra_content: { google: { thought_signature: 'REAL-SIG' } } }] } }] }));
      } else {
        assert.equal(calls[0].extra_content.google.thought_signature, 'REAL-SIG', 'vrácen skutečný podpis');
        res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hotovo' } }] }));
      }
    });
  });
  const up = await listen(upstream, 0);
  const gem = PROVIDERS.find((p) => p.id === 'gemini');
  const fakeGem = { ...gem, baseUrl: `http://127.0.0.1:${up}/v1beta/openai`, chatUrl: undefined, chatUrlFor: undefined };
  const model = { key: 'gemini/gemini-3-flash-preview', id: 'gemini-3-flash-preview', provider: 'gemini', usable: true, tools: true };
  const registry = {
    textMode: new Set(),
    list: async () => ({ models: [model] }),
    provider: (id) => (id === 'gemini' ? { p: fakeGem, key: 'k', enabled: true } : null),
    providers: () => [{ p: fakeGem, key: 'k', enabled: true }],
    autoOrder: (ms) => ms, isCooling: () => false, coolingInfo: () => null, cool: () => {},
  };
  const server = createProxy({ registry, getSettings: () => ({ fallback: false }) });
  const port = await listen(server, 0);
  const ask = (messages) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'zdarma/gemini/gemini-3-flash-preview', messages, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }] }) }).then((r) => r.json());
  const r1 = await ask([{ role: 'user', content: 'přečti a.txt' }]);
  const call = r1.choices[0].message.tool_calls[0];
  assert.equal(call.extra_content, undefined, 'klient (OpenCode) podpis nedostává a stejně by ho zahodil');
  const r2 = await ask([
    { role: 'user', content: 'přečti a.txt' },
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
    { role: 'tool', tool_call_id: call.id, content: 'obsah' },
  ]);
  assert.equal(r2.choices?.[0]?.message?.content, 'hotovo', JSON.stringify(r2).slice(0, 300));
  server.close(); upstream.close();
  console.log('gemini-sig OK');
})().catch((e) => { console.error(e); process.exit(1); });
