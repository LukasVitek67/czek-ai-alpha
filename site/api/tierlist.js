// GET /api/tierlist – veřejný souhrn za posledních 72 h (funkce tierlist v Supabase), cache 5 min na Vercelu.
'use strict';
const { rpc } = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  const hours = Math.min(720, Math.max(1, Number(req.query?.hours) || 72));
  try {
    const r = await rpc('tierlist', { p_hours: hours });
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) { res.status(502).json({ error: 'read failed' }); return; }
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('access-control-allow-origin', '*');
    res.status(200).json({ updated: new Date().toISOString(), hours, models: r.body });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
};
