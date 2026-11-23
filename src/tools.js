'use strict';
// Nástroje agenta: čtení/zápis/úpravy souborů, hledání, příkazy, stahování stránek.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MAX_OUT = 30000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', '.gradle', 'target', '.idea', '.cache', 'coverage']);

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Přečte textový soubor. Vrací řádky s čísly ("číslo→text"). U velkých souborů použij offset/limit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Cesta k souboru (relativně k pracovní složce nebo absolutní).' },
        offset: { type: 'integer', description: 'Číslo prvního řádku (od 1).' },
        limit: { type: 'integer', description: 'Počet řádků (výchozí 2000).' },
      },
      required: ['path'],
    },
    readOnly: true,
  },
  {
    name: 'write_file',
    description: 'Vytvoří nebo celý přepíše soubor. Pro úpravu existujícího souboru preferuj edit_file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'Celý nový obsah souboru.' } },
      required: ['path', 'content'],
    },
    kind: 'edit',
  },
  {
    name: 'edit_file',
    description: 'Nahradí přesný text v souboru. old_string musí v souboru být právě jednou (včetně odsazení), jinak přidej víc okolního kontextu, nebo nastav replace_all.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Přesný text, který se má nahradit.' },
        new_string: { type: 'string', description: 'Nový text.' },
        replace_all: { type: 'boolean', description: 'Nahradit všechny výskyty.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    kind: 'edit',
  },
  {
    name: 'list_dir',
    description: 'Vypíše obsah složky (složky končí lomítkem).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Výchozí je pracovní složka.' } } },
    readOnly: true,
  },
  {
    name: 'glob',
    description: 'Najde soubory podle vzoru, např. "src/**/*.ts" nebo "**/package.json". Ignoruje node_modules, .git apod.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Kde hledat (výchozí pracovní složka).' } }, required: ['pattern'] },
    readOnly: true,
  },
  {
    name: 'grep',
    description: 'Hledá regulární výraz v obsahu souborů. Vrací "soubor:řádek: text".',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regulární výraz (JavaScript).' },
        path: { type: 'string', description: 'Složka nebo soubor (výchozí pracovní složka).' },
        include: { type: 'string', description: 'Jen soubory odpovídající globu, např. "*.js".' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    readOnly: true,
  },
  {
    name: 'run_command',
    description: IS_WIN
      ? 'Spustí příkaz ve Windows PowerShell 5.1 v pracovní složce a vrátí výstup. Používej PowerShell syntaxi (ne bash). Neinteraktivní – nic, co čeká na vstup.'
      : 'Spustí příkaz v bash v pracovní složce a vrátí výstup. Neinteraktivní.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_sec: { type: 'integer', description: 'Časový limit v sekundách (výchozí 120, max 600).' },
      },
      required: ['command'],
    },
    kind: 'command',
  },
  {
    name: 'fetch_url',
    description: 'Stáhne webovou stránku nebo soubor přes HTTP(S) a vrátí text (HTML převedené na text).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    kind: 'network',
  },
];

function resolvePath(cwd, p) {
  if (!p) return cwd;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (s.startsWith('~')) s = path.join(require('os').homedir(), s.slice(1));
  return path.resolve(cwd, s);
}

function isInside(cwd, abs) {
  const rel = path.relative(cwd, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function truncate(s, max = MAX_OUT) {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.6));
  const tail = s.slice(-Math.floor(max * 0.35));
  return `${head}\n\n… [zkráceno ${s.length - head.length - tail.length} znaků] …\n\n${tail}`;
}

function globToRegex(glob) {
  let g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) { re += '(?:' + g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', IS_WIN ? 'i' : '');
}

