// Rozšíření czek-ai pro VS Code (vscode/czek-ai/extension.js) s napodobeninou API vscode: prompty z editoru,
// převod zpráv chatu VS Code → OpenAI (text, volání a výsledky nástrojů), proud odpovědi s textem i voláním nástroje
// proti falešnému mostu czek-ai (token v hlavičce, tools), HTML panelu (CSP, iframe na stránku mostu).
//   node test/vscode-ext.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

class TextPart { constructor(v) { this.value = v; } }
class ToolCallPart { constructor(id, name, input) { this.callId = id; this.name = name; this.input = input; } }
class ToolResultPart { constructor(id, content) { this.callId = id; this.content = content; } }
class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; this.isEmpty = a === c && b === d; } intersection() { return this; } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vsext-'));
const conf = { connectionFile: path.join(tmp, 'vscode.json'), chatModels: true, appPath: '' };
const vscodeMock = {
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1, Required: 2 }, Range,
  workspace: { getConfiguration: () => ({ get: (k) => conf[k] }), asRelativePath: (u) => 'src/app.js', getWorkspaceFolder: () => ({ uri: { fsPath: 'C:\\proj' } }), workspaceFolders: [{ uri: { fsPath: 'C:\\proj' } }] },
  window: { activeTextEditor: null },
  languages: {}, commands: {}, env: {},
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === 'vscode' ? 'vscode' : orig.call(this, req, ...a); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock };
const ext = require('../vscode/czek-ai/extension.js')._test;

(async () => {
  // prompty z editoru
  const doc = { languageId: 'javascript', lineCount: 3, uri: {}, getText: () => 'function a() {\n  return b;\n}\n' };
  const editor = { document: doc, selection: new Range(0, 0, 2, 1) };
  const ex = ext.buildPrompt('explain', editor);
  assert.match(ex, /^Vysvětli, co dělá tento kód ze souboru `src\/app\.js` \(řádky 1–3\)/);
  assert.match(ex, /```javascript\nfunction a\(\) \{/);
  const fx = ext.buildPrompt('fix', editor, { diagnostics: [{ range: new Range(1, 2, 1, 8), message: "'b' is not defined", source: 'eslint' }] });
  assert.match(fx, /- řádek 2: 'b' is not defined \(eslint\)/);
  assert.match(fx, /ověř, že chyba zmizela/);
  assert.match(ext.buildPrompt('tests', editor), /Napiš testy/);

  // převod zpráv
  const msgs = ext.toOpenAI([
    { role: 1, content: [new TextPart('Přečti soubor')] },
    { role: 2, content: [new TextPart('Jasně'), new ToolCallPart('c1', 'read_file', { path: 'a.js' })] },
    { role: 1, content: [new ToolResultPart('c1', [new TextPart('obsah souboru')])] },
  ]);
  assert.deepStrictEqual(msgs, [
    { role: 'user', content: 'Přečti soubor' },
    { role: 'assistant', content: 'Jasně', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'obsah souboru' },
  ]);

  // proud odpovědi proti falešnému mostu
  const token = 'a'.repeat(40);
  let seen = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/__czek/ping')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen = { auth: req.headers.authorization, url: req.url, body: JSON.parse(b) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`;
      res.write(ch({ content: 'Čtu ' }));
      res.write(ch({ content: 'soubor.' }));
      res.write(ch({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '{"pa' } }] }));
      res.end(ch({ tool_calls: [{ index: 0, function: { arguments: 'th":"b.js"}' } }] }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(conf.connectionFile, JSON.stringify({ port: srv.address().port, token }));
  const parts = [];
  const info = await ext.chatProvider.provideLanguageModelChatInformation();
  assert.deepStrictEqual(info.map((m) => m.id), ['max', 'high', 'low']);
  assert.ok(info.every((m) => m.capabilities.toolCalling && m.maxInputTokens > 0));
  await ext.chatProvider.provideLanguageModelChatResponse(info[0], [{ role: 1, content: [new TextPart('ahoj')] }],
    { tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }], toolMode: 1 },
    { report: (p) => parts.push(p) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  srv.close();
  assert.strictEqual(seen.url, '/__czek/v1/chat/completions');
  assert.strictEqual(seen.auth, `Bearer ${token}`, 'token v hlavičce');
  assert.strictEqual(seen.body.model, 'max');
  assert.strictEqual(seen.body.tools[0].function.name, 'read_file');
  assert.strictEqual(seen.body.tool_choice, 'auto');
  assert.strictEqual(parts.filter((p) => p instanceof TextPart).map((p) => p.value).join(''), 'Čtu soubor.');
  const call = parts.find((p) => p instanceof ToolCallPart);
  assert.ok(call && call.callId === 'call_9' && call.name === 'read_file' && call.input.path === 'b.js', 'volání nástroje složené z kusů proudu');

  // HTML panelu
  const h = ext.html({}, { url: 'http://127.0.0.1:4097/QzpccHJvag/session' });
  assert.match(h, /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
  assert.match(h, /<iframe id="f" src="http:\/\/127\.0\.0\.1:4097\/QzpccHJvag\/session"/);
  assert.match(ext.html({}, {}), /Spustit czek-ai/);
  assert.match(ext.html({}, { noFolder: true }), /Otevři složku projektu/);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('vscode-ext OK (prompty z editoru, převod zpráv a nástrojů, proud s voláním nástroje, token, HTML panelu)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
