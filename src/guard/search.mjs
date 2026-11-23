// czek-guard: glob a grep přes ripgrep, které přeskakují node_modules a další závislostní složky.
// Plugin nástroj se stejným jménem nahradí vestavěný (OpenCode 1.19.5). Bez pluginu nebo rg vrací {}.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Běžné hledání v projektu: jen jistě závislostní/generované složky (dist/build/out tu nejsou – můžou nést
// skutečné soubory projektu). U velkého kořene se přidá HUGE_EXTRA (cache a build složky napříč diskem).
const EXCLUDE = ['node_modules', 'target', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.gradle'];
const HUGE_EXTRA = ['.cargo', '.rustup', '.cache', 'vendor', 'Library', 'AppData', 'dist', 'build', 'out'];
const LIMIT = 100;
const TIME_BUDGET_MS = 15000; // strop pro běžné hledání
const HUGE_BUDGET_MS = 8000; // kratší strop pro velké kořeny (disk, domovská složka, cache)
const HUGE_NOTE = '\n\n(Searched a very large root; dependency/cache folders were skipped and the search was time-limited. Narrow the path to your project for complete results.)';
const TIME_NOTE = '\n\n(Search time limit reached; results are partial. Narrow the path or pattern.)';
const NOTE = '- Dependency and build folders (node_modules, target, .venv, __pycache__, .next, ...) are skipped unless the pattern or path names them.';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// rg.exe z PATH, jinak ten, který si stáhne OpenCode do své bin složky. POZOR: na Windows ji OpenCode dává do
// CACHE (XDG_CACHE_HOME, běžně ~/.cache/opencode/bin/rg.exe), ne do data složky. Dřív se hledalo jen v
// ~/.local/share/opencode/bin → na Windows se rg nenašel, guard glob/grep se vůbec nenasadil a OpenCode spadl
// zpět na vestavěné bez stropu a bez vyloučení (změřeno 20. 11.: glob/grep běžely 160–225 s a umřely na 120s killu).
export function findRg() {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
  }
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  const cands = [
    path.join(dataHome, 'opencode', 'bin', name), // XDG_DATA_HOME, jinak ~/.local/share
    path.join(cacheHome, 'opencode', 'bin', name), // XDG_CACHE_HOME, jinak ~/.cache (Windows: sem OpenCode dává rg)
  ];
  for (const c of cands) if (isFile(c)) return c;
  return null;
}

// Velký kořen: disk (C:\, /), domovská složka nebo uvnitř cache (.cargo, .rustup, AppData, .cache)
export function isHugeRoot(dir) {
  const raw = String(dir || '').trim();
  if (/^[A-Za-z]:[\\/]*$/.test(raw)) return true;
  const d = path.resolve(raw || '.');
  if (d === path.parse(d).root) return true;
  const low = (p) => path.resolve(p).toLowerCase();
  if (low(d) === low(os.homedir())) return true;
  const cacheSegs = ['.cargo', '.rustup', 'appdata', '.cache'];
  return d.split(/[\\/]+/).some((s) => cacheSegs.includes(s.toLowerCase()));
}

// vynechá složku, pokud ji uživatel zmínil v patternu, include nebo cestě (explicitní hledání funguje)
// u velkého kořene vynechá vždy všechno (zmínku uživatele ignoruje)
export function exclusions(dir, ...texts) {
  if (isHugeRoot(dir)) return [...EXCLUDE, ...HUGE_EXTRA].map((n) => `--glob=!**/${n}/**`);
  const segs = dir.split(/[\\/]+/);
  const hay = texts.filter(Boolean).join(' ');
  return EXCLUDE.filter((n) => !hay.includes(n) && !segs.includes(n)).map((n) => `--glob=!**/${n}/**`);
}

// poznámka pro výstup: velký kořen vždy, jinak jen když vypršel čas
function noteFor(dir, timedOut) {
  if (isHugeRoot(dir)) return HUGE_NOTE;
  return timedOut ? TIME_NOTE : '';
}

// spustí rg a streamuje řádky; onLine vrací false → zastavit a ubít proces; po budgetMs ho ubije (timedOut)
function runRg(rg, args, cwd, abort, onLine, budgetMs = TIME_BUDGET_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd, windowsHide: true });
    let stopped = false;
    let timedOut = false;
    let buf = '';
    let err = '';
    const stop = () => { if (!stopped) { stopped = true; child.kill(); } };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, budgetMs);
    if (abort) { if (abort.aborted) stop(); else abort.addEventListener('abort', onAbort, { once: true }); }
    const cleanup = () => { clearTimeout(timer); if (abort) abort.removeEventListener('abort', onAbort); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line && onLine(line) === false) { stop(); return; }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      cleanup();
      if (abort?.aborted) return reject(new Error('aborted'));
      if (buf && !stopped) onLine(buf.replace(/\r$/, ''));
      resolve({ code, stopped, err, timedOut });
    });
  });
}

/**
 * @opencode-ai/plugin (kvůli zod schématu nástrojů) si OpenCode instaluje do konfigurační složky samo, na čistém
 * profilu až při první instanci (10–30 s). Import holým jménem dřív, než je balík na disku, selže a běhové
 * prostředí si neúspěch pamatuje do restartu serveru – pak se nenačte ani plugin OmniRoute, který chce stejný
 * balík, a appka je bez modelů (změřeno 15. 11. na kopii celé appky: „Cannot find package '@opencode-ai/plugin'“
 * při každém načtení instance). Proto: počkat, až je balík i se zod na disku, a importovat přímo soubor.
 */
