// Volání Supabase RPC (veřejný klíč; zápis chrání tajné heslo TIER_API_SECRET, viz README).
'use strict';
const crypto = require('crypto');

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`chybí proměnná prostředí ${k}`);
  return v;
};

async function rpc(name, args) {
  const r = await fetch(`${env('SUPABASE_URL').replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_ANON_KEY'), authorization: `Bearer ${env('SUPABASE_ANON_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text };
}

/** sha256 se solí ze serveru: z hashe nejde zpět na IP ani id instalace. */
const hash = (kind, v) => crypto.createHash('sha256').update(`${env('TIER_HASH_SALT')}|${kind}|${v}`).digest('hex');

module.exports = { rpc, hash, env };
