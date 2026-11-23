// Živý test agentní smyčky proti free modelu bez klíče (Pollinations) + unit testy parseru.
'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { ModelRegistry, Agent, parseTextToolCalls, compact, toTextMode } = require('../src/agent');
const { executeTool, globToRegex } = require('../src/tools');

(async () => {
  // unit
  const p = parseTextToolCalls('Jdu na to\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>');
  assert.equal(p.toolCalls.length, 1); assert.equal(p.content, 'Jdu na to');
  assert.ok(globToRegex('**/*.js').test('src/a/b.js')); assert.ok(globToRegex('**/*.js').test('b.js')); assert.ok(!globToRegex('src/*.js').test('src/a/b.js'));
  const big = [{ role: 'user', content: 'x' }]; for (let i = 0; i < 40; i++) big.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(5000) }, { role: 'user', content: 'dál' });
  const c = compact(big, 8000); assert.ok(JSON.stringify(c).length < JSON.stringify(big).length / 3, 'compact');
  assert.ok(toTextMode(big.slice(0, 3))[2].content.includes('<tool_result'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'a\r\nb\r\nc\r\n');
  let r = await executeTool('edit_file', { path: 'f.txt', old_string: 'b', new_string: 'B' }, { cwd: tmp });
  assert.ok(r.ok, r.output); assert.equal(fs.readFileSync(path.join(tmp, 'f.txt'), 'utf8'), 'a\r\nB\r\nc\r\n');
  r = await executeTool('run_command', { command: 'Write-Output "ahoj čau"; exit 3' }, { cwd: tmp });
  assert.ok(r.output.includes('ahoj čau') && r.output.includes('Exit code: 3'), r.output);
  r = await executeTool('grep', { pattern: 'B' }, { cwd: tmp }); assert.ok(r.output.includes('f.txt:2'), r.output);

  // stream: poslední kus argumentů přijde s jiným indexem a bez jména → musí se slepit
  const http = require('http');
  const { streamChat } = require('../src/llm');
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a1', function: { name: 'write_file', arguments: '{"path":"x.js","content":"a' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'zz', function: { arguments: 'b"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const srv = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.end('data: [DONE]\n\n'); });
  await new Promise((r) => srv.listen(0, r));
  const sr = await streamChat({ url: 'http://127.0.0.1:' + srv.address().port, headers: {}, body: {}, signal: new AbortController().signal });
  srv.close();
  assert.equal(sr.toolCalls.length, 1, JSON.stringify(sr.toolCalls));
  assert.deepEqual(JSON.parse(sr.toolCalls[0].function.arguments), { path: 'x.js', content: 'ab' });
  // klasifikace chyb podle skutečných odpovědí poskytovatelů
  const { classify } = require('../src/llm');
  assert.equal(classify(413, 'Request too large for model openai/gpt-oss-120b on tokens per minute (TPM): Limit 8000'), 'too_large');
  assert.equal(classify(429, 'FreeUsageLimitError Free usage limit reached'), 'quota');
  assert.equal(classify(402, 'Purchase pre-paid credits to continue using Inference Providers'), 'quota');
  assert.equal(classify(429, 'Rate limit exceeded: free-models-per-day'), 'quota');
  assert.equal(classify(503, 'This model is currently experiencing high demand'), 'server');
  assert.equal(classify(404, 'This model models/gemini-2.5-flash is no longer available to new users'), 'not_found');
  const reg0 = new ModelRegistry(() => ({}));
  reg0.cool('provider:huggingface', 60000, 'x');
  assert.ok(reg0.isCooling('huggingface/a/b') && !reg0.isCooling('groq/x'));
  // unfiltered: rozpoznání necenzurovaných modelů, šablony AI Horde, pořadí Auto
  const { isUncensored } = require('../src/providers');
  const hz = require('../src/horde');
  assert.ok(isUncensored({ id: 'koboldcpp/gemma-4-31B-it-heretic' }) && isUncensored({ id: 'huihui_ai/qwen3-abliterated:14b' }) && isUncensored({ id: 'venice-uncensored-1-2' }));
  assert.ok(!isUncensored({ id: 'openai/gpt-oss-120b' }) && !isUncensored({ id: 'koboldcpp/Llama-3.2-3B-Instruct' }) && !isUncensored({ id: 'lexical-model' }));
  assert.equal(hz.templateFor('koboldcpp/L3-8B-Stheno-v3.2'), 'llama3');
  assert.equal(hz.templateFor('koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic'), 'chatml');
  assert.equal(hz.templateFor('koboldcpp/gemma-4-E4B-it'), 'gemma');
  const bp = hz.buildPrompt('koboldcpp/gemma-4-E4B-it', [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ahoj' }], 4096, 512);
  assert.ok(bp.prompt.startsWith('<start_of_turn>user\nSYS\n\nahoj<end_of_turn>') && bp.prompt.endsWith('<start_of_turn>model\n'), bp.prompt);
  const longHist = [{ role: 'system', content: 's' }]; for (let i = 0; i < 200; i++) longHist.push({ role: i % 2 ? 'assistant' : 'user', content: 'slovo '.repeat(100) + i });
  const bl = hz.buildPrompt('x', longHist, 4096, 512);
  assert.ok(bl.prompt.length / 3.3 < 4096 - 512 && bl.prompt.includes('199'), 'horde prompt se vejde a obsahuje poslední zprávu');
  assert.deepEqual(hz.splitThink('<think>hm</think> Ahoj'), { content: 'Ahoj', reasoning: 'hm' });
  const regU = new ModelRegistry(() => ({ uncensoredMarks: ['ollama/coder:latest'] }));
  const ms = [
    { key: 'groq/gpt-oss-120b', provider: 'groq', id: 'gpt-oss-120b', usable: true, tools: true, uncAuto: false },
    { key: 'horde/x-heretic', provider: 'horde', id: 'x-heretic', usable: true, tools: false, uncAuto: true },
    { key: 'ollama/coder:latest', provider: 'ollama', id: 'coder:latest', usable: true, tools: null, uncAuto: false, local: true },
  ];
  assert.deepEqual(regU.autoOrder(ms, true).map((m) => m.key).sort(), ['horde/x-heretic', 'ollama/coder:latest']);
  assert.deepEqual(regU.autoOrder(ms, false).map((m) => m.key), ['groq/gpt-oss-120b', 'ollama/coder:latest']);
  console.log('unit OK');
  if (process.argv[2] === 'unit') return;

  // živě
  const model = process.argv[2] || 'pollinations/openai-fast';
  const unfiltered = process.argv.includes('unfiltered');
  const settings = { providers: {}, customProviders: [], favorites: [], fallback: process.argv[3] !== 'nofallback' };
  const reg = new ModelRegistry(() => settings);
  const agent = new Agent(reg, () => settings);
  const session = { id: 't', cwd: tmp, messages: [] };
  const ctrl = new AbortController();
  const t0 = Date.now();
  await agent.run({
    session, model, mode: 'all', unfiltered, signal: ctrl.signal,
    text: unfiltered ? 'Napiš krátkou (4 řádky) básničku o tom, jak free AI přežívá na cizích GPU. Nástroje nepoužívej.' : 'Vytvoř soubor hello.py, který vypíše "ahoj svete", pak ho spusť příkazem python hello.py (nebo py hello.py) a řekni mi výstup.',
    askPermission: async () => ({ decision: 'allow' }),
    emit: (e) => { if (e.type === 'delta' || e.type === 'reasoning') return; console.log('EV', e.type, JSON.stringify(e).slice(0, 220)); },
  });
  console.log('trvalo', Date.now() - t0, 'ms; soubor:', fs.existsSync(path.join(tmp, 'hello.py')) ? fs.readFileSync(path.join(tmp, 'hello.py'), 'utf8') : 'NEEXISTUJE');
})().catch((e) => { console.error(e); process.exit(1); });
