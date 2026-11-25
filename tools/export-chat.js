// Export celé konverzace s Claudem (přepis Claude Code .jsonl) do docs/chat/: Markdown s časy (zprávy, myšlení,
// volání nástrojů i jejich výsledky, bez zkracování) + surový .jsonl. Klíče a e-maily se zamaskují (CLAUDE.md).
// node tools/export-chat.js <přepis.jsonl> [název]
'use strict';
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('použití: node tools/export-chat.js <přepis.jsonl> [název]'); process.exit(1); }
const name = process.argv[3] || path.basename(src, '.jsonl');
const outDir = path.join(__dirname, '..', 'docs', 'chat');
fs.mkdirSync(outDir, { recursive: true });

// Skutečné klíče uživatele (private/keys.json) se maskují podle PŘESNÉ hodnoty: vzory níž poznají jen klíče se
// známým začátkem. 15. 11. prošly vzory 4 klíče (OpenCode „oc_…“, Gemini „AQ.…“, Mistral, Z.ai – bez známého
// prefixu) a zachytila je až kontrola před commitem.
const SECRETS = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'private', 'keys.json'), 'utf8')).providers || {};
    return Object.values(p).flat().filter((k) => typeof k === 'string' && k.length > 12).sort((a, b) => b.length - a.length);
  } catch { return []; }
})();
const maskSecrets = (s) => { let t = String(s); for (const k of SECRETS) if (t.includes(k)) t = t.split(k).join('<klíč>'); return t; };

const mask = (s) => maskSecrets(s)
  .replace(/sk-or-v1-[A-Za-z0-9]{16,}/g, 'sk-or-v1-***')
  .replace(/nvapi-[A-Za-z0-9_-]{16,}/g, 'nvapi-***')
  .replace(/gsk_[A-Za-z0-9]{16,}/g, 'gsk_***')
  .replace(/hf_[A-Za-z0-9]{16,}/g, 'hf_***')
  .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'ghp_***')
  .replace(/github_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_***')
  .replace(/AIza[0-9A-Za-z_-]{30,}/g, 'AIza***')
  .replace(/sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-***')
  // lokální klíč Strata (STRATA_LOCAL_KEY_0 / api_key nativní instance): 64 hex; 25. 11. unikl do exportu i archivu smyčky
  .replace(/((?:STRATA_LOCAL_KEY_\d+|api_key)["']?\s*[=:]\s*["']?)[0-9a-f]{32,}/gi, '$1<strata-local-key>')
  .replace(/\blukas\.vitek\.(lbc|025)\b/g, '<e-mail>')
  // klíč Strata i bez názvu proměnné (např. v příkazu K=…): každý 64znakový hex (přijdeme jen o sha256 v chatu)
  .replace(/[0-9a-f]{44,}/g, '<hex>')
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (/noreply@anthropic\.com$/.test(m) ? m : '<e-mail>'));

const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter(Boolean);
fs.writeFileSync(path.join(outDir, name + '.jsonl'), lines.map(mask).join('\n') + '\n');

const fence = (t) => { const s = String(t); const n = Math.max(3, ...(s.match(/`+/g) || []).map((x) => x.length + 1)); return '`'.repeat(n) + '\n' + s + '\n' + '`'.repeat(n); };
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[obrázek]' : JSON.stringify(b))).join('\n') : JSON.stringify(c));
const out = [`# Celý chat s Claudem (${name})`, '', `Přepis Claude Code, export ${new Date().toISOString()}. Časy v UTC. Klíče a e-maily zamaskované.`, ''];
let n = 0;
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const t = e.timestamp || '';
  if (e.type === 'summary' || e.isCompactSummary) { out.push(`## ${t} · shrnutí kontextu`, '', fence(text(e.message?.content ?? e.summary)), ''); continue; }
  if (e.type !== 'user' && e.type !== 'assistant') continue;
  const c = e.message?.content;
  if (e.type === 'user') {
    if (typeof c === 'string') { out.push(`## ${t} · uživatel`, '', c, ''); n++; continue; }
    for (const b of c || []) {
      if (b.type === 'tool_result') out.push(`### ${t} · výsledek nástroje${b.is_error ? ' (chyba)' : ''}`, '', fence(text(b.content)), '');
      else if (b.type === 'text') { out.push(`## ${t} · uživatel`, '', b.text, ''); n++; }
      else if (b.type === 'image') out.push(`## ${t} · uživatel: [obrázek]`, '');
    }
  } else {
    for (const b of c || []) {
      if (b.type === 'text' && b.text.trim()) out.push(`## ${t} · Claude`, '', b.text, '');
      else if (b.type === 'thinking' && b.thinking?.trim()) out.push(`### ${t} · Claude přemýšlí`, '', fence(b.thinking), '');
      else if (b.type === 'tool_use') out.push(`### ${t} · nástroj ${b.name}`, '', fence(JSON.stringify(b.input, null, 2)), '');
    }
  }
}
fs.writeFileSync(path.join(outDir, name + '.md'), mask(out.join('\n')));
// kontrola hotových souborů: žádný skutečný klíč nesmí zůstat (jinak se export smaže a skončí chybou)
const leaked = ['.jsonl', '.md'].filter((ext) => { const b = fs.readFileSync(path.join(outDir, name + ext)); return SECRETS.some((k) => b.includes(Buffer.from(k))); });
if (leaked.length) {
  for (const ext of ['.jsonl', '.md']) fs.rmSync(path.join(outDir, name + ext), { force: true });
  console.error(`Export zrušen: v ${leaked.join(', ')} zůstal skutečný klíč.`);
  process.exit(1);
}
console.log(`docs/chat/${name}.md + .jsonl (${lines.length} záznamů, ${n} zpráv uživatele; skutečných klíčů zamaskováno podle hodnoty: ${SECRETS.length} kontrolováno)`);
