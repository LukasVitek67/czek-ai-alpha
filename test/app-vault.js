// CELÁ appka, dvě „zařízení“ (dva dočasné profily) + falešný Supabase RPC: na A v Nastavení „Sdílet klíče s dalšími
// zařízeními“ → kód; na B „Mám kód z jiného zařízení“ → Připojit → klíč z A se doplní. Kód je v settings.json
// šifrovaně, server klíče nevidí. Skrytě, vlastní porty.
//   node test/app-vault.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const cdp = require('./app-cdp');

const CDP = Number(process.env.VAULT_CDP_PORT) || 9371;
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-appvault-'));
const store = new Map(); const bodies = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    bodies.push(b);
    const name = (req.url.match(/\/rpc\/(\w+)/) || [])[1]; const a = JSON.parse(b || '{}');
    const out = (c, body) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    if (name === 'vault_get') { const r = store.get(a.p_id); return out(200, r ? { blob: r.blob, rev: r.rev } : null); }
    if (name === 'vault_put') { const r = store.get(a.p_id); if (!r) { store.set(a.p_id, { th: sha(a.p_token), blob: a.p_blob, rev: 1 }); return out(200, { rev: 1 }); } if (r.th !== sha(a.p_token)) return out(400, { message: 'forbidden' }); r.blob = a.p_blob; r.rev++; return out(200, { rev: r.rev }); }
    return out(404, { message: 'Could not find the function' });
  });
});

function device(name, providers) {
  const d = path.join(base, name);
  const x = (k) => { const p = path.join(d, k); fs.mkdirSync(p, { recursive: true }); return p; };
  const ud = x('userdata'); const proj = x('proj');
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers, wizardDone: true, lastCwd: proj }));
  const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
    ZDARMA_OC_PORT: String(4459), ZDARMA_HIDDEN: '1', ZDARMA_DEBUG_OPEN: 'settings', ZDARMA_DEBUG_OPEN_MS: '2500', CZEK_VAULT_URL: `http://127.0.0.1:${srv.address().port}` };
  delete env.OPENCODE_CONFIG_DIR;
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore' });
  const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch {} } };
  return { ud, child, kill, settings: () => JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')) };
}
const ev = (js) => Promise.race([cdp.evaluate(CDP, 'index.html', js), wait(8000).then(() => null)]).catch(() => null);
const waitFor = async (js, ms = 60000) => { for (let t = 0; t < ms; t += 500) { const v = await ev(js); if (v) return v; await wait(500); } return null; };

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let A = null, B = null;
  try {
    A = device('A', { groq: { key: 'test-groq-from-A' } });
    assert.ok(await waitFor(`!!document.querySelector('#vaultBox button')`, 120000), 'A: sekce sdílení klíčů v Nastavení');
    await ev(`[...document.querySelectorAll('#vaultBox button')].find((b) => /Sdílet klíče/.test(b.textContent)).click()`);
    assert.ok(await waitFor(`!!document.querySelector('#vaultBox .vault-code')`), 'A: propojeno');
    await ev(`[...document.querySelectorAll('#vaultBox button')].find((b) => /Ukázat kód/.test(b.textContent)).click()`);
    const code = await waitFor(`(() => { const t = document.querySelector('#vaultBox .vault-code')?.textContent || ''; return /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/.test(t) ? t : null; })()`, 5000);
    console.log('A: kód', code ? code.slice(0, 4) + '-…' : null);
    assert.ok(code, 'A: kód zobrazený');
    const sa = A.settings();
    assert.ok(sa.vaultCode && !String(sa.vaultCode).includes(code.replace(/-/g, '')), 'A: kód v settings.json šifrovaně');
    assert.ok(store.size === 1 && !bodies.some((b) => b.includes('test-groq-from-A')), 'server má jen šifrovaný blob');
    A.kill(); await wait(2500);

    B = device('B', {});
    assert.ok(await waitFor(`!!document.querySelector('#vaultBox input')`, 120000), 'B: pole pro kód');
    await ev(`(() => { const i = document.querySelector('#vaultBox input'); i.value = ${JSON.stringify(code.toLowerCase().replace(/-/g, ' '))}; [...document.querySelectorAll('#vaultBox button')].find((b) => b.textContent === 'Připojit').click(); return 1; })()`);
    const st = await waitFor(`(() => { const t = document.querySelector('#vaultBox')?.innerText || ''; return /Doplněno: groq/.test(t) ? t : null; })()`, 30000);
    console.log('B:', JSON.stringify((st || '').split('\n').slice(0, 2)));
    assert.ok(st, 'B: klíč z A doplněný');
    await cdp.shot(CDP, 'index.html', path.join(root, 'docs', 'research', '2026-11-26-presets', 'key-vault-b.png')).catch(() => {});
    const sb = B.settings();
    assert.ok(sb.providers?.groq?.key, 'B: groq v nastavení');
    assert.ok(String(sb.providers.groq.key).startsWith('enc:') && !JSON.stringify(sb).includes('test-groq-from-A'), 'B: klíč uložený šifrovaně');
    console.log('app-vault OK (A: kód → B: připojit → klíč doplněn; kód i klíče v nastavení šifrovaně, server jen blob)');
  } finally {
    A?.kill(); B?.kill(); srv.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
