// Presety chatu (uživatel 26. 11.): v nové relaci si uživatel vybere preset (např. „Web design“) = primárního agenta
// OpenCode. Guard si podle agenta zprávy uživatele (hook chat.message) pamatuje preset relace a do systémového
// promptu (experimental.chat.system.transform) přidá povinné skills a plán postupu presetu. Základní prompt OpenCode
// zůstává (vlastní „prompt“ u agenta by ho nahradil a model by hůř zacházel s nástroji).
// Data zapisuje czek-ai vedle pluginu: presets.json = { agents: { <agent>: { id, name, skills, plan } } }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRESETS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets.json');

/** Presety podle jména agenta; poškozený nebo chybějící soubor = žádné presety. */
export function loadPresets(file = PRESETS_FILE) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [agent, p] of Object.entries(j?.agents || {})) {
    if (!p || typeof p.plan !== 'string' || !p.plan.trim()) continue;
    out[agent] = {
      id: String(p.id || agent),
      name: String(p.name || agent),
      skills: Array.isArray(p.skills) ? p.skills.filter((s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s)) : [],
      plan: p.plan.trim(),
    };
  }
  return out;
}

/** Text, který guard přidá do systémového promptu relace s presetem. */
export function presetBlock(p) {
  const skills = p.skills.length
    ? `Before your first tool call in this chat, load these skills with the skill tool – all of them, without asking the user and without announcing it: ${p.skills.map((s) => '`' + s + '`').join(', ')}. `
    : '';
  // Plány píše model (tools/presets-generate.js) a občas napíše, že skill něco „spustí / vygeneruje / nahlásí“ – skill je
  // ale jen návod. Jedna věta to srovná pro všechny plány bez ohledu na formulaci.
  return `# czek-ai preset: ${p.name}\nThe user started this chat with the "${p.name}" preset. ${skills}Then work by the playbook below; it takes priority over generic habits, but explicit instructions from the user always win. Skills are instructions you read and then follow yourself: wherever the playbook says a skill runs, scaffolds, reviews or reports something, do that work yourself as the skill describes.\n\n${p.plan}`;
}

/** Je to dotaz na titulek relace (malý model, bez práce na úkolu)? Tam playbook nepatří. */
export const isTitleRequest = (system) => Array.isArray(system) && system.some((s) => typeof s === 'string' && /title generator|generate a (short |brief )?title|thread title/i.test(s));
