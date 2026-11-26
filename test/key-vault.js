// Sdílení klíčů mezi zařízeními (src/keyVault.js) proti falešnému Supabase RPC (stejná pravidla jako
// site/supabase/key_vault.sql: id, sha256 tokenu, blob). Klíče na server nikdy nečitelně; druhé zařízení kódem doplní
// chybějící, místní nepřepíše; změna na jednom zařízení se dostane na druhé; cizí token zápis neprojde; šifrovaný soubor.
//   node test/key-vault.js
'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const store = new Map(); // id → { token_hash, blob, rev }
const calls = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const name = (req.url.match(/\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    const a = JSON.parse(b || '{}');
    calls.push({ name, body: b, apikey: req.headers.apikey });
    const out = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    if (!/^[0-9a-f]{32}$/.test(a.p_id || '')) return out(400, { message: 'bad id' });
    if (name === 'vault_get') { const r = store.get(a.p_id); return out(200, r ? { blob: r.blob, rev: r.rev } : null); }
    if (name === 'vault_put') {
      if (!/^[0-9a-f]{32}$/.test(a.p_token || '') || !a.p_blob || a.p_blob.length > 65536) return out(400, { message: 'bad input' });
      const r = store.get(a.p_id);
      if (!r) { store.set(a.p_id, { token_hash: sha(a.p_token), blob: a.p_blob, rev: 1 }); return out(200, { rev: 1 }); }
      if (r.token_hash !== sha(a.p_token)) return out(400, { message: 'forbidden' });
      r.blob = a.p_blob; r.rev++; return out(200, { rev: r.rev });
    }
    if (name === 'vault_delete') { const r = store.get(a.p_id); if (r && r.token_hash === sha(a.p_token)) { store.delete(a.p_id); return out(200, true); } return out(200, false); }
    return out(404, { message: 'Could not find the function' });
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.CZEK_VAULT_URL = `http://127.0.0.1:${srv.address().port}`;
  const v = require('../src/keyVault');
  try {
    // kód: 20 znaků, tolerantní zápis
    const code = v.newCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    assert.strictEqual(v.normCode(code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')), code.replace(/-/g, ''));
    assert.strictEqual(v.normCode('krátký'), null);
    const A = { providers: { groq: { key: 'test-groq-AAAA' }, nvidia: { key: 'test-nv-AAAA' } }, customProviders: [{ id: 'my', baseUrl: 'http://x/v1', key: 'test-custom' }] };
    const B = { providers: { groq: { key: 'test-groq-LOCAL-B' } }, customProviders: [] };
    // A vytvoří schránku
    const t0 = Date.now();
    await v.push(code, A);
    console.log(`odvození klíče (scrypt) + nahrání: ${Date.now() - t0} ms`);
    const put = calls.find((c) => c.name === 'vault_put');
    assert.ok(put && !/test-groq|test-nv|test-custom|groq|nvidia/.test(put.body), 'server nevidí klíče ani názvy poskytovatelů');
    assert.ok(put.apikey, 'veřejný apikey v hlavičce');
    // B se připojí kódem: doplní chybějící, místní groq nepřepíše
    const r = await v.pull(code, B);
    assert.ok(r.found);
    assert.deepStrictEqual(r.imported.sort(), ['my', 'nvidia']);
    assert.strictEqual(B.providers.groq.key, 'test-groq-LOCAL-B', 'místní klíč se nepřepíše');
    assert.strictEqual(B.providers.nvidia.key, 'test-nv-AAAA');
    // B přidá klíč → sync → A ho dostane
    B.providers.zai = { key: 'test-zai-B' };
    const sb = await v.sync(code, B);
    assert.ok(sb.pushed, 'B nahrál sjednocení');
    const sa = await v.sync(code, A);
    assert.deepStrictEqual(sa.imported, ['zai'], 'A dostal klíč z B');
    assert.strictEqual(A.providers.zai.key, 'test-zai-B');
    const again = await v.sync(code, A);
    assert.ok(!again.pushed && !again.imported.length, 'beze změny se nic nenahrává');
    // jiný kód = jiná schránka; cizí token neprojde
    const other = v.newCode();
    assert.strictEqual((await v.pull(other, {})).found, false);
    const d = v.derive(code);
    await assert.rejects(fetch(`${process.env.CZEK_VAULT_URL}/rest/v1/rpc/vault_put`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_id: d.id, p_token: '0'.repeat(32), p_blob: 'x'.repeat(40) }) }).then(async (x) => { if (!x.ok) throw new Error((await x.json()).message); }), /forbidden/);
    // poškozený blob → chyba dešifrování, ne tichá data
    assert.throws(() => v.open(v.seal({ a: 1 }, crypto.randomBytes(32)), d.key));
    // soubor bez serveru
    const file = v.toFile(code, A);
    assert.ok(!/test-groq|test-nv/.test(file), 'soubor je šifrovaný');
    const C = { providers: {}, customProviders: [] };
    assert.deepStrictEqual(v.fromFile(file, code, C).sort(), ['groq', 'my', 'nvidia', 'zai']);
    assert.throws(() => v.fromFile(file, other, {}), 'jiný kód soubor neotevře');
    // smazání ze serveru
    assert.strictEqual(await v.remove(code), true);
    assert.strictEqual((await v.pull(code, {})).found, false);
    console.log('key-vault OK (kód, šifrováno v appce, doplnění bez přepsání, sync oběma směry, cizí token, soubor, smazání)');
  } finally { srv.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