export async function loadPluginApi() {
  let nm;
  try { nm = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules'); } catch { return null; }
  const entry = path.join(nm, '@opencode-ai', 'plugin', 'dist', 'index.js');
  const ready = () => isFile(entry) && isFile(path.join(nm, 'zod', 'package.json'));
  const until = Date.now() + 45000;
  let waited = false;
  while (!ready() && Date.now() < until) { waited = true; await new Promise((r) => setTimeout(r, 300)); }
  if (!ready()) return null;
  if (waited) await new Promise((r) => setTimeout(r, 1500)); // instalace ještě dopisuje ostatní balíky
  for (let i = 0; i < 3; i++) {
    const m = await import(pathToFileURL(entry).href + (i ? `?retry=${i}` : '')).catch(() => null);
    if (m?.tool?.schema) return m;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Vrátí { glob, grep } nebo {} (OpenCode si pak nechá vestavěné nástroje). */
export async function searchTools(ctx) {
  const plug = await loadPluginApi();
  const z = plug?.tool?.schema;
  if (!plug?.tool || !z) return {};
  const rg = findRg();
  if (!rg) return {};

  const baseOf = (toolCtx) => toolCtx?.directory || ctx?.directory || process.cwd();

  const glob = plug.tool({
    description: [
      '- Fast file pattern matching tool that works with any codebase size',
      '- Supports glob patterns like "**/*.js" or "src/**/*.ts"',
      '- Returns matching file paths',
      '- Use this tool when you need to find files by name patterns',
      '- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead',
      '- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.',
      NOTE,
    ].join('\n'),
    args: {
      pattern: z.string().describe('Glob pattern to match files against'),
      path: z.string().optional().describe('The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.'),
    },
    async execute(args, toolCtx) {
      const dir = path.resolve(baseOf(toolCtx), args.path || '.');
      if (!isDir(dir)) throw new Error(`glob path must be a directory: ${dir}`);
      const rgArgs = ['--no-config', '--files', `--glob=${args.pattern}`, '--glob=!**/.git/**', ...exclusions(dir, args.pattern), '.'];
      const out = [];
      let more = false;
      const res = await runRg(rg, rgArgs, dir, toolCtx?.abort, (line) => {
        if (out.length >= LIMIT) { more = true; return false; }
        out.push(path.resolve(dir, line));
        return true;
      }, isHugeRoot(dir) ? HUGE_BUDGET_MS : TIME_BUDGET_MS);
      const note = noteFor(dir, res.timedOut);
      if (!out.length) return `No files found${note}`;
      let s = out.join('\n');
      if (more) s += `\n\n(Results are truncated: showing first ${LIMIT} results. Consider using a more specific path or pattern.)`;
      return s + note;
    },
  });

  const grep = plug.tool({
    description: [
      '- Fast content search tool that works with any codebase size',
      '- Searches file contents using regular expressions',
      '- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)',
      '- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")',
      '- Returns file paths and line numbers with matching lines',
      '- Use this tool when you need to find files containing specific patterns',
      '- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.',
      '- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead',
      NOTE,
    ].join('\n'),
    args: {
      pattern: z.string().describe('The regex pattern to search for in file contents'),
      path: z.string().optional().describe('The directory to search in. Defaults to the current working directory.'),
      include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
    },
    async execute(args, toolCtx) {
      if (!args.pattern) throw new Error('pattern is required');
      const p = path.resolve(baseOf(toolCtx), args.path || '.');
      let cwd = p;
      let target = '.';
      if (isFile(p)) { cwd = path.dirname(p); target = path.basename(p); }
      const rgArgs = ['--no-config', '--json', '--hidden', '--no-messages', ...(args.include ? [`--glob=${args.include}`] : []),
        '--glob=!**/.git/**', ...exclusions(cwd, args.pattern, args.include), '--', args.pattern, target];
      const files = new Map(); // soubor → řádky výsledků (v pořadí prvního výskytu)
      let count = 0;
      let more = false;
      const res = await runRg(rg, rgArgs, cwd, toolCtx?.abort, (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return true; }
        if (ev.type !== 'match') return true;
        if (count >= LIMIT) { more = true; return false; }
        const d = ev.data;
        const file = path.resolve(cwd, d.path.text);
        let text = (d.lines.text ?? '').replace(/\r?\n$/, '');
        if (text.length > 2000) text = text.slice(0, 2000) + '...';
        if (!files.has(file)) files.set(file, []);
        files.get(file).push(`  Line ${d.line_number}: ${text}`);
        count++;
        return true;
      }, isHugeRoot(cwd) ? HUGE_BUDGET_MS : TIME_BUDGET_MS);
      const note = noteFor(cwd, res.timedOut);
      if (!count) {
        // 1 = nic nenalezeno, 2 = částečná chyba (např. nečitelný soubor)
        if (!res.stopped && res.code !== 0 && res.code !== 1 && res.code !== 2) throw new Error(`ripgrep failed with code ${res.code}`);
        return `No files found${note}`;
      }
      const parts = [`Found ${count} matches${more ? ' (more matches available)' : ''}`];
      for (const [file, ms] of files) parts.push('', `${file}:`, ...ms);
      let s = parts.join('\n');
      if (more) s += '\n\n(Results truncated. Consider using a more specific path or pattern.)';
      return s + note;
    },
  });

  return { glob, grep };
}
