'use strict';
// Skills přibalené ke Zdarmě (složka skills/, v exe resources/skills). Při startu je Zdarma nainstaluje
// do složky skills v konfiguraci OpenCode, takže jsou trvale k dispozici. Spravované kopie mají značku
// .zdarma-skill.json; cizích složek se Zdarma nedotkne. Skill, který už je v ~/.claude/skills (OpenCode
// tu složku čte taky), se neinstaluje podruhé, aby nebyl dvakrát.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = '.zdarma-skill.json';
const CLAUDE_SKILLS = () => process.env.ZDARMA_CLAUDE_SKILLS || path.join(os.homedir(), '.claude', 'skills');
const hasSkill = (dir, name) => fs.existsSync(path.join(dir, name, 'SKILL.md'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function bundled(bundleDir) {
  try {
    return fs.readdirSync(bundleDir, { withFileTypes: true }).filter((e) => e.isDirectory() && hasSkill(bundleDir, e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

function catalog(bundleDir) {
  return readJson(path.join(bundleDir, 'catalog.json')) || { groups: [], skills: [], sources: {} };
}

// Skills psané pro Claude Code odkazují na své skripty přes ${CLAUDE_PLUGIN_ROOT}/.claude/skills/<jméno>;
// v OpenCode taková proměnná není, proto se nahradí skutečnou cestou instalace.
function fixPaths(dst, name) {
  const real = dst.replace(/\\/g, '/');
  const re = new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}/\\.claude/skills/${name.replace(/[-.]/g, '\\$&')}`, 'g');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8');
        if (re.test(t)) fs.writeFileSync(p, t.replace(re, real));
        re.lastIndex = 0;
      }
    }
  };
  walk(dst);
}

// Popis skillu jde do systémového promptu OpenCode u KAŽDÉHO požadavku. 8. 11.: 48 skills = 27,7k znaků
// (75 % promptu, ~7k tokenů), přibalené skills z toho 17,9k. Free modely se v dlouhém promptu ztrácí, proto
// se v instalované kopii popis zkrátí na první věty (do DESC_MAX znaků). Návod v těle SKILL.md zůstává celý.
const DESC_MAX = 220;
function shortDesc(text, max = DESC_MAX) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let out = '';
  // konec věty = .!? a za mezerou velké písmeno (ne tečka v cestě jako ~/.claude nebo .cjs)
  for (const s of t.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)) {
    if ((out + ' ' + s).trim().length > max) break;
    out += ' ' + s;
  }
  out = out.trim();
  // krátká první věta by ztratila, KDY skill použít → doplnit začátek další věty po celé slovo
  if (out.length < max * 0.6) out = t.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '…';
  return out;
}

function shortenDescription(skillMd) {
  const t = fs.readFileSync(skillMd, 'utf8');
  const m = t.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return false;
  const lines = m[2].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i < 0) return false;
  let val = lines[i].replace(/^description\s*:\s*/, '');
  let end = i + 1;
  if (/^[>|][+-]?\s*$/.test(val) || val === '') { // blok na dalších odsazených řádcích
    const parts = [];
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === '')) parts.push(lines[end++].trim());
    val = parts.join(' ');
  } else if (/^["']/.test(val)) {
    const q = val[0];
    while (!(val.length > 1 && val.trimEnd().endsWith(q)) && end < lines.length) val += ' ' + lines[end++].trim();
    val = q === '"' ? (() => { try { return JSON.parse(val.trim()); } catch { return val.slice(1, -1); } })() : val.trim().slice(1, -1).replace(/''/g, "'");
  }
  const short = shortDesc(val);
  if (short === String(val).replace(/\s+/g, ' ').trim()) return false;
  lines.splice(i, end - i, 'description: ' + JSON.stringify(short));
  fs.writeFileSync(skillMd, t.replace(m[0], m[1] + lines.join('\n') + m[3]));
  return true;
}

/**
 * @param {{bundleDir: string, targetDir: string, version: string}} o
 * @returns {Array<{name: string, status: 'installed'|'updated'|'ok'|'claude'|'user'|'error', path: string, error?: string}>}
 */
function sync({ bundleDir, targetDir, version }) {
  const names = bundled(bundleDir);
  const out = [];
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    const src = path.join(bundleDir, name);
    const dst = path.join(targetDir, name);
    const mark = readJson(path.join(dst, MARK));
    try {
      if (hasSkill(CLAUDE_SKILLS(), name)) {
        if (mark) fs.rmSync(dst, { recursive: true, force: true }); // náš duplikát pryč
        out.push({ name, status: 'claude', path: path.join(CLAUDE_SKILLS(), name) });
        continue;
      }
      if (fs.existsSync(dst) && !mark) { out.push({ name, status: 'user', path: dst }); continue; }
      if (mark && mark.version === version && hasSkill(targetDir, name)) { out.push({ name, status: 'ok', path: dst }); continue; }
      const existed = !!mark;
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      fixPaths(dst, name);
      try { shortenDescription(path.join(dst, 'SKILL.md')); } catch {}
      fs.writeFileSync(path.join(dst, MARK), JSON.stringify({ source: 'zdarma', version, at: new Date().toISOString() }));
      out.push({ name, status: existed ? 'updated' : 'installed', path: dst });
    } catch (e) {
      out.push({ name, status: 'error', path: dst, error: e.message });
    }
  }
  // spravované kopie, které už Zdarma nepřibaluje, odstranit
  try {
    for (const e of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (e.isDirectory() && !names.includes(e.name) && fs.existsSync(path.join(targetDir, e.name, MARK))) {
        fs.rmSync(path.join(targetDir, e.name), { recursive: true, force: true });
      }
    }
  } catch {}
  return out;
}

module.exports = { sync, catalog, bundled, MARK, CLAUDE_SKILLS, shortDesc, shortenDescription, DESC_MAX };
