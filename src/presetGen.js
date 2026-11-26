'use strict';
// Zadání a kontrola plánu presetu (playbook, který jde do KAŽDÉHO dotazu chatu s presetem). Sdílí tools/presets-generate.js
// (plány vestavěných presetů) a appka (vlastní presety uživatele: tlačítko „Napsat plán modelem“).
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

/** p = { name, goal, skills: [], extra? } */
const planPrompt = (p) => `You are writing the operating playbook that an AI coding agent will follow in every response of a chat dedicated to one kind of work.

Kind of work: ${p.name}
Goal: ${p.goal}

The agent works inside a code editor on the user's Windows PC (Git Bash, Node.js, Git available) with these tools: read, edit, write, bash, glob, grep, task (sub-agents) and skill (loads a skill = expert instructions). There is no task-list tool. The user's request arrives in the chat (plus any files the user names). ${p.skills.length ? `The following skills are loaded automatically at the start of this chat, so refer to them by their exact names where they help: ${p.skills.join(', ')}.` : 'No skills are preloaded for this chat.'}

What a skill is: a Markdown document with expert instructions that the agent reads with the skill tool and then follows. A skill is NOT an npm package, CSS file, library or shell command: never install, import or run a skill, and a skill never generates files, reviews code or reports results by itself - the agent does the work following its guidance.

Be specific to this kind of work: name the concrete techniques, patterns, project structure, commands and checks an expert in this field would use. No generic advice that would fit any task.

Hard constraints for the playbook:
- Size the solution to the request: follow the existing project's stack and structure when there is one; for a new small task prefer the simplest fitting stack and never force a framework or build tooling that the request does not need.
- Never push, deploy, publish, open pull requests or create remote repositories unless the user explicitly asks.
- Only rely on tools that exist on such a PC; anything extra (for example lighthouse or axe) only via npx and only if it is clearly worth it. Never install anything globally (no npm install -g).
- Do not assume a programming language or framework the kind of work does not imply; use the one the user, the assignment or the existing project uses.
- Do not invent input files; never ask the user for things the agent can find out itself.${p.extra ? '\n- ' + p.extra : ''}
- Use plain ASCII hyphens in names and commands.

Write an imperative playbook in English (about 350-500 words) as Markdown with exactly these sections:
## Goal of this mode
(1-2 lines)
## Plan
(numbered steps from understanding the request to a verified, finished result; specific to this kind of work, not generic advice)
## Quality bar
(bullets: what great output looks like here; concrete and checkable)
## Verify before saying done
(bullets: concrete checks the agent must actually run or look at)
## Avoid
(bullets: the typical mistakes in this kind of work)

Rules: no introduction or closing text, no model names, do not invent tools or skills, do not wrap the answer in a code block. Output only the Markdown.`;

const SECTIONS = ['## Goal of this mode', '## Plan', '## Quality bar', '## Verify before saying done', '## Avoid'];

/** Úprava odpovědi modelu: bez obalu ```, normalizované pomlčky a mezery. */
function cleanPlan(text) {
  return String(text || '').replace(/^\s*```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '')
    .replace(/[‐-‒]/g, '-').replace(/ /g, ' ').trim();
}

// 26. 11.: GPT-OSS napsal todowrite, „push to repo, live preview“, request.txt, npm i <skill>, @import skillu.
function checkPlan(text, { forbid = [], requireSections = true } = {}) {
  const bad = [];
  if (requireSections) for (const s of SECTIONS) if (!text.includes(s)) bad.push(`chybí oddíl ${s}`);
  if (/todowrite|todo list tool|task list tool/i.test(text)) bad.push('todowrite (v czek-ai vypnutý)');
  if (/git push|push (it |the code |changes )?to (the )?(repo|remote|github|origin)|deploy (it|to|the)|live preview url|vercel|netlify|gh pr create|open a pull request/i.test(text)) bad.push('push/nasazení bez pokynu');
  if (/request\.txt|brief\.(txt|md)/i.test(text)) bad.push('vymyšlený vstupní soubor');
  if (/npm (i|install|add)\b[^\n]*(\s-g\b|--global)|yarn global add/i.test(text)) bad.push('globální instalace');
  let all = [];
  try { all = fs.readdirSync(SKILLS_DIR).filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))); } catch {}
  const own = all.filter((n) => /^(czek-|impeccable$|unslop-ui$|modern-web-design$|ui-ux-pro-max$|app-debugging$)/.test(n));
  if (own.length) {
    const ownRe = own.map((n) => n.replace(/[-]/g, '\\-')).join('|');
    if (new RegExp(`(npm (i|install|add)|pnpm add|yarn add)\\b[^\\n]*\\b(${ownRe})\\b`, 'i').test(text)) bad.push('instalace skillu jako npm balíčku');
    if (new RegExp(`(@import|import\\s|require\\()[^\\n]*\\b(${ownRe})\\b`, 'i').test(text)) bad.push('import skillu jako knihovny');
  }
  for (const m of text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) if (/^czek-/.test(m[1]) && all.length && !all.includes(m[1])) bad.push(`neexistující skill ${m[1]}`);
  for (const re of forbid) if (new RegExp(re, 'i').test(text)) bad.push(`zakázané: ${re}`);
  return [...new Set(bad)];
}

module.exports = { planPrompt, checkPlan, cleanPlan, SECTIONS };
