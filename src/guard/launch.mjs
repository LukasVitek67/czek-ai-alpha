// czek-guard: dlouho běžící příkazy (appka, dev server) spustí na pozadí, aby nástroj bash nečekal do limitu.
//
// OpenCode 1.19.5 na Windows čeká, dokud proces na pozadí drží výstup nástroje (známá chyba, opravy jsou jen otevřená
// PR v anomalyco/opencode). Změřeno 15.–17. 11. v relaci uživatele (203 min): 55× spuštění appky (31 min) a 12× dev
// server / tauri dev (7 min), z toho 13× do limitu 120 s, kdy OpenCode celý strom procesů zabil – i s appkou, kterou
// chtěl agent ukázat. Agent psal `cd X && npm run dev > log &` (na pozadí běží celý řetěz a jeho shell drží výstup),
// `cargo run 2>&1 &` nebo appku v popředí. Pokus 19. 11. na skutečném OpenCode: `app &` 40,7 s (než appka skončila),
// `(app) > log 2>&1 < /dev/null &` 0,2 s a appka běží dál.
//
// Guard proto takový příkaz přepíše: celý na pozadí s výstupem do logu, chvíli počká (u `cargo run` na spuštění
// binárky), vrátí konec logu a appka běží dál. Předchozí spuštění téže relace se před dalším spuštěním nebo buildem
// ukončí (běžící .exe by jinak zamklo soubor: „Access is denied (os error 5)“).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

const LONG = [
  /\bcargo\s+(?:\+\S+\s+)?run\b/,
  /\b(?:cargo\s+)?tauri\s+dev\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch|tauri(?::dev|\s+dev))\b/,
  /\bnpx\s+(?:--yes\s+|-y\s+)?(?:vite|serve|http-server|live-server|electron|nodemon|tauri\s+dev)\b/,
  /(?:^|[;&|(]\s*)vite(?:\s+(?:dev|serve|preview))?\s*(?:$|[;&|)])/,
  /\belectron\s+\./,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\b(?:flask\s+run|uvicorn|gunicorn|nodemon)\b/,
];
// .exe, které nejsou appka (nástroje) a krátké dotazy na verzi/nápovědu
const NOT_APP_EXE = /^(?:bash|sh|cmd|powershell|pwsh|node|git|cargo|rustc|rustup|npm|npx|python3?|py|pip|where|taskkill|tasklist|choco|winget|code|rg|curl|tar|7z|ffmpeg|ffprobe|explorer)\.exe$/i;
const QUERY = /\s--?(?:version|help|V|h)\b|\s(?:build|test|check|clippy|fmt|install|lint)\b(?!\S)/;
const LAUNCHER = /^(?:start|start-process|saps|explorer(?:\.exe)?)$/i;

// Spuštění appky = .exe NA MÍSTĚ PŘÍKAZU (ne cesta k .exe kdekoli v řetězci). Živě 20. 11. (FurryBee, 0.15.21–23):
// starý vzor bral i `cp …/FurryBee.exe "C:\…\Desktop\FurryBee.exe"` a `ls -la …FurryBee.exe` → 5× kopírování „na
// pozadí“ místo výsledku a agent kopíroval dokola; a naopak `"…/FurryBee.exe" 2>&1 & sleep 3; ps aux | grep -i
// furrybee` vyřadilo pravidlo „obsahuje grep = jen čtení“ → 4× visení do limitu 120 s (přes 8 min).
/** Rozdělí příkaz na jednoduché příkazy podle ; && || | & ( ) a nového řádku (mimo uvozovky; 2>&1 a &> ne). */
function splitCommands(c) {
  const segs = [];
  let q = null; let s = 0;
  const push = (e) => { const raw = c.slice(s, e); const t = raw.trim(); if (t) { const st = s + raw.indexOf(t); segs.push({ text: t, start: st, end: st + t.length }); } };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '&' && (c[i - 1] === '>' || c[i + 1] === '>')) continue;
    if ('\n;|&()'.includes(ch)) { push(i); s = i + 1; }
  }
  push(c.length);
  return segs;
}
const words = (t) => [...String(t).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** Spouští příkaz appku (.exe)? → { seg: { text, start, end }, exe } nebo null. */
export function findLaunch(command) {
  const c = String(command || '');
  for (const seg of splitCommands(c)) {
    let w = words(seg.text);
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // VAR=hodnota příkaz
    if (/^(?:nohup|exec|env|time)$/.test(w[0] || '')) w.shift();
    // powershell -c "& .\X.exe" / "Start-Process X.exe" → skript uvnitř
    if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(w[0] || '')) {
      const script = w.slice(1).filter((x) => !/^-/.test(x)).pop();
      if (script && findLaunch(script)) return { seg, exe: findLaunch(script).exe };
      continue;
    }
    if (/^cmd(?:\.exe)?$/i.test(w[0] || '') && /^\/{1,2}c$/i.test(w[1] || '')) w = w.slice(2);
    if (LAUNCHER.test(w[0] || '')) { w.shift(); while (w.length && (w[0] === '' || (/^[-/]/.test(w[0]) && !/\.exe$/i.test(w[0])))) w.shift(); }
    const exe = w[0] || '';
    if (!/\.exe$/i.test(exe) || NOT_APP_EXE.test(exe.split(/[\\/]/).pop())) continue;
    if (QUERY.test(' ' + w.slice(1).join(' '))) continue;
    return { seg, exe };
  }
  return null;
}

