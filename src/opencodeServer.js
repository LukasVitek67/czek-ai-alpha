'use strict';
// Spouští `opencode serve` na pozadí (bez konzolového okna). Server zároveň servíruje
// grafické rozhraní OpenCode, které Zdarma zobrazí ve vlastním okně.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'opencode.exe' : 'opencode';

// Složky, kam czek-ai OpenCode a Git Bash sama nainstaluje, když chybí (src/installer.js); nastaví je main.js.
let localDir = null;
let localGitDir = null;
const setLocalDir = (d) => { localDir = d; };
const setLocalGitDir = (d) => { localGitDir = d; };

function findOpencode() {
  const cands = [
    process.env.OPENCODE_BIN,
    IS_WIN && process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', EXE),
    path.join(os.homedir(), '.opencode', 'bin', EXE), // oficiální instalační skript
    ...String(process.env.PATH || '').split(path.delimiter).map((d) => d && path.join(d, EXE)),
    localDir && path.join(localDir, EXE), // vlastní instalace czek-ai (jen když jiná není)
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Git Bash pro nástroj „bash“ v OpenCode. Bez proměnné SHELL (Zdarma spuštěná z plochy) OpenCode na
// Windows vezme PowerShell a modely, učené na bashi, v něm zápasí s uvozovkami (živý záznam 8. 11.:
// „PowerShell is mangling the quotes in my node -e command“, několik kroků navíc).
function findGitBash() {
  if (!IS_WIN) return null;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  const cands = [
    process.env.OPENCODE_GIT_BASH_PATH,
    ...String(process.env.PATH || '').split(path.delimiter).filter((d) => d && fs.existsSync(path.join(d, 'git.exe'))).map((d) => path.join(d, '..', 'bin', 'bash.exe')),
    ...pf.filter(Boolean).map((d) => path.join(d, 'Git', 'bin', 'bash.exe')),
  ].filter(Boolean);
  if (process.env.ZDARMA_IGNORE_SYSTEM_GIT) cands.length = 0; // test: chovat se jako PC bez Gitu
  if (localGitDir) cands.push(path.join(localGitDir, 'bin', 'bash.exe'));
  return cands.map((p) => path.resolve(p)).find((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } }) || null;
}

function serveEnv(base = process.env) {
  const env = { ...base };
  if (IS_WIN && !env.SHELL) { const b = findGitBash(); if (b) env.SHELL = b; }
  if (env.XDG_DATA_HOME && !env.OPENCODE_DATA_DIR) env.OPENCODE_DATA_DIR = path.join(env.XDG_DATA_HOME, 'opencode');
  return env;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function isOpencodeAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok && /<title>OpenCode<\/title>/i.test(await r.text());
  } catch { return false; }
}

class OpencodeServer {
  constructor() { this.child = null; this.port = null; this.log = []; }

  get url() { return this.port ? `http://127.0.0.1:${this.port}/` : null; }

  /** Běží v některém projektu agent? (stav relací přes API serveru) */
  async busy() {
    if (!this.port) return false;
    const base = `http://127.0.0.1:${this.port}`;
    const get = async (p) => (await fetch(base + p, { signal: AbortSignal.timeout(3000) })).json();
    try {
      const projects = await get('/project');
      const dirs = [undefined, ...(Array.isArray(projects) ? projects.map((p) => p.worktree).filter(Boolean) : [])];
      for (const d of dirs) {
        const st = await get('/session/status' + (d ? `?directory=${encodeURIComponent(d)}` : ''));
        if (Object.values(st || {}).some((s) => s && s.type && s.type !== 'idle')) return true;
      }
      return false;
    } catch { return true; } // radši počkat, než shodit rozdělanou práci
  }

  /** Spustí server (nebo vrátí běžící). Vyhodí chybu s pochopitelnou zprávou. */
  async start(preferredPort = 4096, cwd = os.homedir()) {
    this.cwd = cwd;
    if (this.child && this.port && await isOpencodeAt(this.port)) return this.url;
    const bin = findOpencode();
    if (!bin) throw new Error('OpenCode není nainstalovaný. Nainstaluj ho příkazem: npm i -g opencode-ai');
    let port = preferredPort;
    if (await isOpencodeAt(port)) { this.port = port; return this.url; } // už běží (třeba z dřívějška)
    try { await new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(port, '127.0.0.1', () => s.close(res)); }); } catch { port = await freePort(); }
    this.log = [];
    const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1', ...(this.extraArgs || [])], {
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: serveEnv(),
    });
    const keep = (d) => { this.log.push(String(d)); if (this.log.length > 200) this.log.shift(); try { this.onOutput?.(d); } catch {} };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', () => { if (this.child === child) { this.child = null; this.port = null; } });
    this.child = child;
    this.port = port;
    for (let i = 0; i < 120; i++) { // až 60 s (první start si stahuje balíčky poskytovatelů)
      if (await isOpencodeAt(port)) return this.url;
      if (!this.child) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const tail = this.log.join('').slice(-600);
    this.stop();
    throw new Error(`OpenCode server se nespustil.${tail ? '\n' + tail : ''}`);
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.port = null;
    if (!c || c.exitCode != null) return;
    try {
      if (IS_WIN) execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else c.kill();
    } catch {}
  }

  async restart() {
    const p = this.port;
    this.stop();
    await new Promise((r) => setTimeout(r, 400)); // ať se port uvolní
    return this.start(p || 4096, this.cwd);
  }
}

module.exports = { OpencodeServer, findOpencode, isOpencodeAt, findGitBash, serveEnv, setLocalDir, setLocalGitDir };
