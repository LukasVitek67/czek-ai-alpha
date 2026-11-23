// Hlídání instancí OpenCode: každá složka projektu má v OpenCode vlastní instanci a plugin OmniRoute si
// při jejím vzniku jednou stáhne seznam modelů (limit 10 s). Když OmniRoute zrovna startuje nebo je
// vytížený, stažení vyprší a instance zůstane bez modelů až do restartu OpenCode („No model results“).
// Živě 13. 11.: po startu vznikly instance pro domov a lossless-player současně, domov měl 194 modelů,
// lossless-player žádný. POST /instance/dispose?directory=… instanci zahodí a při dalším dotazu vznikne
// znovu i se seznamem modelů (ověřeno na běžící appce uživatele: (none) → opencode-omniroute:194).
'use strict';

const q = (dir) => '?directory=' + encodeURIComponent(dir);

async function getJson(url, ms = 60000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** Počet modelů očekávaného poskytovatele v instanci složky (0 = chybí nebo je prázdný). */
async function modelsIn(base, dir, providerID) {
  const j = await getJson(base + '/config/providers' + q(dir));
  const p = (j.providers || []).find((x) => x.id === providerID);
  return p ? Object.keys(p.models || {}).length : 0;
}

async function busyIn(base, dir) {
  try {
    const st = await getJson(base + '/session/status' + q(dir), 15000);
    return Object.values(st || {}).some((s) => s && s.type && s.type !== 'idle');
  } catch { return false; }
}

/**
 * Zkontroluje instanci složky; bez modelů ji (když v ní nic neběží) zahodí a ověří znovu.
 * @returns {Promise<{ok: boolean, models: number, healed: boolean, error?: string}>}
 */
async function heal(base, dir, providerID, o = {}) {
  const tries = o.tries ?? 3;
  const wait = o.wait ?? 10000;
  let models = 0;
  let healed = false;
  try {
    models = await modelsIn(base, dir, providerID);
    for (let i = 0; models === 0 && i < tries; i++) {
      if (await busyIn(base, dir)) return { ok: false, models, healed, error: 'busy' };
      await fetch(base + '/instance/dispose' + q(dir), { method: 'POST', signal: AbortSignal.timeout(20000) });
      healed = true;
      models = await modelsIn(base, dir, providerID);
      if (models === 0 && i < tries - 1) await new Promise((r) => setTimeout(r, wait));
    }
    return { ok: models > 0, models, healed };
  } catch (e) {
    return { ok: false, models, healed, error: e.message };
  }
}

/** Složka projektu z adresy webu OpenCode (první část cesty = base64url složky), nebo null. */
function dirFromUrl(u) {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    const d = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^[a-zA-Z]:[\\/]|^\//.test(d) ? d : null;
  } catch { return null; }
}

/** Očekávaný poskytovatel podle výchozího modelu v konfiguraci („opencode-omniroute/auto/coding“ → …). */
const providerOf = (model) => (typeof model === 'string' && model.includes('/') ? model.slice(0, model.indexOf('/')) : null);

// Stav instance pro log. stateText = co se zapíše (i s chybou), stateKey = podle čeho se pozná změna (bez textu
// chyby). Dřív se do klíče počítal i text chyby → při výpadku sítě se chyba měnila každým pollem a hlídač zapsal
// „bez modelů" pokaždé (sebe-audit 23. 11.: 1046×). Teď se loguje jen přechod ok ↔ bez modelů, ne každý poll.
const stateText = (r) => (r && r.ok ? `ok ${r.models}` : `bez modelů${r && r.error ? ' (' + r.error + ')' : ''}`);
const stateKey = (r) => (r && r.ok ? `ok ${r.models}` : 'bez modelů');

module.exports = { heal, modelsIn, dirFromUrl, providerOf, stateText, stateKey };
