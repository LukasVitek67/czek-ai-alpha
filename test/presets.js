// Presety chatu (src/presets + applyPresets v src/opencode.js): každý preset má platného agenta, existující skills a plán
// se všemi oddíly; konfigurace dostane primární agenty bez vlastního promptu a guard presets.json s plány; agent
// uživatele se stejným jménem se nepřepíše; vypnutí odebere jen naše. Bez OpenCode, ~0,2 s.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-presets-'));
process.env.XDG_CONFIG_HOME = path.join(base, 'config');
delete process.env.OPENCODE_CONFIG_DIR;
const oc = require('../src/opencode');
const root = path.join(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'src', 'presets', 'presets.json'), 'utf8'));

try {
  // 1) spec + plány
  const ids = spec.presets.map((p) => p.id);
  const agents = spec.presets.map((p) => p.agent);
  assert.strictEqual(new Set(ids).size, ids.length, 'id unikátní');
  assert.strictEqual(new Set(agents).size, agents.length, 'agenti unikátní');
  const general = spec.presets.find((p) => p.id === 'general');
  assert.ok(general && general.agent === 'build' && !general.goal, 'obecný chat = běžný agent build, bez plánu');
  for (const p of spec.presets) {
    assert.ok(p.name.cs && p.name.en && p.desc.cs && p.desc.en, `${p.id}: texty cs/en`);
    assert.match(p.color, /^#[0-9a-f]{6}$/i, `${p.id}: barva`);
    for (const s of p.skills) assert.ok(fs.existsSync(path.join(root, 'skills', s, 'SKILL.md')), `${p.id}: skill ${s} existuje`);
    if (p.agent !== 'build') assert.ok(!['plan', 'general', 'explore', 'title', 'summary', 'compaction'].includes(p.agent), `${p.id}: agent nekoliduje s vestavěným`);
  }
  const data = oc.presetsData('cs');
  const withPlan = data.filter((p) => p.plan);
  for (const p of spec.presets.filter((x) => x.goal)) {
    const d = data.find((x) => x.id === p.id);
    assert.ok(d.plan, `${p.id}: plán src/presets/${p.id}.md existuje`);
    for (const h of ['## Goal of this mode', '## Plan', '## Quality bar', '## Verify before saying done', '## Avoid']) assert.ok(d.plan.includes(h), `${p.id}: plán má oddíl ${h}`);
    assert.ok(!d.plan.startsWith('<!--'), `${p.id}: úvodní komentář generátoru odříznut`);
  }
  assert.strictEqual(data.find((p) => p.id === 'web-design').name, 'Web design');
  assert.strictEqual(oc.presetsData('en').find((p) => p.id === 'school').name, 'School project');

  // 2) konfigurace: primární agenti bez promptu, reviewer zachován, agent uživatele nepřepsán, presets.json pro guard
  const cfg = { agent: { reviewer: { mode: 'subagent', description: 'Independent reviewer' }, backend: { mode: 'primary', description: 'Můj vlastní backend agent', prompt: 'moje' } } };
  const on = oc.applyPresets(cfg, true, new Set(['impeccable', 'ui-ux-pro-max', 'czek-frontend', 'czek-debugging']));
  assert.ok(cfg.agent.reviewer, 'reviewer zůstal');
  assert.strictEqual(cfg.agent.backend.prompt, 'moje', 'vlastní agent uživatele se stejným jménem nepřepsán');
  assert.ok(!on.includes('backend'), 'preset kolidující s agentem uživatele vynechán');
  const wd = cfg.agent['web-design'];
  assert.ok(wd && wd.mode === 'primary' && wd.description.startsWith(oc.PRESET_MARK) && !('prompt' in wd), 'web-design = primární agent bez vlastního promptu');
  assert.strictEqual(on.length, withPlan.length - 1, 'všechny presety s plánem kromě kolidujícího');
  const g = JSON.parse(fs.readFileSync(path.join(oc.GUARD_DIR(), 'presets.json'), 'utf8'));
  assert.deepStrictEqual(g.agents['web-design'].skills, ['czek-frontend', 'ui-ux-pro-max', 'impeccable'], 'jen povolené skills, v pořadí presetu');
  assert.ok(g.agents['web-design'].plan.includes('## Plan'));
  assert.ok(!g.agents.build && !g.agents.general, 'obecný chat bez dat');

  // 3) vypnutí: naše pryč, cizí zůstane, soubor guardu smazán
  oc.applyPresets(cfg, false);
  assert.ok(!cfg.agent['web-design'] && cfg.agent.reviewer && cfg.agent.backend, 'odebrány jen naše');
  assert.ok(!fs.existsSync(path.join(oc.GUARD_DIR(), 'presets.json')), 'presets.json pryč');
  console.log(`presets OK (${spec.presets.length} presetů, ${withPlan.length} s plánem; agenti bez promptu, cizí agent nepřepsán, jen povolené skills, vypnutí čisté)`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
