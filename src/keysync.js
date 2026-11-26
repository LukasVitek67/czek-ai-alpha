'use strict';
// Klíče v soukromém repozitáři (private/keys.json): přání uživatele 13. 11. – domácí PC byl offline a klíče
// existovaly jen tam (settings.json je šifrovaný Windows účtem, na jiném PC nečitelný). Soubor slouží jako
// společné místo mezi počítači: czek-ai ho při každém uložení klíčů přepíše a při startu z něj doplní klíče,
// které na tomto PC chybí. Místní klíč se nikdy nepřepíše cizím (při rozdílu vyhrává ten, kdo uloží naposled).
// POZOR: soubor je v čitelné podobě. Patří jen do SOUKROMÉHO repa, nikdy do public repa ani do buildu.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FORMAT = 'czek-ai-keys';

/** Klíče z nastavení → objekt souboru (bez časové značky, ta se přidá při zápisu). */
function toExport(settings) {
  const providers = {};
  for (const [id, p] of Object.entries(settings.providers || {})) if (p?.key) providers[id] = String(p.key);
  const customProviders = (settings.customProviders || []).filter((c) => c && (c.key || c.baseUrl)).map((c) => ({ ...c }));
  return { format: FORMAT, version: 1, providers, customProviders };
}

function read(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.format === FORMAT ? j : null;
  } catch { return null; }
}

/** Zapíše soubor, jen když se klíče změnily. Vrací true = zapsáno. */
function write(file, settings) {
  const next = toExport(settings);
  const cur = read(file);
  const same = cur && JSON.stringify({ ...cur, updatedAt: undefined }) === JSON.stringify({ ...next, updatedAt: undefined });
  if (same) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return true;
}

/** Doplní do nastavení klíče ze souboru, které tu chybí. Vrací seznam doplněných id. */
function merge(file, settings) {
  return mergeObject(read(file), settings);
}

/** Doplní do nastavení klíče z objektu ve formátu toExport (soubor, sdílená schránka src/keyVault.js). */
function mergeObject(j, settings) {
  if (!j || typeof j !== 'object') return [];
  const got = [];
  settings.providers = settings.providers || {};
  for (const [id, key] of Object.entries(j.providers || {})) {
    if (!key) continue;
    const p = settings.providers[id] || {};
    if (p.key) continue;
    settings.providers[id] = { ...p, key: String(key).trim() };
    got.push(id);
  }
  settings.customProviders = settings.customProviders || [];
  for (const c of j.customProviders || []) {
    const same = settings.customProviders.find((x) => (c.id && x.id === c.id) || (c.baseUrl && x.baseUrl === c.baseUrl));
    if (!same) { settings.customProviders.push({ ...c }); got.push(c.id || c.name || c.baseUrl); } else if (!same.key && c.key) { same.key = c.key; got.push(same.id || same.baseUrl); }
  }
  return got;
}

/**
 * Najde klon soukromého repa s private/keys.json (Plocha, Dokumenty, domov, do hloubky 3 složek).
 * Bere jen složku, jejíž package.json má "name": "czek-ai" A kde private/keys.json UŽ EXISTUJE.
 * Bezpečnost (23. 11., veřejné alpha repo): dřív stačil jakýkoli klon czek-ai a appka do něj klíče sama zapsala
 * v čitelné podobě – spolužák s klonem veřejného repa by je pak mohl omylem pushnout veřejně. Soubor se proto nikdy
 * nezakládá automaticky; jen ručně (`--keys-file=…` nebo „Vybrat soubor…“ v nastavení) a jen v soukromém repu.
 */
function findRepoFile(roots) {
  const home = os.homedir();
  const list = roots || [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), home, path.join(home, 'source', 'repos'), path.join(home, 'code')];
  const isRepo = (d) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'czek-ai' && fs.existsSync(path.join(d, '.git')); } catch { return false; }
  };
  const seen = new Set();
  const walk = (d, depth) => {
    if (depth < 0 || seen.has(d)) return null;
    seen.add(d);
    if (isRepo(d) && fs.existsSync(path.join(d, 'private', 'keys.json'))) return path.join(d, 'private', 'keys.json');
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^(node_modules|AppData|dist|Windows|Program Files.*)$/i.test(e.name)) continue;
      const r = walk(path.join(d, e.name), depth - 1);
      if (r) return r;
    }
    return null;
  };
  for (const r of list) { const f = walk(r, 3); if (f) return f; }
  return null;
}

module.exports = { toExport, read, write, merge, mergeObject, findRepoFile, FORMAT };
