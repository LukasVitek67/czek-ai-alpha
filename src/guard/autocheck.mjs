// Automatická kontrola po editu: guard sám spustí kompilátor a výsledek připíše k výstupu editu.
// Proč (měřeno na živé relaci 13. 11., waxwing, Rust): 599 kroků modelu, 580 z nich s jediným nástrojem,
// 309 editů a mezi nimi 90× `cargo check | head -N` jako samostatný krok. Každý krok posílá celý kontext
// (~65k tokenů). Vzor edit → kontrola → edit → kontrola = 2 kroky na jednu opravu. S výsledkem kontroly
// přímo u editu odpadá krok s kontrolou a model hned vidí VŠECHNY zbývající chyby.
// Bez závislostí (OpenCode plugin), jen vestavěné moduly.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const findUp = (dir, name) => {
  for (let d = dir; ;) {
    if (fs.existsSync(path.join(d, name))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
};

/** Jakou kontrolu spustit po změně souboru (nebo null). */
export function checkerFor(file) {
  const f = String(file || '');
  const dir = path.dirname(f);
  if (/\.rs$|[\\/]Cargo\.toml$/i.test(f)) {
    const root = findUp(dir, 'Cargo.toml');
    // plný formát (ne --message-format=short): u prvních chyb jde modelu i ukázka kódu, note a help (viz report)
    if (root) return { root, kind: 'cargo', label: 'cargo check', cmd: 'cargo', args: ['check', '--color', 'never'] };
  }
  if (/\.(ts|tsx|mts|cts)$/i.test(f)) {
    const root = findUp(dir, 'tsconfig.json');
    const tsc = root && path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (tsc && fs.existsSync(tsc)) return { root, kind: 'tsc', label: 'tsc --noEmit', cmd: 'node', args: [tsc, '--noEmit', '--pretty', 'false', '-p', root] };
  }
  return null;
}

/** Spustí kontrolu; { out, code } nebo { timeout: true } / null (nástroj chybí). */
export function runCheck(c, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    try {
      child = spawn(c.cmd, c.args, { cwd: c.root, windowsHide: true, env: { ...process.env, CARGO_TERM_COLOR: 'never' } });
    } catch { resolve(null); return; }
    const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => {
      try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch {}
      fin({ timeout: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', () => fin(null));
    child.on('close', (code) => fin({ out, code }));
  });
}

/**
 * Plný výstup rustc/cargo → hlášky { kind, short, text, lines }. Hláška začíná „error[E…]: …“ / „warning: …“ na
 * začátku řádku, pokračuje řádkem „--> soubor:ř:s“, ukázkou kódu, note a help. short = tvar --message-format=short.
 */
export function blocks(out) {
  const res = []; let cur = null;
  for (const l of String(out || '').split(/\r?\n/)) {
    if (/^(error|warning)(\[[A-Z]\d{4}\])?: /.test(l)) { cur = { head: l, lines: [l] }; res.push(cur); continue; }
    if (/^\s+(Checking|Compiling|Finished|Blocking|Updating|Downloaded|Downloading|Locking|Adding|Building)\b|^(For more information about|Some errors have detailed explanations)/.test(l)) { cur = null; continue; }
    if (cur) cur.lines.push(l);
  }
  return res
    .filter((b) => !/^error: (could not compile|aborting due to)|^warning: .*generated \d+ warnings?|^warning: build failed/.test(b.head))
    .map((b) => {
      while (b.lines.length && !b.lines[b.lines.length - 1].trim()) b.lines.pop();
      const loc = b.lines.map((x) => /^\s*--> (.+?:\d+:\d+)\s*$/.exec(x)).find(Boolean);
      const kind = b.head.startsWith('error') ? 'error' : 'warning';
      return { kind, short: loc ? `${loc[1]}: ${b.head}` : b.head, text: b.lines.map((x) => (x.length > 240 ? x.slice(0, 240) + '…' : x)).join('\n'), lines: b.lines.length };
    });
}

/** Výstup kontroly → { errors: [...], warnings: n }. */
export function parse(kind, out) {
  const lines = String(out || '').split(/\r?\n/);
  if (kind === 'tsc') {
    return { errors: lines.filter((l) => /\): error TS\d+/.test(l)), warnings: 0 };
  }
  if (/^\s*--> .+:\d+:\d+\s*$/m.test(String(out || ''))) { // plný formát rustc
    const bl = blocks(out);
    return { errors: bl.filter((b) => b.kind === 'error').map((b) => b.short), warnings: bl.filter((b) => b.kind === 'warning').length };
  }
  const errors = lines.filter((l) => (/:\d+:\d+: error/.test(l) || /^error(\[E\d+\])?:/.test(l)) && !/could not compile|aborting due to|^error: Recipe/.test(l));
  const warnings = lines.filter((l) => /:\d+:\d+: warning/.test(l)).length;
  return { errors, warnings };
}

// Plné hlášky jen pro první chyby a jen když jich je málo (u desítek chyb stačí seznam, jinak dlouhý výstup).
const DETAIL_MAX_ERRORS = 8;
const DETAIL_BLOCKS = 3;
const DETAIL_LINES = 90;

export function report(c, r, maxLines = 50) {
  if (!r) return '';
  if (r.timeout) return `czek-guard tried to run \`${c.label}\` after this edit, but it did not finish in time. Run it yourself once, in the background if it is slow.`;
  const { errors, warnings } = parse(c.kind, r.out);
  const rel = (l) => l.split(c.root + path.sep).join('');
  if (!errors.length) {
    if (r.code && r.code !== 0) {
      const tail = String(r.out).trim().split(/\r?\n/).slice(-15).map(rel).join('\n');
      return `czek-guard ran \`${c.label}\` after this edit and it failed (exit ${r.code}):\n${tail}`;
    }
    return `czek-guard ran \`${c.label}\` after this edit: no errors${warnings ? ` (${warnings} warnings)` : ''}. You do not need to run the check yourself.`;
  }
  const shown = errors.slice(0, maxLines).map(rel);
  const more = errors.length > shown.length ? `\n… and ${errors.length - shown.length} more` : '';
  // Živě 20. 11. (FurryBee, egui): 3× E0283 „type annotations needed“ a 83 editů main.rs za 15 min, pak to model
  // vzdal. Viděl jen jednořádkový tvar (--message-format=short); oprava byla v řádku „help:“ plné hlášky.
  let detail = '';
  const bl = c.kind === 'cargo' ? blocks(r.out).filter((b) => b.kind === 'error') : [];
  if (bl.length && bl.length <= DETAIL_MAX_ERRORS) {
    const pick = []; let total = 0;
    for (const b of bl) { if (pick.length >= DETAIL_BLOCKS || (pick.length && total + b.lines > DETAIL_LINES)) break; pick.push(rel(b.text)); total += b.lines; }
    detail = `\nFull compiler message${pick.length > 1 ? 's' : ''}${pick.length < bl.length ? ` for the first ${pick.length}` : ''} (the note/help lines often say exactly what to change):\n${pick.join('\n\n')}`;
  }
  return `czek-guard ran \`${c.label}\` after this edit (you do not need to run it yourself). ${errors.length} error${errors.length > 1 ? 's' : ''} remain${errors.length > 1 ? '' : 's'}:\n${shown.join('\n')}${more}${detail}\nFix ALL of them in your next response: call the edit tool several times in that one response (one call per error), not one edit per response.`;
}

// Stejné chyby po sobě (bez čísel řádků/sloupců – edity je posouvají) → model zkouší drobné obměny dokola.
const STUCK_AFTER = 4;
const history = new Map(); // kořen projektu → { sig, n }
export function stuckNote(root, errors) {
  const sig = errors.map((l) => l.replace(/:\d+:\d+:/, ':')).sort().join('\n');
  const h = history.get(root);
  const n = errors.length && h && h.sig === sig ? h.n + 1 : 1;
  history.set(root, { sig, n });
  if (!errors.length || n < STUCK_AFTER) return '';
  return `\nThe same ${errors.length > 1 ? `${errors.length} errors have` : 'error has'} survived your last ${n} edits, so the current approach does not work. Do not try another small variation. Read the full compiler message (note/help), check the real signature of the API you call (crate sources are under ~/.cargo/registry/src), then change the approach: write the types out explicitly, or restructure that code.`;
}

// Odložené spuštění na kořen projektu: víc editů v jednom kroku (paralelní volání) = jedna kontrola.
// Celý výsledek dostane poslední edit, ostatní jen krátkou větu.
const queues = new Map(); // root → { timer, waiters, c, running }

// Manifesty závislostí: přeložení po jejich změně trvá 80–90 s (znovu se řeší celý strom), tak se nespouští.
const MANIFEST = /^(Cargo\.toml|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|requirements\.txt|pyproject\.toml|Gemfile|Gemfile\.lock|composer\.json)$/i;

export function autoCheck(file, o = {}) {
  if (MANIFEST.test(path.basename(String(file || '')))) {
    return Promise.resolve('czek-guard: manifest changed; skipping inline check (dependency resolve is slow). The build will catch errors.');
  }
  const c = (o.checkerFor || checkerFor)(file);
  if (!c) return Promise.resolve('');
  const delay = o.delay ?? 400;
  return new Promise((resolve) => {
    let q = queues.get(c.root);
    if (!q) { q = { waiters: [], timer: null, c }; queues.set(c.root, q); }
    q.waiters.push(resolve);
    clearTimeout(q.timer);
    q.timer = setTimeout(async () => {
      queues.delete(c.root);
      const r = await (o.run || runCheck)(c, o.timeoutMs ?? 90000);
      let text = report(c, r);
      if (r && !r.timeout) text += stuckNote(c.root, parse(c.kind, r.out).errors);
      q.waiters.forEach((w, i) => w(i === q.waiters.length - 1 ? text : (text ? `(czek-guard checked this together with the other edits in this step; the \`${c.label}\` result is on the last edit.)` : '')));
    }, delay);
  });
}
