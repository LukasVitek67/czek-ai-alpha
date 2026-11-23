// Skutečná instalace do dočasné složky (jako čistý PC): přenosný Node.js → PortableGit → OmniRoute přes ten
// Node → OmniRoute se z té složky spustí a odpovídá. Nic globálního, nic v profilu uživatele. ~5–15 min, ~1 GB.
// ONLY=node|git|omni pustí jen část (omni potřebuje node: použije systémový, když ONLY=omni).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const inst = require('../src/installer');
  const omniMod = require('../src/omniroute');
  const srv = require('../src/opencodeServer');
  const base = process.env.TOOLS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'zd-tools-'));
  const only = process.env.ONLY || '';
  const t = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  const t0 = Date.now();
  const prog = (p) => { if (p.phase === 'download' && p.total && p.done === p.total) console.log(`  ${p.what}: staženo ${(p.total / 1048576).toFixed(0)} MB (${t()})`); };

  let node = null;
  if (!only || only === 'node') {
    node = await inst.installNode({ dir: path.join(base, 'node'), onProgress: prog });
    console.log('node OK', node, t());
    omniMod.setLocal({ nodeDir: path.join(base, 'node') });
    process.env.ZDARMA_IGNORE_SYSTEM_NODE = '1';
    assert.strictEqual(omniMod.findNode()?.node, node, 'findNode uses portable node');
    delete process.env.ZDARMA_IGNORE_SYSTEM_NODE;
  }
  if (!only || only === 'git') {
    const bash = await inst.installGit({ dir: path.join(base, 'git'), onProgress: prog });
    console.log('git OK', bash, t());
    srv.setLocalGitDir(path.join(base, 'git'));
    process.env.ZDARMA_IGNORE_SYSTEM_GIT = '1';
    assert.strictEqual(srv.findGitBash(), path.resolve(bash), 'findGitBash uses portable git');
    delete process.env.ZDARMA_IGNORE_SYSTEM_GIT;
  }
  if (!only || only === 'omni') {
    node = node || omniMod.findNode().node;
    let lines = 0;
    const root = await inst.installOmniroute({ dir: path.join(base, 'omniroute-app'), node, onLine: (l) => { if (lines++ < 30) console.log('  npm:', l.slice(0, 160)); } });
    console.log('omniroute OK', root, t());
    omniMod.setLocal({ omniDir: path.join(base, 'omniroute-app'), nodeDir: node ? path.dirname(node) : null });
    const saved = process.env.APPDATA;
    process.env.APPDATA = path.join(base, 'no-appdata'); // globální OmniRoute ignorovat
    const found = omniMod.find();
    process.env.APPDATA = saved;
    assert.ok(found && found.version === inst.OMNI_VERSION, 'find() sees local OmniRoute: ' + JSON.stringify(found));
    assert.ok(omniMod.findPlugin === undefined || true);
    // spustit z lokální instalace s dočasnými daty
    process.env.APPDATA = path.join(base, 'no-appdata');
    process.env.ZDARMA_IGNORE_SYSTEM_NODE = node && only !== 'omni' ? '1' : '';
    const eng = new omniMod.OmniRoute({ dataDir: path.join(base, 'omni-data'), port: 0, dashboard: true, log: () => {} });
    try {
      await eng.start();
      assert.ok(await eng.health(), 'OmniRoute health');
      console.log('omniroute start OK port', eng.port, 'node', eng.nodeBin, t());
    } finally { eng.stop(); process.env.APPDATA = saved; }
  }
  console.log('installer-tools OK', t(), base);
  if (!process.env.TOOLS_DIR && !process.env.KEEP) setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 3000);
})().catch((e) => { console.error(e); process.exitCode = 1; });
