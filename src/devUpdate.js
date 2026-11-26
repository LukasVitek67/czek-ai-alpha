'use strict';
// Dev verze z klonu soukromého repa (uživatel 26. 11.: „dej mi na plochu dev verzi, která si sama bude stahovat
// updates z private repa“). Běží ze zdrojáků (electron.exe z node_modules klonu, tools/dev-install.js), nové commity
// z origin/main stahuje sama na pozadí (git fetch s přihlášením gitu uživatele – žádný token v appce).
//  - změny mimo kód appky (docs/, test/, tools/…) → sloučí hned, restart netřeba;
//  - změny kódu (src/, skills/, build/, package*.json) → použije při startu, za běhu lišta „Restartovat“;
//  - změna závislostí → po ukončení appky pomocný skript: sloučit, npm install, spustit znovu.
// Jen klon se značkou .git/czek-dev-channel (pracovní repo, ze kterého běží testy, se nikdy samo nemění) a jen čistý
// klon na větvi main bez vlastních commitů (nic se nepřepíše).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MARK = 'czek-dev-channel';
const BRANCH = 'main';
const UP = `origin/${BRANCH}`;
// co appka za běhu načítá ze složky (zbytek repa jsou dokumenty, testy a nástroje)
const RUNTIME = /^(src|skills|build)\/|^package(-lock)?\.json$/;
const DEPS = /^package(-lock)?\.json$/;

/** Kořen dev klonu, nebo null (zabalená appka, pracovní repo bez značky). */
function devRoot(dir) {
  try { return fs.existsSync(path.join(dir, '.git', MARK)) ? dir : null; } catch { return null; }
}

function git(dir, args, ms = 20000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, timeout: ms, windowsHide: true, maxBuffer: 4 << 20,
      // nikdy se na nic neptat (okno správce přihlášení, výzva v konzoli): bez přihlášení fetch prostě selže
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' } },
    (err, out, errOut) => resolve({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim().split('\n').pop() }));
  });
}

const fetch = (dir, ms = 30000) => git(dir, ['fetch', '--quiet', 'origin', BRANCH], ms);

/** Kde klon je vůči origin/main (bez sítě, z posledního fetch). */
async function status(dir) {
  const [head, up, branch, dirty, behind, ahead] = await Promise.all([
    git(dir, ['rev-parse', '--short', 'HEAD']), git(dir, ['rev-parse', '--short', UP]),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), git(dir, ['status', '--porcelain', '--untracked-files=no']),
    git(dir, ['rev-list', '--count', `HEAD..${UP}`]), git(dir, ['rev-list', '--count', `${UP}..HEAD`]),
  ]);
  const s = { head: head.out, up: up.out, branch: branch.out, dirty: !!dirty.out, behind: Number(behind.out) || 0, ahead: Number(ahead.out) || 0, files: [], subject: '' };
  if (s.behind) {
    s.files = (await git(dir, ['diff', '--name-only', 'HEAD', UP])).out.split('\n').filter(Boolean);
    s.subject = (await git(dir, ['log', '-1', '--format=%s', UP])).out;
  }
  s.canApply = s.behind > 0 && !s.ahead && !s.dirty && s.branch === BRANCH;
  s.restart = s.files.some((f) => RUNTIME.test(f));
  s.deps = s.files.some((f) => DEPS.test(f));
  s.why = !s.behind ? 'aktuální' : s.branch !== BRANCH ? `větev ${s.branch}` : s.dirty ? 'změněné soubory v klonu' : s.ahead ? `${s.ahead} vlastních commitů` : '';
  return s;
}

const merge = (dir) => git(dir, ['merge', '--ff-only', '--quiet', UP]);

/** Pomocný skript po ukončení appky: počká na konec procesu, sloučí, npm install, spustí appku znovu. */
function helperScript({ dir, pid, exe, args = [], log }) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return [
    '@echo off', 'chcp 65001 >nul', 'set GIT_TERMINAL_PROMPT=0', 'set GCM_INTERACTIVE=never',
    `cd /d ${q(dir)}`,
    `:wait`, `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)`,
    `echo [%date% %time%] dev aktualizace se závislostmi >> ${q(log)}`,
    `git merge --ff-only ${UP} >> ${q(log)} 2>&1`,
    // npm install (ne npm ci: ten by při chybě sítě smazal node_modules i s electron.exe → zástupce na ploše mrtvý)
    `call npm install --no-audit --no-fund >> ${q(log)} 2>&1`,
    // npm umí přepsat package-lock.json jiným formátem → klon by byl „změněný“ a další aktualizace by se zastavily
    `git checkout -- package-lock.json package.json >nul 2>&1`,
    `start "" ${q(exe)} ${args.map(q).join(' ')}`,
    '',
  ].join('\r\n');
}

function spawnHelper(opts) {
  const file = path.join(os.tmpdir(), `czek-dev-update-${Date.now()}.cmd`);
  fs.writeFileSync(file, helperScript(opts));
  spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return file;
}

/**
 * Při startu dev verze (před oknem): fetch (krátký limit, offline nevadí) a nové commity použít.
 * → 'relaunch' (sloučeno, appka se má spustit znovu), 'helper' (závislosti: appka skončí, skript ji spustí),
 *   'merged' (jen dokumenty – běží se dál), nebo null (nic / nejde).
 */
async function startup(dir, { log = () => {}, fetchMs = 6000, helper = null } = {}) {
  const f = await fetch(dir, fetchMs);
  if (!f.ok) log('[dev] fetch nevyšel (použije se poslední stažený stav):', f.err);
  const s = await status(dir);
  if (!s.behind) return null;
  if (!s.canApply) { log('[dev] nové commity', `${s.head}→${s.up}`, 'nejdou použít:', s.why); return null; }
  if (s.deps && helper) { log('[dev] nové závislosti', `${s.head}→${s.up}`, '→ npm install po ukončení'); spawnHelper({ dir, ...helper }); return 'helper'; }
  const m = await merge(dir);
  if (!m.ok) { log('[dev] sloučení selhalo:', m.err); return null; }
  log('[dev] aktualizováno', `${s.head}→${s.up}`, s.subject, s.restart ? '→ nové spuštění' : '(bez restartu)');
  return s.restart ? 'relaunch' : 'merged';
}

/**
 * Za běhu (každých pár minut): fetch; změny mimo kód appky sloučí hned, jinak vrátí stav pro lištu.
 * → { behind, up, subject, … } když čeká restart, jinak null.
 */
async function poll(dir, { log = () => {} } = {}) {
  const f = await fetch(dir);
  if (!f.ok) return null;
  const s = await status(dir);
  if (!s.canApply) { if (s.behind) log('[dev] nové commity nejdou použít:', s.why); return null; }
  if (!s.restart) {
    const m = await merge(dir);
    log('[dev] sloučeny změny mimo appku', `${s.head}→${s.up}`, m.ok ? '' : m.err);
    return null;
  }
  return s;
}

module.exports = { MARK, RUNTIME, devRoot, git, fetch, status, merge, helperScript, spawnHelper, startup, poll };
