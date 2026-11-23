// Vidění (src/vision.js + proxy závodu): obrázek od uživatele se uloží do projektu (.czek/obrazky) a modelu bez vidění
// přijde jako text (cesta + popis od modelu s viděním); popis jednou (mezipaměť + .txt vedle souboru); bez popisu aspoň
// cesta; věta OpenCode „Cannot read image (this model does not support image input)“ pryč; /czek/vision pro look.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { rewriteImages, cwdOf, hasImages, decodeDataUrl } = require('../src/vision');
const { createRaceProxy } = require('../src/race');

const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e221bc330000000049454e44ae426082', 'hex').toString('base64');

(async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vision-proj-'));
  const sys = { role: 'system', content: `You are opencode.\n<env>\n  Working directory: ${proj}\n  Platform: win32\n</env>` };
  const user = { role: 'user', content: [{ type: 'text', text: 'no boykisser, here is his pic, use it' }, { type: 'image_url', image_url: { url: PNG } }, { type: 'text', text: 'ERROR: Cannot read "image.png" (this model does not support image input). Inform the user.' }] };
  assert.strictEqual(cwdOf([sys, user]), proj);
  assert.ok(hasImages([sys, user]));
  assert.strictEqual(decodeDataUrl(PNG).ext, 'png');

  // 1) popis + soubor v projektu, věta OpenCode pryč
  let calls = 0;
  const describe = async (urls, prompt) => { calls++; assert.ok(urls[0].startsWith('data:image/png;base64,')); assert.match(prompt, /cannot see this image/); return { text: 'A cartoon cat with pink ears, line art.', model: 'qwen3-vl-30b' }; };
  const body = { model: 'zdarma-max', messages: [sys, JSON.parse(JSON.stringify(user))] };
  const cache = new Map();
  assert.strictEqual(await rewriteImages(body, { describe, fallbackDir: () => os.tmpdir(), cache }), 1);
  const parts = body.messages[1].content;
  assert.strictEqual(parts.length, 2, 'obrázek → text, věta „Cannot read“ odstraněna');
  assert.ok(!JSON.stringify(body).includes('image_url') && !JSON.stringify(body).includes('Cannot read'));
  const t = parts[1].text;
  assert.match(t, /^\[Image from the user, saved as "/);
  assert.match(t, /qwen3-vl-30b/); assert.match(t, /cartoon cat with pink ears/);
  const file = /saved as "([^"]+)"/.exec(t)[1];
  assert.ok(file.startsWith(path.join(proj, '.czek', 'obrazky')) && fs.existsSync(file), 'soubor v projektu: ' + file);
  assert.ok(fs.readFileSync(file).slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'PNG beze změny');
  // 2) další krok (stejná historie znovu) → z mezipaměti, žádné další volání vidění
  const body2 = { messages: [sys, JSON.parse(JSON.stringify(user)), { role: 'assistant', content: 'ok' }] };
  await rewriteImages(body2, { describe, fallbackDir: () => os.tmpdir(), cache });
  assert.strictEqual(calls, 1, 'popis jen jednou');
  // 3) po restartu (prázdná mezipaměť) popis z .txt vedle souboru
  await rewriteImages({ messages: [sys, JSON.parse(JSON.stringify(user))] }, { describe, fallbackDir: () => os.tmpdir(), cache: new Map() });
  assert.strictEqual(calls, 1, 'popis z .txt po restartu');
  // 4) vidění selže → aspoň cesta k souboru a pokyn
  const body4 = { messages: [sys, { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG.replace('AAAA', 'AAAB') } }] }] };
  await rewriteImages(body4, { describe: async () => { throw new Error('žádný model s viděním neodpověděl'); }, fallbackDir: () => os.tmpdir(), cache: new Map() });
  assert.match(body4.messages[1].content[0].text, /could not be obtained \(žádný model s viděním neodpověděl\)/);
  assert.match(body4.messages[1].content[0].text, /saved as "/);
  // 5) bez pracovní složky → záložní složka
  const fb = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vision-fb-'));
  const body5 = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] };
  await rewriteImages(body5, { describe, fallbackDir: () => fb, cache: new Map() });
  assert.ok(body5.messages[0].content[0].text.includes(fb), 'záložní složka');

  // 6) proxy závodu: obrázek v kroku agenta → modely dostanou text; /czek/vision pro look
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b = JSON.parse(raw || '{}'); seen.push(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok ' + b.model } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  let vcalls = 0;
  const proxy = createRaceProxy({ target: () => `http://127.0.0.1:${fake.address().port}`, candidates: () => ['m/a', 'm/b'], n: () => 2, graceMs: 100,
    vision: async (imgs, prompt) => { vcalls++; return { text: 'Seen: ' + prompt.slice(0, 20), model: 'qwen2-5-vl-72b' }; }, imageDir: () => fb });
  const url = await proxy.listen(0);
  const post = (p, b) => new Promise((resolve) => { const req = http.request(url + p, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s })); }); req.end(JSON.stringify(b)); });
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vision-proj2-')); // čistý projekt (v proj už je popis .txt)
  const sys2 = { role: 'system', content: `<env>\n  Working directory: ${proj2}\n</env>` };
  const step = { model: 'zdarma-max', stream: true, tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }], messages: [sys2, JSON.parse(JSON.stringify(user))] };
  const r = await post('/v1/chat/completions', step);
  assert.ok(r.text.includes('ok m/'), 'závod proběhl');
  assert.ok(seen.length >= 1 && seen.every((b) => !JSON.stringify(b).includes('image_url')), 'žádný model nedostal obrázek');
  assert.ok(seen.every((b) => /\[Image from the user, saved as/.test(JSON.stringify(b.messages))), 'všichni dostali text s cestou a popisem');
  assert.strictEqual(vcalls, 1, 'popis jednou pro všechny závodníky');
  let v = await post('/czek/vision', { images: [PNG], prompt: 'What is on screen?' });
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual(JSON.parse(v.text), { text: 'Seen: What is on screen?', model: 'qwen2-5-vl-72b' });
  v = await post('/czek/vision', { images: ['http://x/y.png'] });
  assert.strictEqual(v.status, 400, 'jen data URL');
  await proxy.close();
  const none = createRaceProxy({ target: () => null, candidates: () => [], n: () => 0 });
  const nurl = await none.listen(0);
  const nr = await new Promise((resolve) => { const req = http.request(nurl + '/czek/vision', { method: 'POST' }, (res) => resolve(res.statusCode)); req.end('{}'); });
  assert.strictEqual(nr, 501, 'bez vidění 501');
  await none.close(); fake.close();
  console.log('vision OK (obrázek → soubor v projektu + popis, jednou na obrázek i po restartu, bez popisu aspoň cesta; proxy: modely bez obrázků, /czek/vision)');
})().catch((e) => { console.error(e); process.exit(1); });
