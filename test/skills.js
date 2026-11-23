// Test: instalace přibalených skills, preferované rodiny modelů, součty tokenů za projekt.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skills = require('../src/skills');
const { ModelRegistry } = require('../src/agent');
const { Usage } = require('../src/usage');
const { projectOf } = require('../src/proxy');

// --- skills
const bundle = path.join(__dirname, '..', 'skills');
const cat = skills.catalog(bundle);
const names = skills.bundled(bundle);
assert.equal(names.length, 36, names.join(',')); // 34 ze seznamu uživatele + app-debugging (Zdarma) + i-have-adhd (záložky 13. 11.)
assert.deepEqual(cat.skills.map((s) => s.name).sort(), names, 'katalog pokrývá všechny přibalené skills');
for (const s of cat.skills) assert.ok(s.what && s.summary && s.group && cat.sources[s.source], `návod pro ${s.name}`);

const target = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-skills-'));
fs.mkdirSync(path.join(target, 'impeccable')); // „uživatelova“ složka bez značky – nesahat
fs.writeFileSync(path.join(target, 'impeccable', 'SKILL.md'), '---\nname: impeccable\ndescription: moje\n---\n');
let r = skills.sync({ bundleDir: bundle, targetDir: target, version: 't1' });
const by = Object.fromEntries(r.map((x) => [x.name, x.status]));
assert.equal(by.impeccable, 'user', 'cizí složka zůstane');
assert.equal(fs.readFileSync(path.join(target, 'impeccable', 'SKILL.md'), 'utf8').includes('moje'), true);
const inClaude = names.filter((n) => fs.existsSync(path.join(skills.CLAUDE_SKILLS(), n, 'SKILL.md')));
for (const n of inClaude) assert.equal(by[n], 'claude', `${n} je v ~/.claude/skills → neinstalovat podruhé`);
assert.equal(by['ui-ux-pro-max'], 'installed');
const uipro = fs.readFileSync(path.join(target, 'ui-ux-pro-max', 'SKILL.md'), 'utf8');
assert.ok(!uipro.includes('${CLAUDE_PLUGIN_ROOT}') && uipro.includes(target.replace(/\\/g, '/') + '/ui-ux-pro-max/scripts/search.py'), 'cesty ke skriptům přepsané');
assert.ok(fs.existsSync(path.join(target, 'memory-bank', 'reference', 'commands', 'context', 'update-memory-bank.md')));
assert.ok(fs.existsSync(path.join(target, 'threejs-webgl', 'LICENSE')));
r = skills.sync({ bundleDir: bundle, targetDir: target, version: 't1' });
assert.ok(r.filter((x) => !['user', 'claude'].includes(x.status)).every((x) => x.status === 'ok'), 'druhé spuštění nic nekopíruje');
r = skills.sync({ bundleDir: bundle, targetDir: target, version: 't2' });
assert.equal(Object.fromEntries(r.map((x) => [x.name, x.status]))['ui-ux-pro-max'], 'updated', 'nová verze Zdarmy → aktualizace');
fs.mkdirSync(path.join(target, 'stary-skill'));
fs.writeFileSync(path.join(target, 'stary-skill', skills.MARK), '{}');
skills.sync({ bundleDir: bundle, targetDir: target, version: 't2' });
assert.ok(!fs.existsSync(path.join(target, 'stary-skill')), 'spravovaná kopie, kterou už Zdarma nemá, zmizí');
fs.rmSync(target, { recursive: true, force: true });
console.log('skills ok');

// --- preferované rodiny modelů
const settings = { favorites: [], preferFamilies: ['kimi', 'deepseek-v4', 'glm'] };
const reg = new ModelRegistry(() => settings);
const ms = [
  { key: 'g/gpt-oss-120b', id: 'gpt-oss-120b', provider: 'g', usable: true, tools: true },
  { key: 'h/glm-5.3', id: 'zai-org/GLM-5.3', provider: 'h', usable: true, tools: true },
  { key: 'n/deepseek-v4.1-flash', id: 'deepseek-ai/deepseek-v4.1-flash', provider: 'n', usable: true, tools: true },
  { key: 'h/kimi-k3', id: 'moonshotai/Kimi-K3', provider: 'h', usable: true, tools: true },
  { key: 'g/llama', id: 'llama-3.3-70b', provider: 'g', usable: true, tools: true },
];
assert.deepEqual(reg.autoOrder(ms).slice(0, 3).map((m) => m.key), ['h/kimi-k3', 'n/deepseek-v4.1-flash', 'h/glm-5.3']);
settings.preferFamilies = [];
assert.notEqual(reg.autoOrder(ms)[0].key, 'h/kimi-k3');
assert.equal(require('../src/tiers').classify({ id: 'moonshotai/Kimi-K3.1' }), 'max');
console.log('preferované rodiny ok');

// --- tokeny za projekt
assert.equal(projectOf([{ role: 'system', content: 'You are OpenCode.\n<env>\n  Working directory: C:/Users/x/proj\n  Workspace root folder: C:/Users/x\n</env>' }]), 'C:/Users/x/proj');
assert.equal(projectOf([{ role: 'user', content: 'Working directory: nic' }]), null, 'jen ze systémové zprávy');
const u = new Usage(null, null);
u.record({ provider: 'g', providerName: 'Groq', model: 'g/a', ok: true, usage: { prompt_tokens: 100, completion_tokens: 10 }, project: 'C:/Users/x/proj' });
u.record({ provider: 'g', providerName: 'Groq', model: 'g/b', ok: true, usage: { prompt_tokens: 300, completion_tokens: 30 }, project: 'C:\\Users\\X\\proj\\' });
u.record({ provider: 'g', providerName: 'Groq', model: 'g/a', ok: true, usage: { prompt_tokens: 5, completion_tokens: 5 }, project: 'D:/jiny' });
const p = u.project('c:/users/x/proj');
assert.equal(p.tokensIn + p.tokensOut, 440, 'lomítka a velikost písmen nevadí');
assert.equal(p.models[0].key, 'g/b', 'modely podle spotřeby');
assert.equal(u.allProjects().projects, 2);
assert.equal(u.project('E:/nic'), null);
console.log('projekty ok');
console.log('skills test OK');
