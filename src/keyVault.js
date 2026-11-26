'use strict';
// Sdílení API klíčů mezi zařízeními (uživatel 26. 11.: notebook, PC a školní PC – nechce se všude přihlašovat ke všem
// poskytovatelům a vytvářet nové klíče). Jeden kód (XXXX-XXXX-XXXX-XXXX-XXXX, 100 bitů náhody) je všechno:
//  - z kódu scrypt odvodí id schránky, šifrovací klíč (AES-256-GCM) a token pro zápis; server dostane jen id,
//    šifrovaný blob a sha256 tokenu (site/supabase/key_vault.sql) – klíče nikdy nevidí;
//  - bez serveru: stejný šifrovaný blob do souboru (flashka, cloudový disk) a načíst kódem.
// Klíče ze schránky jen doplňují chybějící (místní klíč se nikdy nepřepíše), stejně jako private/keys.json.
const crypto = require('crypto');
const keysync = require('./keysync');

const URL = () => process.env.CZEK_VAULT_URL || 'https://octfympfekvvmfrbkmsz.supabase.co';
const APIKEY = () => process.env.CZEK_VAULT_KEY || 'sb_publishable_ibDY715tOXfQkZmtye-mnQ_xsQYm2yD'; // veřejný klíč (jen RPC vault_*)
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (bez I, L, O, U)
const FILE_FORMAT = 'czek-ai-key-vault';

/** Nový kód: 20 znaků base32 = 100 bitů, ve skupinách po 4. */
function newCode() {
  const b = crypto.randomBytes(13);
  let bits = 0, acc = 0, out = '';
  for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5 && out.length < 20) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}
/** Co uživatel napíše: malá písmena, mezery, pomlčky, O→0, I/L→1. → 20 znaků nebo null. */
function normCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(c) ? c : null;
}
const pretty = (c) => normCode(c).match(/.{4}/g).join('-');

const derived = new Map();
/** scrypt (N=2^15) → { id, key, token } (cache, ať se neodvozuje u každé synchronizace znovu). */
function derive(code) {
  const c = normCode(code);
  if (!c) throw new Error('bad code');
  if (derived.has(c)) return derived.get(c);
  const k = crypto.scryptSync(c, 'czek-ai-key-vault-v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = { id: k.subarray(0, 16).toString('hex'), key: k.subarray(16, 48), token: k.subarray(48, 64).toString('hex') };
  derived.set(c, d);
  return d;
}

function seal(payload, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.from(JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') })).toString('base64');
}
function open(blob, key) {
  const j = JSON.parse(Buffer.from(String(blob), 'base64').toString('utf8'));
  if (j?.v !== 1) throw new Error('unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(Buffer.from(j.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, 'base64')), d.final()]).toString('utf8'));
}

async function rpc(name, args) {
  const r = await fetch(`${URL().replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: APIKEY(), 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = String(body?.message || text || r.status);
    const e = new Error(/forbidden/.test(msg) ? 'forbidden' : /rate limit/.test(msg) ? 'rate limit' : /Could not find the function|PGRST202|404/.test(msg + r.status) ? 'no server' : msg.slice(0, 200));
    e.status = r.status;
    throw e;
  }
  return body;
}

/** Klíče z nastavení do schránky (přepíše ji: obsah = sjednocení, protože se vždy nejdřív stáhne a doplní). */
async function push(code, settings) {
  const d = derive(code);
  const blob = seal({ ...keysync.toExport(settings), at: Date.now() }, d.key);
  return rpc('vault_put', { p_id: d.id, p_token: d.token, p_blob: blob });
}
/** Ze schránky doplní chybějící klíče. → { found, imported: [id], rev } */
async function pull(code, settings) {
  const d = derive(code);
  const r = await rpc('vault_get', { p_id: d.id });
  if (!r || !r.blob) return { found: false, imported: [], rev: 0 };
  const j = open(r.blob, d.key);
  return { found: true, imported: keysync.mergeObject(j, settings), rev: r.rev || 0, count: Object.keys(j.providers || {}).length + (j.customProviders || []).length };
}
/** Synchronizace: stáhnout + doplnit, pak nahrát sjednocení (jen když tu je něco, co ve schránce chybí). */
async function sync(code, settings) {
  const d = derive(code);
  const r = await rpc('vault_get', { p_id: d.id });
  let imported = [], remote = null;
  if (r?.blob) { remote = open(r.blob, d.key); imported = keysync.mergeObject(remote, settings); }
  const mine = keysync.toExport(settings);
  const same = remote && JSON.stringify({ p: remote.providers, c: remote.customProviders }) === JSON.stringify({ p: mine.providers, c: mine.customProviders });
  let pushed = false;
  if (!same && (Object.keys(mine.providers).length || mine.customProviders.length)) { await push(code, settings); pushed = true; }
  return { imported, pushed, created: !r?.blob && pushed };
}
const remove = (code) => { const d = derive(code); return rpc('vault_delete', { p_id: d.id, p_token: d.token }); };

/** Bez serveru: šifrovaný soubor (stejný kód). */
const toFile = (code, settings) => JSON.stringify({ format: FILE_FORMAT, v: 1, blob: seal({ ...keysync.toExport(settings), at: Date.now() }, derive(code).key) }, null, 1) + '\n';
function fromFile(text, code, settings) {
  const j = JSON.parse(text);
  if (j?.format !== FILE_FORMAT) throw new Error('not a czek-ai key file');
  return keysync.mergeObject(open(j.blob, derive(code).key), settings);
}

module.exports = { newCode, normCode, pretty, derive, seal, open, push, pull, sync, remove, toFile, fromFile, FILE_FORMAT };
