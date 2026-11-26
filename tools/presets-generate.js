#!/usr/bin/env node
// Plány postupu pro presety chatu (src/presets/<id>.md) napíše silný model (uživatel 26. 11.: „plán nám udělá nějaký
// výkonný model jako deepseek nebo glm“). Pořadí modelů: GLM 5.3 Flash (NVIDIA NIM) → DeepSeek V4.1 Flash (OpenCode Zen)
// → GLM 4.7 Flash (Z.ai). Klíče se čtou z private/keys.json a nikam se nezapisují ani nevypisují.
//   node tools/presets-generate.js              # chybějící plány
//   node tools/presets-generate.js bugfix school # jen tyto
//   node tools/presets-generate.js --force      # všechny znovu
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'src', 'presets');
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8'));
const keysFile = process.env.CZEK_KEYS_FILE || path.join(root, 'private', 'keys.json');
const keys = (() => { try { return JSON.parse(fs.readFileSync(keysFile, 'utf8')).providers || {}; } catch { return {}; } })();
const keyOf = (p) => (typeof keys[p] === 'string' ? keys[p] : keys[p]?.key) || '';

// Nejdřív GLM / DeepSeek (zadání uživatele), když nejsou k mání (26. 11.: GLM 5.3 na NVIDIA nezačal streamovat,
// DeepSeek v OpenCode Zen vyčerpaný denní limit, GLM 4.7 „overloaded“), další silné modely, na které jsou klíče.
// Který model plán napsal, je v hlavičce souboru; s --force se dá později přegenerovat.
const CHAIN = [
  { provider: 'nvidia', base: 'https://integrate.api.nvidia.com/v1', model: 'z-ai/glm-5.3-flash' },
  { provider: 'opencode', base: 'https://opencode.ai/inference/v1', model: 'deepseek-v4.1-flash-free' },
  { provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-pro-preview' },
  { provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  { provider: 'groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  { provider: 'zai', base: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7-flash' },
];

// zadání a kontrola plánu: src/presetGen.js (sdílí appka – vlastní presety uživatele)
const { planPrompt, checkPlan } = require('../src/presetGen');
const prompt = (p) => planPrompt({ name: p.name.en, goal: p.goal, skills: p.skills, extra: p.extra });
const check = (text, p) => checkPlan(text, { forbid: p.forbid || [], requireSections: false });

// Stream: přemýšlecí model (GLM 5.3) dlouho uvažuje → pevný limit ho zabil (240 s). Hlídá se nečinnost (90 s bez dat)
// a celkový strop 10 min; bere se jen content, uvažování (reasoning_content) se jen počítá.
async function ask(m, p) {
  const key = keyOf(m.provider);
  if (!key) throw new Error(`bez klíče ${m.provider}`);
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(new Error('celkový limit 10 min')), 600000);
  let idle = null; let started = false;
  // první bajt do 45 s (model ve frontě by jinak blokoval celý řetěz), pak nečinnost 90 s
  const bump = () => { clearTimeout(idle); const ms = started ? 90000 : 45000; idle = setTimeout(() => ctrl.abort(new Error(`${ms / 1000} s bez dat`)), ms); };
  let text = '';
  try {
    bump();
    const r = await fetch(`${m.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: prompt(p) }], temperature: 0.3, max_tokens: 8000, stream: true }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      started = true;
      bump();
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) text += c; } catch {}
      }
    }
  } catch (e) { throw new Error(ctrl.signal.aborted && ctrl.signal.reason ? ctrl.signal.reason.message : e.message); } finally { clearTimeout(total); clearTimeout(idle); }
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
  // nezlomitelné / typografické pomlčky a mezery → ASCII (jinak by skill tool jméno skillu nenašel), mezery na konci řádků pryč
  text = text.replace(/[‐‑‒]/g, '-').replace(/[   ]/g, ' ').replace(/[ \t]+$/gm, '').trim();
  const need = ['## Goal of this mode', '## Plan', '## Quality bar', '## Verify before saying done', '## Avoid'];
  const miss = need.filter((h) => !text.includes(h));
  if (miss.length) throw new Error('chybí oddíly: ' + miss.join(', '));
  const bad = check(text, p);
  if (bad.length) throw new Error('plán porušuje pravidla: ' + bad.join('; '));
  return text;
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));
  const todo = spec.presets.filter((p) => p.goal && (only.length ? only.includes(p.id) : force || !fs.existsSync(path.join(dir, p.id + '.md'))));
  // PRESETS_SKIP=nvidia,opencode,gemini → přeskočit poskytovatele, o kterých víme, že teď neodpovídají (rychlejší běh)
  const skip = new Set(String(process.env.PRESETS_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (skip.size) for (let i = CHAIN.length - 1; i >= 0; i--) if (skip.has(CHAIN[i].provider)) CHAIN.splice(i, 1);
  if (!todo.length) { console.log('nic k vygenerování (--force = všechny znovu)'); return; }
  let bad = 0;
  for (const p of todo) {
    let done = false;
    for (const m of CHAIN) {
      const t0 = Date.now();
      try {
        // „overloaded“ (Z.ai 1305) je dočasné → opakování po 15 s; plán porušil pravidla / chybí oddíly → nový pokus
        const text = await ask(m, p).catch(async (e) => {
          if (/porušuje pravidla|chybí oddíly/.test(e.message)) { console.log(`     ${p.id}: ${m.model} – ${e.message.slice(0, 140)} → nový pokus`); return ask(m, p); }
          if (!/HTTP 429[\s\S]*overloaded|HTTP 5\d\d/i.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 15000));
          return ask(m, p);
        });
        const head = `<!-- Plán presetu „${p.name.cs}“: vygeneroval ${m.model} (${m.provider}), ${new Date().toISOString().slice(0, 10)}, tools/presets-generate.js -->\n`;
        fs.writeFileSync(path.join(dir, p.id + '.md'), head + text + '\n', 'utf8');
        console.log(`OK   ${p.id}: ${m.model} za ${Math.round((Date.now() - t0) / 1000)} s, ${text.split(/\s+/).length} slov`);
        done = true;
        break;
      } catch (e) {
        console.log(`     ${p.id}: ${m.model} selhal (${e.message.slice(0, 120)}) → další`);
      }
    }
    if (!done) { bad++; console.log(`FAIL ${p.id}: žádný model neodpověděl`); }
  }
  process.exitCode = bad ? 1 : 0;
})();
