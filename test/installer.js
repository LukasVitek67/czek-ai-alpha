// Automatická instalace OpenCode (src/installer.js).
//  1) tar parser a ochrana kontrolním součtem: falešný registr se špatným sha512 → nic se nezapíše
//  2) skutečné stažení oficiálního balíčku z registru npm do dočasné složky → binárka hlásí verzi 1.19.5,
//     findOpencode ji najde přes setLocalDir. (ZDARMA_SKIP_NET=1 přeskočí; ~70 MB)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

// minimální tar (ustar) pro test parseru
function tarOf(files) {
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000755\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

(async () => {
  const inst = require('../src/installer');
  const tar = tarOf({ 'package/package.json': Buffer.from('{}'), 'package/bin/opencode.exe': Buffer.from('MZfake') });
  assert.strictEqual(inst.untarFile(tar, 'package/bin/opencode.exe').toString(), 'MZfake');
  assert.strictEqual(inst.untarFile(tar, 'package/bin/nope'), null);

  // falešný registr: tarball je v pořádku, ale kontrolní součet v metadatech ne
  const tgz = zlib.gzipSync(tar);
  const srv = http.createServer((req, res) => {
    if (req.url.endsWith('.tgz')) { res.writeHead(200, { 'content-length': tgz.length }); res.end(tgz); return; }
    const pkg = req.url.split('/')[1];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${srv.address().port}/${pkg}/-/x.tgz`, integrity: 'sha512-' + crypto.createHash('sha512').update('jiný obsah').digest('base64') } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.ZDARMA_NPM_REGISTRY = `http://127.0.0.1:${srv.address().port}`;
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-inst-bad-'));
  const phases = [];
  await assert.rejects(inst.installOpencode({ dir: bad, onProgress: (p) => phases.push(p.phase) }), /kontrolní součet nesouhlasí/);
  assert.ok(!fs.existsSync(path.join(bad, 'opencode.exe')), 'nothing written on checksum mismatch');
  assert.ok(phases.includes('download'));
  srv.close();
  delete process.env.ZDARMA_NPM_REGISTRY;
  fs.rmSync(bad, { recursive: true, force: true });
  console.log('installer: tar + checksum OK');

  if (process.env.ZDARMA_SKIP_NET) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-inst-'));
  let last = 0, pct = 0;
  const t0 = Date.now();
  const exe = await inst.installOpencode({
    dir,
    onProgress: (p) => { if (p.phase === 'download' && p.total) { pct = Math.floor((p.done / p.total) * 100); if (pct >= last + 25) { last = pct; process.stdout.write(`  ${p.pkg} ${pct} %\n`); } } },
  });
  assert.strictEqual(inst.binVersion(exe), inst.OC_VERSION);
  assert.strictEqual(pct, 100);
  const srvMod = require('../src/opencodeServer');
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, OPENCODE_BIN: process.env.OPENCODE_BIN };
  process.env.PATH = ''; process.env.APPDATA = path.join(dir, 'none'); delete process.env.OPENCODE_BIN;
  assert.strictEqual(srvMod.findOpencode(), null, 'nothing found before setLocalDir (isolated PATH)');
  srvMod.setLocalDir(dir);
  assert.strictEqual(srvMod.findOpencode(), exe);
  Object.assign(process.env, saved);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
  console.log(`installer: real download OK (${info.pkg} ${info.version}, ${Math.round((Date.now() - t0) / 1000)} s)`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