/** Příkaz na pozadí jen do konce spuštění appky: modelovy `& sleep 3; ps aux | grep …` / `jobs` / `cat log` za ním
 * pryč (guard sám počká a vrátí konec výstupu; podshell by navíc po `ps` skončil a appku by pak nešlo ukončit). */
function launchBody(c, launch) {
  let b = c.slice(0, launch.seg.end);
  // neuzavřené „(“ z oříznutého `( app & …)` pryč (mimo uvozovky)
  const open = []; let q = null;
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') open.push(i);
    else if (ch === ')') open.pop();
  }
  for (const i of open.reverse()) b = b.slice(0, i) + b.slice(i + 1);
  return b.replace(/\s*&\s*$/, '').trim();
}
// buildy/kopírování, před kterými se ukončí appky spuštěné v téže relaci (jinak zamčený .exe)
const RELEASES_LOCK = /\b(?:cargo\s+(?:build|run|tauri)|tauri\s+build|npm\s+run\s+(?:build|tauri)|cp\s|copy\s|Copy-Item|robocopy|mv\s)\b/;

const DIR = () => path.join(os.tmpdir(), 'czek-run');
// Ukončení spuštěného příkazu: Git Bash spouští programy tak, že ve stromu procesů Windows NEJSOU potomky podshellu
// (ověřeno 19. 11.: `taskkill /T` na podshell `npm run dev` nechal appku běžet). Strom se proto projde přes tabulku
// procesů MSYS (`ps`: PID, PPID, WINPID) a od každého nalezeného procesu se zabije strom Windows (`taskkill /T` –
// procesy spuštěné nativně, např. node z npm). V souboru je „msys_pid:win_pid“ a zabije se jen, když PID pořád
// patří stejnému procesu (jinak by se po letech mohl trefit cizí proces se stejným číslem).
const KILL_FN = [
  'czek_kill() {',
  '  local p="${1%%:*}" w0="${1##*:}" all chg c w',
  '  [ -n "$p" ] && [ "$(cat /proc/$p/winpid 2>/dev/null)" = "$w0" ] || return 0',
  '  all=" $p "; chg=1',
  '  while [ $chg = 1 ]; do chg=0',
  '    for c in $(ps | sed \'s/^[^0-9]*//\' | awk -v l="$all" \'NR>1 && index(l, " "$2" ") && !index(l, " "$1" ") {print $1}\'); do all="$all$c "; chg=1; done',
  '  done',
  '  for c in $all; do w=$(cat /proc/$c/winpid 2>/dev/null); [ -n "$w" ] && taskkill //F //T //PID "$w" >/dev/null 2>&1; done',
  '  for c in $all; do kill -9 "$c" 2>/dev/null; done',
  '}',
].join('\n');
const killAll = (dir, sess) => `${KILL_FN}\nfor f in ${q(sh(dir))}/${sess}-*.pid; do [ -f "$f" ] && czek_kill "$(cat "$f")"; rm -f "$f"; done`;
const sh = (p) => p.replace(/\\/g, '/');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const short = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

