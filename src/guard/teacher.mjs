// Pravidla učitele (Agentic Starter Kit, uživatel 26. 11.: „switch, kde ne fakt znamená, že soubor bude agent
// ignorovat a že ho ani z minula nebude respektovat, nebo ano, že ho respektuje“). Stav po relacích zapisuje czek-ai
// do teacher.json vedle pluginu (výchozí stav, relace, přepnutí v rozepsaném chatu); guard ho čte u každého dotazu.
//  - zapnuto: projekt s AGENTS.md kitu → OpenCode ho načte sám, guard přidá jen „platí, i když dřív ne“;
//             projekt bez něj → pravidla kitu (kořenový CLAUDE.md kitu: nejdřív /bootstrap-agentic-environment);
//  - vypnuto: bloky „Instructions from: …AGENTS.md/CLAUDE.md“ kitu se ze systémového promptu VYŘÍZNOU a model dostane
//             pokyn ignorovat i to, co se z nich řídilo dřív v chatu. Ostatní pokyny (globální, czek-ai) zůstanou.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEACHER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'teacher.json');
const PENDING_MS = 15 * 60e3;

let cache = { file: '', mtime: -1, data: null };
/** Stav z teacher.json (přečte znovu jen po změně souboru). Chybí/vadný → null (funkce vypnutá). */
export function loadTeacher(file = TEACHER_FILE) {
  let st;
  try { st = fs.statSync(file); } catch { cache = { file, mtime: -1, data: null }; return null; }
  if (cache.file === file && cache.mtime === st.mtimeMs) return cache.data;
  let data = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object') {
      data = { kitDir: typeof j.kitDir === 'string' ? j.kitDir : '', default: j.default === true, sessions: {}, pending: null };
      for (const [k, v] of Object.entries(j.sessions || {})) if (typeof v === 'boolean') data.sessions[k] = v;
      if (j.pending && typeof j.pending.on === 'boolean' && Number(j.pending.at)) data.pending = { on: j.pending.on, at: Number(j.pending.at) };
    }
  } catch {}
  cache = { file, mtime: st.mtimeMs, data };
  return data;
}

// Soubor kitu poznáme podle obsahu (AGENTS.md po bootstrapu: „provozní řád projektu“, kořen kitu: značka).
const KIT_TEXT = /agentic-starter-kit|Agentic Starter Kit|provozní řád projektu|jediný zdroj pravidel/i;
const SECTION = /Instructions from: ([^\n]*)\n([\s\S]*?)(?=\n+Instructions from: |$)/g;
export const isKitSection = (file, body) => /(^|[\\/])(AGENTS|CLAUDE)\.md$/i.test(String(file).trim()) && KIT_TEXT.test(body);

/** Vyřízne bloky kitu z jednoho textu systémového promptu. → { text, removed: [cesty] } */
export function stripKit(text) {
  const removed = [];
  const out = String(text).replace(SECTION, (all, file, body) => {
    if (!isKitSection(file, body)) return all;
    removed.push(file.trim());
    return '';
  });
  return { text: removed.length ? out.replace(/\n{3,}/g, '\n\n').trim() : text, removed };
}
export const hasKit = (system) => system.some((s) => { SECTION.lastIndex = 0; let m; while ((m = SECTION.exec(String(s)))) if (isKitSection(m[1], m[2])) return true; return false; });

/** Stav relace: true/false; undefined = výchozí. Rozepsaný chat přepnutý před 1. zprávou → pending (adopt). */
export function sessionState(t, sessionID, adopted) {
  if (!t || !sessionID) return undefined;
  if (typeof t.sessions[sessionID] === 'boolean') return t.sessions[sessionID];
  return adopted.get(sessionID);
}

export function onBlock(kitDir, projectHasKit) {
  const head = '# Teacher\'s rules: ON (Agentic Starter Kit)\nThe user switched the teacher\'s working system ON for this chat. Follow it strictly from now on - including rules you were told to ignore earlier in this conversation. Talk to the user in Czech as the kit says.';
  if (projectHasKit) return `${head}\nThe project's AGENTS.md above is the single source of rules: read PROJECT.md for the phase and resume point before working, and keep the records (SPEC.md, TASKS.md, DECISIONS.md) as AGENTS.md says. Do not start discovery or implementation without an explicit instruction from the user. Entry commands: /discover-project, /plan-increment, /work-task T-xxx.`;
  return `${head}
This project is not set up with the kit yet (no AGENTS.md from the kit). Kit rules before setup:
- The only meaningful first step is /bootstrap-agentic-environment (the user can run it; you may offer it). Do not start a product conversation, choose a stack or write application code before the project is bootstrapped, unless the user explicitly tells you to.
- Do not edit the kit templates.
The kit is installed with czek-ai at: ${kitDir}
Path mapping for the kit's commands: the kit's \`.claude/templates/agentic/<file>\` is \`${path.join(kitDir, 'templates', 'agentic')}${path.sep}<file>\`, the kit's \`.claude/commands/<file>\` is \`${path.join(kitDir, 'commands')}${path.sep}<file>\`. When bootstrapping, use the Claude Code integration variant (CLAUDE.md with @AGENTS.md and the three entry commands in <target>/.claude/commands/) so the project works the same for classmates using Claude Code; czek-ai (OpenCode) reads AGENTS.md automatically and offers the entry commands itself.`;
}

export const OFF_BLOCK = '# Teacher\'s rules: OFF\nThe user switched the teacher\'s working system (Agentic Starter Kit: AGENTS.md "provozní řád", PROJECT.md, SPEC.md, TASKS.md, DECISIONS.md, phases, approvals, its slash commands) OFF for this chat. Ignore all of its rules completely - also any you followed earlier in this conversation; they no longer apply. Do not update those files or follow their process unless the user explicitly asks for it in a new message. Work normally by the user\'s requests.';
