// POST /api/report – anonymní souhrn volání modelů z czek-ai (src/publicTier.js).
// Tělo: { install: 32 hex (náhodné id instalace), version: "0.15.40", rows: [{ model, ok, fail, rate_limited,
// no_credit, timeout, p50_ms }] }. IP ani install se neukládají, jen sha256 se solí (limity v submit_report).
'use strict';
const { rpc, hash, env } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object' || JSON.stringify(body).length > 60000) { res.status(400).json({ error: 'bad body' }); return; }
  const { install, version, rows } = body;
  if (!/^[0-9a-f]{32}$/.test(String(install || '')) || !/^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(String(version || '')) || !Array.isArray(rows) || !rows.length || rows.length > 150) {
    res.status(400).json({ error: 'bad fields' });
    return;
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
  try {
    const r = await rpc('submit_report', { p_secret: env('TIER_API_SECRET'), p_install: hash('install', install), p_ip: hash('ip', ip), p_version: version, p_rows: rows });
    if (r.status >= 200 && r.status < 300) { res.status(200).json({ ok: true, stored: r.body }); return; }
    const msg = String(r.body?.message || r.text || '');
    if (/rate limit/.test(msg)) { res.status(429).json({ error: 'rate limit' }); return; }
    if (/bad rows|bad meta/.test(msg)) { res.status(400).json({ error: 'rejected' }); return; }
    res.status(502).json({ error: 'store failed' });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
};