/** Je příkaz dlouho běžící (appka, dev server)? Krátké dotazy (--version, build, test…) ne. */
export function isLongRunning(command) {
  const c = String(command || '');
  if (!c.trim() || /czek-run\//.test(c)) return false; // už přepsaný
  if (findLaunch(c)) return true; // appka (.exe na místě příkazu), i když za ní model kontroluje `ps | grep`
  if (!LONG.some((re) => re.test(c))) return false;
  if (QUERY.test(c) && !/\bcargo\s+(?:\+\S+\s+)?run\b/.test(c)) return false;
  return true;
}

/**
 * Přepíše dlouho běžící příkaz na spuštění na pozadí. Vrací { command, log, note } nebo null.
 * @param {string} command původní příkaz
 * @param {{session?: string, cwd?: string, waitS?: number}} o
 */
export function backgroundize(command, o = {}) {
  if (!isLongRunning(command)) return null;
  const dir = DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const sess = short(o.session || 'x');
  const key = short((o.cwd || '') + '|' + String(command).replace(/\s+/g, ' ').trim());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const log = sh(path.join(dir, `${sess}-${key}-${stamp}.log`));
  const pidf = sh(path.join(dir, `${sess}-${key}.pid`));
  const launch = findLaunch(command);
  // koncový & už nechceme, na pozadí jde celý příkaz; u appky jen do jejího spuštění
  const body = launch && !LONG.some((re) => re.test(command)) ? launchBody(String(command), launch) : String(command).replace(/\s*&\s*$/, '').trim();
  const cargoRun = /\bcargo\s+(?:\+\S+\s+)?run\b/.test(body);
  const exe = !cargoRun && !!launch && !LONG.some((re) => re.test(body));
  // limit nástroje bash je 120 s – čekání musí skončit hodně dřív. cargo run: smyčka se ukončí hned, jak log ukáže
  // „Running `" (binárka běží); 25 s je jen strop pro studený překlad – pak vrátí „běží na pozadí (překládá se)",
  // neblokuje a nehrozí 120s kill (měřeno 20. 11.: studený `cargo run` visel ~105 s a OpenCode ho zabil).
  // dev server: do adresy (ready/localhost); appka (.exe): 6 s stačí na pád při startu.
  const waitS = o.waitS ?? (cargoRun ? 25 : exe ? 6 : 15);
  const ready = cargoRun ? "'Running `'" : "'ready|listening|localhost:|127\\.0\\.0\\.1:|Local:|started server|compiled'";
  const lines = [
    killAll(dir, sess),
    `( ${body}`,
    `) > ${q(log)} 2>&1 < /dev/null &`,
    `czek_pid=$!`,
    `echo "$czek_pid:$(cat /proc/$czek_pid/winpid 2>/dev/null)" > ${q(pidf)}`,
    `czek_i=0; while [ $czek_i -lt ${waitS} ]; do sleep 1; czek_i=$((czek_i+1)); kill -0 $czek_pid 2>/dev/null || break;` +
      (exe ? '' : ` if grep -qiE ${ready} ${q(log)} 2>/dev/null; then sleep ${cargoRun ? 4 : 1}; break; fi;`) + ' done',
    `if kill -0 $czek_pid 2>/dev/null; then echo "[czek-guard] běží na pozadí (zůstane spuštěné) – výstup: ${log}"; else wait $czek_pid; czek_rc=$?; rm -f ${q(pidf)}; echo "[czek-guard] skončilo s kódem $czek_rc"; fi`,
    `echo "--- posledních 60 řádků výstupu:"; tail -n 60 ${q(log)} 2>/dev/null`,
  ];
  const note = `czek-guard ran this long-running command in the background so the bash tool does not hang until its timeout (OpenCode on Windows waits for background processes, and a timeout kills the app). It keeps running; its full output is in ${log} (check with: tail -n 80 "${log}"). Any app started this way in this session is stopped automatically before the next launch, cargo build or copy, so the .exe is never locked. Do not run it again just to see output.`;
  return { command: lines.join('\n'), log, note };
}

/** Před buildem/kopírováním ukončit appky spuštěné guardem v téže relaci (jinak zamčený .exe). Vrací příkaz nebo null. */
export function releaseLocks(command, o = {}) {
  const c = String(command || '');
  if (!RELEASES_LOCK.test(c) || /czek-run\//.test(c)) return null;
  const dir = DIR();
  const sess = short(o.session || 'x');
  let has = false;
  try { has = fs.readdirSync(dir).some((f) => f.startsWith(sess + '-') && f.endsWith('.pid')); } catch {}
  if (!has) return null;
  return `${killAll(dir, sess)}\n${c}`;
}

/** Staré logy (> 2 dny) pryč. */
export function pruneLogs() {
  const dir = DIR();
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86400e3) fs.rmSync(p, { force: true }); } catch {}
    }
  } catch {}
}