async function* walk(dir, base = dir, depth = 0) {
  if (depth > 25) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, base, depth + 1);
    } else if (e.isFile()) {
      yield { full, rel: path.relative(base, full).replace(/\\/g, '/') };
    }
  }
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Jednoduchý řádkový diff pro zobrazení v UI.
function makeDiff(oldText, newText, startLine = 1) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ctx = 2;
  const lines = [];
  const from = Math.max(0, pre - ctx);
  for (let i = from; i < pre; i++) lines.push({ t: ' ', n: startLine + i, s: a[i] });
  for (let i = pre; i < a.length - suf; i++) lines.push({ t: '-', n: startLine + i, s: a[i] });
  for (let i = pre; i < b.length - suf; i++) lines.push({ t: '+', n: startLine + i, s: b[i] });
  for (let i = b.length - suf; i < Math.min(b.length, b.length - suf + ctx); i++) lines.push({ t: ' ', n: startLine + i, s: b[i] });
  return lines.slice(0, 400);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function runCommand(command, cwd, timeoutSec, signal) {
  return new Promise((resolve) => {
    const t = Math.min(Math.max(Number(timeoutSec) || 120, 1), 600);
    let child;
    if (IS_WIN) {
      const pre = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue";';
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', pre + command], { cwd, windowsHide: true, env: process.env });
    } else {
      child = spawn('bash', ['-lc', command], { cwd, detached: true, env: process.env });
    }
    let out = '';
    let killedBy = '';
    const add = (d) => { out += d.toString('utf8'); if (out.length > 400000) out = out.slice(-400000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.end();
    const timer = setTimeout(() => { killedBy = `časový limit ${t} s`; killTree(child); }, t * 1000);
    const onAbort = () => { killedBy = 'zastaveno uživatelem'; killTree(child); };
    signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `Nelze spustit: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out: out + (killedBy ? `\n[ukončeno: ${killedBy}]` : '') });
    });
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Spustí nástroj. Vrací { ok, output (pro model), display (pro UI, volitelné) }.
 */
async function executeTool(name, args, ctx) {
  const { cwd, signal } = ctx;
  args = args || {};
  try {
    switch (name) {
      case 'read_file': {
        const abs = resolvePath(cwd, args.path);
        const st = await fsp.stat(abs);
        if (st.isDirectory()) return { ok: false, output: `${abs} je složka, použij list_dir.` };
        if (st.size > 20 * 1024 * 1024) return { ok: false, output: `Soubor má ${st.size} B, je moc velký.` };
        const buf = await fsp.readFile(abs);
        if (isProbablyBinary(buf)) return { ok: false, output: `Soubor ${abs} je binární (${st.size} B).` };
        const lines = buf.toString('utf8').split(/\r?\n/);
        const off = Math.max(1, Number(args.offset) || 1);
        const lim = Math.max(1, Number(args.limit) || 2000);
        const slice = lines.slice(off - 1, off - 1 + lim);
        let body = slice.map((l, i) => `${off + i}→${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
        if (off - 1 + lim < lines.length) body += `\n… (soubor má ${lines.length} řádků, pokračuj s offset=${off + lim})`;
        if (!lines.length || (lines.length === 1 && !lines[0])) body = '(prázdný soubor)';
        return { ok: true, output: truncate(body), display: { kind: 'read', path: abs, lines: slice.length } };
      }
      case 'write_file': {
        const abs = resolvePath(cwd, args.path);
        const content = String(args.content ?? '');
        let old = null;
        try { old = await fsp.readFile(abs, 'utf8'); } catch {}
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content, 'utf8');
        const n = content.split('\n').length;
        return {
          ok: true,
          output: `${old === null ? 'Vytvořen' : 'Přepsán'} soubor ${abs} (${n} řádků).`,
          display: { kind: 'diff', path: abs, created: old === null, diff: makeDiff(old ?? '', content) },
        };
      }
      case 'edit_file': {
        const abs = resolvePath(cwd, args.path);
        const raw = await fsp.readFile(abs, 'utf8');
        const crlf = raw.includes('\r\n');
        const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
        const oldS = String(args.old_string ?? '').replace(/\r\n/g, '\n');
        const newS = String(args.new_string ?? '').replace(/\r\n/g, '\n');
        if (!oldS) return { ok: false, output: 'old_string je prázdný. Pro nový soubor použij write_file.' };
        if (oldS === newS) return { ok: false, output: 'old_string a new_string jsou stejné.' };
        let count = text.split(oldS).length - 1;
        let target = oldS;
        if (count === 0) {
          // Tolerance k odlišnému odsazení/koncovým mezerám.
          const norm = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n');
          if (norm(text).includes(norm(oldS))) {
            return { ok: false, output: 'Text nenalezen přesně (liší se mezery na koncích řádků nebo odsazení). Přečti soubor znovu přes read_file a zkopíruj text přesně.' };
          }
          return { ok: false, output: `old_string se v ${abs} nenachází. Přečti soubor přes read_file a použij přesný text.` };
        }
        if (count > 1 && !args.replace_all) {
          return { ok: false, output: `old_string se vyskytuje ${count}×. Přidej víc okolních řádků, aby byl jednoznačný, nebo nastav replace_all=true.` };
        }
        const idx = text.indexOf(target);
        const startLine = text.slice(0, idx).split('\n').length;
        const updated = args.replace_all ? text.split(target).join(newS) : text.slice(0, idx) + newS + text.slice(idx + target.length);
        await fsp.writeFile(abs, crlf ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
        return {
          ok: true,
          output: `Upraven ${abs} (${args.replace_all ? count + ' výskytů' : 'řádek ' + startLine}).`,
          display: { kind: 'diff', path: abs, diff: makeDiff(oldS, newS, startLine) },
        };
      }
      case 'list_dir': {
        const abs = resolvePath(cwd, args.path);
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        entries.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
        const lines = entries.slice(0, 1000).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
        if (entries.length > 1000) lines.push(`… a dalších ${entries.length - 1000}`);
        return { ok: true, output: `${abs}\n` + (lines.join('\n') || '(prázdná složka)') };
      }
      case 'glob': {
        const root = resolvePath(cwd, args.path);
        let pat = String(args.pattern || '').replace(/\\/g, '/');
        if (!pat.includes('/')) pat = '**/' + pat;
        const re = globToRegex(pat);
        const found = [];
        for await (const f of walk(root)) {
          if (signal?.aborted) break;
          if (re.test(f.rel)) {
            found.push(f.rel);
            if (found.length >= 500) break;
          }
        }
        return { ok: true, output: found.length ? found.join('\n') + (found.length >= 500 ? '\n… (prvních 500)' : '') : 'Nic nenalezeno.' };
      }
      case 'grep': {
        const root = resolvePath(cwd, args.path);
        let re;
        try { re = new RegExp(args.pattern, args.ignore_case ? 'i' : ''); } catch (e) { return { ok: false, output: `Neplatný regex: ${e.message}` }; }
        const inc = args.include ? globToRegex(args.include.includes('/') ? args.include : '**/' + args.include) : null;
        const results = [];
        let st;
        try { st = await fsp.stat(root); } catch { return { ok: false, output: `Cesta neexistuje: ${root}` }; }
        const files = st.isFile() ? [{ full: root, rel: path.basename(root) }] : walk(root);
        for await (const f of files) {
          if (signal?.aborted) break;
          if (inc && !inc.test(f.rel)) continue;
          let buf;
          try {
            const s = await fsp.stat(f.full);
            if (s.size > 2 * 1024 * 1024) continue;
            buf = await fsp.readFile(f.full);
          } catch { continue; }
          if (isProbablyBinary(buf)) continue;
          const lines = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
              if (results.length >= 300) break;
            }
          }
          if (results.length >= 300) break;
        }
        return { ok: true, output: results.length ? results.join('\n') + (results.length >= 300 ? '\n… (prvních 300 shod)' : '') : 'Žádná shoda.' };
      }
      case 'run_command': {
        const { code, out } = await runCommand(String(args.command || ''), cwd, args.timeout_sec, signal);
        const body = truncate(out.trim() || '(žádný výstup)');
        return { ok: code === 0, output: `Exit code: ${code}\n${body}`, display: { kind: 'command', command: args.command, code, out: body } };
      }
      case 'fetch_url': {
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, output: 'URL musí začínat http:// nebo https://' };
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        signal?.addEventListener('abort', () => ctrl.abort());
        try {
          const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Zdarma coding agent)' } });
          const ct = r.headers.get('content-type') || '';
          let text = await r.text();
          if (ct.includes('html')) text = htmlToText(text);
          return { ok: r.ok, output: `HTTP ${r.status} ${ct}\n\n${truncate(text, 20000)}` };
        } finally { clearTimeout(t); }
      }
      default:
        return { ok: false, output: `Neznámý nástroj: ${name}` };
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, output: `Soubor/složka neexistuje: ${e.path || args.path}` };
    return { ok: false, output: `Chyba: ${e.message}` };
  }
}

module.exports = { TOOL_DEFS, executeTool, resolvePath, isInside, globToRegex, makeDiff, truncate };
