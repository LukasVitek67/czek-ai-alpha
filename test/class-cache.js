// Složka pro třídu (czek-ai-cache z --priprav-tridu): najde se jen s manifest.json, poškozený soubor ve složce
// se nepoužije (kontrolní součet), platný se použije bez internetu. Registr npm míří na mrtvý port.
// node test/class-cache.js                      (~1 s, bez sítě)
// CLASS=<…/czek-ai-cache> node test/class-cache.js  (+ OpenCode ze skutečné složky bez internetu, ~5 s)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ZDARMA_NPM_REGISTRY = 'http://127.0.0.1:9';
const inst = require('../src/installer');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-class-'));

(async () => {
  try {
    // 1) hledání: bez manifestu ne, s manifestem ano, pořadí kandidátů platí
    const empty = path.join(base, 'empty'); fs.mkdirSync(empty);
    const good = path.join(base, 'good'); fs.mkdirSync(path.join(good, 'files'), { recursive: true });
    fs.writeFileSync(path.join(good, 'manifest.json'), JSON.stringify({ czekai: 1 }));
    assert.strictEqual(inst.findClassCache([null, empty, path.join(base, 'nic')]), null, 'no manifest → no class folder');
    assert.strictEqual(inst.findClassCache([undefined, empty, good]), good, 'folder with manifest found');

    // 2) poškozený OpenCode ve složce: nepoužije se, appka zkusí registr (mrtvý) a selže s chybou, ne s rozbitou binárkou
    const pkg = process.arch === 'x64' ? 'opencode-windows-x64' : null;
    if (process.platform === 'win32' && pkg) {
      for (const p of Object.keys(inst.OC_INTEGRITY)) fs.writeFileSync(path.join(good, 'files', `${p.replace('@', '-')}.tgz`), 'poškozeno');
      inst.setClassCache(good);
      const out = path.join(base, 'oc-bad');
      const phases = [];
      await assert.rejects(inst.installOpencode({ dir: out, onProgress: (p) => phases.push(p.phase) }), /Automatická instalace OpenCode selhala/);
      assert.ok(!phases.includes('cache'), 'corrupt file in class folder not used');
      assert.ok(!fs.existsSync(path.join(out, 'opencode.exe')), 'nothing installed from a corrupt file');

      // 3) skutečná složka (CLASS=…): OpenCode ze složky bez internetu
      if (process.env.CLASS) {
        inst.setClassCache(process.env.CLASS);
        const ok = path.join(base, 'oc-ok');
        const ph = [];
        const exe = await inst.installOpencode({ dir: ok, onProgress: (p) => ph.push(p.phase) });
        assert.ok(ph.includes('cache') && !ph.includes('download'), 'OpenCode from the class folder, no download: ' + ph.join(','));
        assert.ok(inst.binVersion(exe), 'installed binary runs');
        console.log(`  OpenCode ze složky pro třídu bez internetu: ${inst.binVersion(exe)}`);
      }
    }
    console.log('class-cache OK');
  } finally {
    inst.setClassCache(null);
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
