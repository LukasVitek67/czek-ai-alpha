'use strict';
// Automatická instalace OpenCode, když na počítači chybí (učitel, spolužáci, čistý PC).
// Bere OFICIÁLNÍ binárku z registru npm (balíček opencode-windows-x64, ten samý, který stáhne
// `npm i -g opencode-ai`), ověří ji kontrolním součtem z registru (sha512) a uloží do dat czek-ai.
// Node.js ani npm k tomu nejsou potřeba. Verze je připnutá na tu, se kterou jsou otestované guard a pluginy.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const OC_VERSION = '1.19.5';
const REGISTRY = () => (process.env.ZDARMA_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
// Kontrolní součty připnuté verze (registr npm, 23. 11.): se složkou pro třídu se OpenCode ověří i bez internetu.
const OC_INTEGRITY = {
  'opencode-windows-x64@1.19.5': 'sha512-xCVbrA8A/qQTAdBIKyhK5tx3/mcq18yF82Mi8phry0MJb2631nnnpxF9m6FFfWAVHyer4qFGrO7hbWXesHQ1Gg==',
  'opencode-windows-x64-baseline@1.19.5': 'sha512-yRHN+TsfLjfLmdQVAVWqTGfGP1yq8YtUFy9Jw33XhlPIp77slBdCJrj2PC4amuEl6BJtaIQDhDFbpJ8+a5z7Qw==',
};
const ocTarball = (pkg, ver) => `${REGISTRY()}/${pkg}/-/${pkg}-${ver}.tgz`;

// ---------------------------------------------------------------- složka pro třídu (jedno stažení pro všechny)
// Učitel jednou spustí czek-ai.exe --priprav-tridu → vedle exe vznikne czek-ai-cache/ (files/: Node.js, Git,
// OpenCode; npm/: cache npm se všemi balíčky OmniRoute; manifest.json). Studenti, kteří spustí czek-ai.exe vedle
// ní (i ze sdíleného disku), nestahují nic z internetu: soubory se berou odtud po ověření stejným kontrolním
// součtem jako stažené (nesedí → stáhne se normálně), npm instaluje z kopie cache (--prefer-offline).
let CLASS = null;
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Přejmenování s opakováním při EPERM/EACCES/EBUSY (Windows: antivirus/Defender zrovna kontroluje čerstvě rozbalené
 * soubory a drží je otevřené). Čistý Windows 11 ve VM 26. 11.: „Git selhal EPERM: operation not permitted, rename
 * 'git.part' -> 'git'“ → agent bez Git Bashe. Stejně jako npm (graceful-fs) zkouší až ~60 s s rostoucí pauzou.
 */
async function renameRetry(from, to, { maxMs = Number(process.env.ZDARMA_RENAME_RETRY_MS) || 60000, onRetry } = {}) {
  const t0 = Date.now();
  for (let i = 0, wait = 100; ; i++) {
    try { fs.renameSync(from, to); return i; } catch (e) {
      if (!/^(EPERM|EACCES|EBUSY)$/.test(e.code) || Date.now() - t0 + wait > maxMs) throw e;
      onRetry?.(e, i + 1);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.5, 2000);
    }
  }
}
const sha512b64 = (b) => crypto.createHash('sha512').update(b).digest('base64');
/** První složka z kandidátů, ve které je manifest.json od --priprav-tridu, jinak null. */
function findClassCache(cands) {
  return cands.filter(Boolean).find((d) => { try { return !!JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')).czekai; } catch { return false; } }) || null;
}
function setClassCache(dir) { CLASS = dir || null; }
/** Soubor ze složky pro třídu (files/<jméno z URL>), jen když projde kontrolou; jinak null. */
function fromClass(url, check) {
  if (!CLASS) return null;
  const f = path.join(CLASS, 'files', path.basename(new URL(url).pathname));
  try { const b = fs.readFileSync(f); return check(b) ? b : null; } catch { return null; }
}

// Stejná detekce jako oficiální postinstall opencode-ai: bez AVX2 (starší CPU) je potřeba varianta „baseline“.
function supportsAvx2() {
  if (process.arch !== 'x64') return false;
  if (process.platform !== 'win32') return true;
  const cmd = '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const out = String(r.stdout || '').trim().toLowerCase();
      if (r.status === 0 && (out === 'true' || out === 'false')) return out === 'true';
    } catch {}
  }
  return true; // nejde zjistit → běžná varianta; když nepoběží, zkusí se baseline (viz installOpencode)
}

/** Vytáhne jeden soubor z tar archivu (ustar/pax, jak ho balí npm). */
function untarFile(buf, wanted) {
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = longName || (prefix ? prefix + '/' : '') + str(0, 100);
    longName = null;
    const start = off + 512;
    const body = buf.subarray(start, start + size);
    if (type === 'x') { // pax: delší jméno v záznamu path=
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
    } else if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if ((type === '0' || type === '\0') && name === wanted) return Buffer.from(body);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Stáhne URL s průběhem; vrátí Buffer, sha512 (base64) a sha256 (hex). */
async function download(url, onBytes, signal) {
  const r = await fetch(url, { signal, headers: { 'user-agent': 'czek-ai' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const h512 = crypto.createHash('sha512');
  const h256 = crypto.createHash('sha256');
  const chunks = [];
  let done = 0;
  for await (const c of r.body) {
    const b = Buffer.from(c);
    chunks.push(b);
    h512.update(b);
    h256.update(b);
    done += b.length;
    onBytes?.(done, total);
  }
  return { buf: Buffer.concat(chunks), sha512: h512.digest('base64'), sha256: h256.digest('hex') };
}

/** Spustí binárku s --version; vrátí verzi, nebo null, když nejde (chybí AVX2, poškozená…). */
function binVersion(file) {
  try {
    const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const v = String(r.stdout || '').trim();
    return r.status === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

/**
 * Nainstaluje OpenCode do `dir` (dir/opencode.exe). Vrátí cestu k binárce.
 * @param {{dir: string, version?: string, onProgress?: (p: {phase: string, done?: number, total?: number, pkg?: string}) => void, signal?: AbortSignal}} o
 */
async function installOpencode(o) {
  const version = o.version || OC_VERSION;
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const plat = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform;
  const base = `opencode-${plat}-${process.arch}`;
  const order = supportsAvx2() ? [base, `${base}-baseline`] : [`${base}-baseline`, base];
  const progress = o.onProgress || (() => {});
  fs.mkdirSync(o.dir, { recursive: true });
  const target = path.join(o.dir, exeName);
  let lastErr = null;
  for (const pkg of order) {
    try {
      const known = OC_INTEGRITY[`${pkg}@${version}`];
      let buf = known ? fromClass(ocTarball(pkg, version), (b) => `sha512-${sha512b64(b)}` === known) : null;
      if (buf) progress({ phase: 'cache', pkg });
      else {
        progress({ phase: 'meta', pkg });
        const metaRes = await fetch(`${REGISTRY()}/${pkg}/${version}`, { signal: o.signal });
        if (!metaRes.ok) throw new Error(`registr npm: HTTP ${metaRes.status} pro ${pkg}@${version}`);
        const meta = await metaRes.json();
        const want = String(meta?.dist?.integrity || '');
        if (!want.startsWith('sha512-') || !meta?.dist?.tarball) throw new Error(`registr npm nevrátil tarball/kontrolní součet pro ${pkg}`);
        const got = await download(meta.dist.tarball, (done, total) => progress({ phase: 'download', done, total, pkg }), o.signal);
        if (`sha512-${got.sha512}` !== want) throw new Error(`kontrolní součet nesouhlasí (${pkg}), stažený soubor se nepoužije`);
        buf = got.buf;
      }
      progress({ phase: 'extract', pkg });
      const tar = await new Promise((res, rej) => zlib.gunzip(buf, (e, out) => (e ? rej(e) : res(out))));
      const exe = untarFile(tar, `package/bin/${exeName}`);
      if (!exe) throw new Error(`v balíčku ${pkg} chybí bin/${exeName}`);
      const part = target + '.part';
      fs.writeFileSync(part, exe, { mode: 0o755 });
      progress({ phase: 'verify', pkg });
      const v = binVersion(part);
      if (!v) { try { fs.unlinkSync(part); } catch {} throw new Error(`${pkg} se na tomto počítači nespustil`); }
      try { fs.unlinkSync(target); } catch {}
      await renameRetry(part, target);
      fs.writeFileSync(path.join(o.dir, 'installed.json'), JSON.stringify({ pkg, version: v, at: new Date().toISOString() }, null, 2));
      progress({ phase: 'done', pkg });
      return target;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw new Error(`Automatická instalace OpenCode selhala: ${lastErr?.message || lastErr}. Ručně: npm i -g opencode-ai@${version}`);
}

// ---------------------------------------------------------------- Node.js, Git Bash, OmniRoute
// Připnuté verze (aspoň 2 týdny staré) s kontrolními součty zapsanými přímo tady: stažený soubor se použije,
// jen když sedí bajt po bajtu. Zdroje jsou oficiální (nodejs.org, git-for-windows na GitHubu, registr npm).
const NODE = {
  version: '24.22.1', // LTS „Krypton“, 20. 10. 2026; OmniRoute chce >=22.22.2 <23 || >=24 <27
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  url: () => `https://nodejs.org/dist/v${NODE.version}/node-v${NODE.version}-win-x64.zip`,
  // Linux x64 (25. 11.): stejná verze, součet z https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
  linuxSha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
  linuxUrl: () => `https://nodejs.org/dist/v${NODE.version}/node-v${NODE.version}-linux-x64.tar.xz`,
};
/** npm-cli.js k danému Node: přenosný Windows (node.exe + node_modules/npm vedle) i Linux (bin/node + lib/node_modules/npm). */
function npmCliFor(node) {
  const dirs = [path.dirname(node)];
  try { dirs.push(path.dirname(fs.realpathSync(node))); } catch {}
  for (const d of dirs) {
    for (const c of [path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}
const GIT = {
  version: '2.56.0.4', // Git for Windows 2.56.0.windows.4, 26. 10. 2026 (PortableGit, bez instalace a admina)
  sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1',
  url: () => 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
};
const OMNI_VERSION = '3.8.53'; // otestovaná verze (src/omniroute.js na ni sedí: API, plugin pro OpenCode)
// Průběh instalace omniroute@3.8.53 v úvodním okně (změřeno 14. 11.; při změně verze přeměřit, viz HANDOFF):
const OMNI_META = 1388; // řádků npm http při zjišťování balíčků (bez .tgz)
const OMNI_PKGS = 1327; // řádků npm http …tgz (staženo / z cache)
const OMNI_BYTES = 2624 * 1048576; // o kolik ubylo místa na disku při rozbalení (měřeno 14. 11.; SLIM_PRUNE maže až potom)
const OMNI_SCRIPTS = 7; // instalačních skriptů (@parcel/watcher, @swc/core, esbuild, keytar, omniroute, onnxruntime-node, protobufjs)

// Štíhlá instalace (25. 11.): npm install je plný (všechny nativní binárky pro platformu, better-sqlite3, sharp…),
// pak se smažou jen volitelné balíky pro lokální embeddingy, které czek-ai nikdy nezapne (smazaná volitelná závislost =
// stejný stav, jako když se nepovede nainstalovat, OmniRoute s ním počítá), a přeložená dokumentace. `--omit=optional`
// NE: vyhodí i @esbuild/@img/@next/@swc/@parcel binárky a better-sqlite3 (docs/research/2026-11-23-omniroute-slim).
// Cesty relativně ke složce instalace.
const SLIM_PRUNE = ['node_modules/onnxruntime-node', 'node_modules/onnxruntime-web', 'node_modules/@huggingface/transformers', 'node_modules/omniroute/dist/docs/i18n'];
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
const TAR = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

async function fetchVerified(what, url, sha256, progress, signal) {
  const cached = fromClass(url, (b) => sha256hex(b) === sha256);
  if (cached) { progress({ phase: 'cache', what }); return cached; }
  const { buf, sha256: got } = await download(url, (done, total) => progress({ phase: 'download', done, total, what }), signal);
  if (got !== sha256) throw new Error(`kontrolní součet nesouhlasí (${what}), stažený soubor se nepoužije`);
  return buf;
}

/** Přenosný Node.js do dir (dir/node.exe + npm). Bez instalace, bez admina, nic v PATH. */
async function installNode(o) {
  const progress = o.onProgress || (() => {});
  if (process.platform === 'linux' && process.arch === 'x64') return installNodeLinux(o, progress);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('přenosný Node.js jen pro Windows a Linux x64');
  const buf = await fetchVerified('Node.js', NODE.url(), NODE.sha256, progress, o.signal);
  progress({ phase: 'extract', what: 'Node.js' });
  const part = o.dir + '.part';
  rmrf(part);
  fs.mkdirSync(part, { recursive: true });
  const zip = path.join(part, 'node.zip');
  fs.writeFileSync(zip, buf);
  const r = spawnSync(TAR(), ['-xf', zip, '-C', part], { windowsHide: true, encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error('rozbalení Node.js selhalo: ' + String(r.stderr || r.error || '').slice(0, 300));
  fs.unlinkSync(zip);
  const inner = path.join(part, `node-v${NODE.version}-win-x64`);
  const nodeExe = path.join(inner, 'node.exe');
  const v = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout?.trim();
  if (v !== 'v' + NODE.version) throw new Error('přenosný Node.js se nespustil');
  rmrf(o.dir);
  await renameRetry(inner, o.dir);
  rmrf(part);
  return path.join(o.dir, 'node.exe');
}

/** Přenosný Node.js pro Linux x64 do dir (dir/bin/node + dir/lib/node_modules/npm). Bez sudo, nic v PATH. */
async function installNodeLinux(o, progress) {
  const buf = await fetchVerified('Node.js', NODE.linuxUrl(), NODE.linuxSha256, progress, o.signal);
  progress({ phase: 'extract', what: 'Node.js' });
  const part = o.dir + '.part';
  rmrf(part);
  fs.mkdirSync(part, { recursive: true });
  const tarball = path.join(part, 'node.tar.xz');
  fs.writeFileSync(tarball, buf);
  const r = spawnSync('tar', ['-xJf', tarball, '-C', part], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error('rozbalení Node.js selhalo: ' + String(r.stderr || r.error || '').slice(0, 300));
  fs.unlinkSync(tarball);
  const inner = path.join(part, `node-v${NODE.version}-linux-x64`);
  const v = spawnSync(path.join(inner, 'bin', 'node'), ['--version'], { encoding: 'utf8', timeout: 30000 }).stdout?.trim();
  if (v !== 'v' + NODE.version) throw new Error('přenosný Node.js se nespustil');
  rmrf(o.dir);
  await renameRetry(inner, o.dir);
  rmrf(part);
  return path.join(o.dir, 'bin', 'node');
}

/** Přenosný Git for Windows do dir (dir/bin/bash.exe = Git Bash pro nástroj bash v OpenCode). */
async function installGit(o) {
  const progress = o.onProgress || (() => {});
  if (process.platform !== 'win32') throw new Error('PortableGit jen pro Windows');
  const buf = await fetchVerified('Git', GIT.url(), GIT.sha256, progress, o.signal);
  progress({ phase: 'extract', what: 'Git' });
  const part = o.dir + '.part';
  rmrf(part);
  fs.mkdirSync(path.dirname(o.dir), { recursive: true });
  const sfx = o.dir + '-setup.7z.exe';
  fs.writeFileSync(sfx, buf);
  // samorozbalovací 7z: -o cíl, -y bez dotazů; windowsHide schová jeho okno s průběhem
  const r = await new Promise((res) => {
    const c = require('child_process').spawn(sfx, [`-o${part}`, '-y'], { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, 10 * 60000);
    c.on('exit', (code) => { clearTimeout(t); res(code); });
    c.on('error', () => { clearTimeout(t); res(-1); });
  });
  try { fs.unlinkSync(sfx); } catch {}
  const bash = path.join(part, 'bin', 'bash.exe');
  if (r !== 0 || !fs.existsSync(bash)) throw new Error(`rozbalení Gitu selhalo (kód ${r})`);
  const ok = spawnSync(bash, ['-lc', 'echo ok'], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout?.trim();
  if (!/ok$/.test(ok || '')) throw new Error('Git Bash se nespustil');
  rmrf(o.dir);
  await renameRetry(part, o.dir);
  return path.join(o.dir, 'bin', 'bash.exe');
}

/**
 * OmniRoute do vlastní složky czek-ai (dir/node_modules/omniroute) přes npm daného Node.js. Nic globálně.
 * Trvá ~4–7 min (Windows 22. 11.: 407 s, ~2,6 GB na disku, 1 327 balíčků, ~174 tisíc souborů). onLine dostává výstup npm (kvůli logu).
 */
async function installOmniroute(o) {
  // Složka pro třídu s archivem hotové instalace → rozbalit (bez npm); nepovede se → normální npm níž.
  const tarFile = !o.cacheOut && classTar();
  if (tarFile) {
    try { return await extractOmniTar(tarFile, o); } catch (e) {
      if (o.signal?.aborted) throw e;
      o.onLine?.(`[třída] archiv OmniRoute nejde rozbalit (${e.message}), instaluji přes npm`);
    }
  }
  const node = o.node;
  const npmCli = npmCliFor(node);
  if (!npmCli) throw new Error(`u Node.js (${node}) chybí npm`);
  const part = o.dir + '.part';
  rmrf(part);
  fs.mkdirSync(part, { recursive: true });
  fs.writeFileSync(path.join(part, 'package.json'), JSON.stringify({ name: 'czek-ai-omniroute', private: true }, null, 2));
  const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH || ''), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  // Skutečný průběh pro úvodní okno (změřeno 14. 11., teplá cache: zjišťování ~70 s, stažení ~2 s, rozbalení
  // ~300 s = 174 tisíc souborů a složek, skripty ~2 s). Zdroje, npm s loglevel info (zahrnuje http):
  //  - zjišťování: řádky „npm http fetch GET 200 https://registry…/<balíček>“ (meta), nelogují se (tisíce);
  //  - stažení: „npm http fetch GET 200 …/x.tgz“, z cache „npm http cache …tgz“;
  //  - rozbalení: o kolik ubylo volného místa na disku od začátku stahování (jedno volání statfs; spočítat
  //    soubory trvá 103 s, počet složek balíčků je hotový už za třetinu času);
  //  - instalační skripty: „npm info run <balíček>@<verze> <událost> <cesta> <příkaz>“ a konec „… { code: 0 …“.
  // ZDARMA_OMNI_FULL=1 (nebo o.full) = nic nemazat (SLIM_PRUNE výše).
  const full = o.full ?? process.env.ZDARMA_OMNI_FULL === '1';
  const args = [npmCli, 'install', `omniroute@${o.version || OMNI_VERSION}`, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=info', '--prefix', part];
  // Složka pro třídu: cache npm se nejdřív zkopíruje k sobě (sdílený disk bývá jen pro čtení a npm do cache
  // zapisuje), pak instalace z ní; co v ní chybí, stáhne npm normálně. o.cacheOut = plnění cache (--priprav-tridu).
  let cacheCopy = null;
  if (o.cacheOut) args.push('--cache', o.cacheOut);
  else if (CLASS && fs.existsSync(path.join(CLASS, 'npm', '_cacache'))) {
    cacheCopy = part + '-npmcache';
    const t = Date.now();
    rmrf(cacheCopy);
    try {
      // asynchronně: cpSync 1,2 GB blokoval hlavní proces ~34 s (úvodní okno zamrzlo, ukázalo se až za 40 s)
      await fs.promises.cp(path.join(CLASS, 'npm'), cacheCopy, { recursive: true });
      args.push('--cache', cacheCopy, '--prefer-offline');
      o.onLine?.(`[třída] cache npm zkopírována ze složky pro třídu za ${Math.round((Date.now() - t) / 1000)} s`);
    } catch (e) { o.onLine?.(`[třída] cache npm nejde zkopírovat (${e.message}), stahuji z internetu`); rmrf(cacheCopy); cacheCopy = null; }
  }
  const t0 = Date.now();
  const prog = { phase: 'npm', elapsed: 0, meta: 0, metaTotal: OMNI_META, tgz: 0, total: OMNI_PKGS, written: 0, size: OMNI_BYTES, scripts: [], scriptsDone: 0, scriptsTotal: OMNI_SCRIPTS };
  const running = new Set();
  const freeBytes = () => { try { const st = fs.statfsSync(part); return st.bavail * st.bsize; } catch { return null; } };
  let free0 = null;
  const code = await new Promise((res) => {
    const c = require('child_process').spawn(node, args, { cwd: part, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
      if (/^npm http (fetch \w+ \d+|cache) \S*\.tgz\b/.test(l)) { prog.tgz++; return; }
      if (/^npm http /.test(l)) { prog.meta++; return; }
      const run = /^npm info run (@?[^@\s]+)@\S+ \w+ (\{)?/.exec(l);
      if (run) {
        if (run[2]) { if (running.delete(run[1])) prog.scriptsDone++; } else running.add(run[1]);
        prog.scripts = [...running];
      }
      o.onLine?.(l);
    });
    c.stdout.on('data', line);
    c.stderr.on('data', line);
    const tick = setInterval(() => {
      prog.elapsed = Date.now() - t0;
      if (prog.tgz) {
        const fr = freeBytes();
        if (free0 == null) free0 = fr;
        else if (fr != null) prog.written = Math.max(prog.written, free0 - fr);
      }
      o.onProgress?.({ ...prog });
    }, 1000);
    // celý strom (npm pouští instalační skripty jako podprocesy, c.kill() by je na Windows nechal běžet)
    const killTree = () => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else c.kill();
      } catch {}
    };
    const kill = setTimeout(killTree, 40 * 60000);
    o.signal?.addEventListener('abort', killTree);
    c.on('exit', (cd) => { clearInterval(tick); clearTimeout(kill); res(cd); });
    c.on('error', (e) => { clearInterval(tick); clearTimeout(kill); o.onLine?.(String(e)); res(-1); });
  });
  if (cacheCopy) rmrf(cacheCopy);
  const bin = path.join(part, 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');
  if (code !== 0 || !fs.existsSync(bin)) { rmrf(part); throw new Error(`npm install omniroute skončil chybou (kód ${code})`); }
  if (!full) for (const p of SLIM_PRUNE) rmrf(path.join(part, ...p.split('/')));
  rmrf(o.dir);
  await renameRetry(part, o.dir);
  return path.join(o.dir, 'node_modules', 'omniroute');
}

/**
 * Node.js 24.12 na Windows spadne (0xC0000409, bez hlášky) na fs.cpSync, když je v cestě diakritika. Postinstall
 * OmniRoute ho volá (sql.js → dist/node_modules), takže instalace do C:\Users\Šimon\… se systémovým Node 24.12
 * selže (změřeno 23. 11.; přenosný 24.22.1 je v pořádku). Zkouška ~0,1 s, jen když je v cestě ne-ASCII znak.
 */
function cpSyncBroken(node, dir) {
  if (!/[^\x00-\x7f]/.test(dir)) return false;
  const t = path.join(dir, `.czek-cptest-${process.pid}`);
  try {
    fs.mkdirSync(path.join(t, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(t, 'a', 'b', 'f'), 'x');
    const r = spawnSync(node, ['-e', 'require("fs").cpSync(process.argv[1] + "/a", process.argv[1] + "/c", { recursive: true })', t], { windowsHide: true, timeout: 30000 });
    return r.status !== 0;
  } catch { return false; } finally { rmrf(t); }
}

/**
 * Složka pro třídu (učitel jednou, czek-ai.exe --priprav-tridu): files/ (Node.js, Git, OpenCode obě varianty)
 * + npm/ (cache npm z plné instalace OmniRoute do dočasné složky, která se pak smaže) + manifest.json.
 * @param {{dir: string, node: string, onProgress?: Function, onNpm?: Function, onLine?: Function, signal?: AbortSignal}} o
 */
async function prepareClassCache(o) {
  const files = path.join(o.dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const save = async (what, url, check) => {
    const f = path.join(files, path.basename(new URL(url).pathname));
    try { if (check(fs.readFileSync(f))) return; } catch {}
    // 3 pokusy: 23. 11. spadlo stahování OpenCode uprostřed („terminated“ = spojení přerušené) a s ním celá příprava
    let buf = null;
    for (let n = 1; !buf; n++) {
      try {
        const got = (await download(url, (done, total) => o.onProgress?.({ phase: 'download', what, done, total }), o.signal)).buf;
        if (!check(got)) throw new Error(`kontrolní součet nesouhlasí (${what})`);
        buf = got;
      } catch (e) {
        if (n >= 3 || o.signal?.aborted) throw e;
        o.onLine?.(`[třída] ${what}: ${e.message}, pokus ${n + 1} za ${n * 5} s`);
        await new Promise((r) => setTimeout(r, n * 5000));
      }
    }
    fs.writeFileSync(f + '.part', buf);
    await renameRetry(f + '.part', f);
  };
  await save('Node.js', NODE.url(), (b) => sha256hex(b) === NODE.sha256);
  await save('Git', GIT.url(), (b) => sha256hex(b) === GIT.sha256);
  for (const [k, want] of Object.entries(OC_INTEGRITY)) {
    const [pkg, ver] = k.split('@');
    await save(pkg, ocTarball(pkg, ver), (b) => `sha512-${sha512b64(b)}` === want);
  }
  // Dočasná instalace v %TEMP%, ne ve složce pro třídu: ta bývá na sdíleném disku (\\server\… cmd.exe jako
  // pracovní složku neumí) a 23. 11. ve složce „sdílený disk třída“ spadl postinstall OmniRoute (0xC0000409).
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'czek-trida-'));
  const tmp = path.join(tmpRoot, 'omniroute');
  let tarOk = false;
  try {
    // Instalace připnutým přenosným Node (ze složky files/): nativní moduly OmniRoute (better-sqlite3) jsou vázané na
    // hlavní verzi Node, kterou pak studenti spustí rozbalený archiv (main.js: czek-install.json).
    let node = o.node;
    if (process.platform === 'win32' && process.arch === 'x64') {
      const prev = CLASS;
      CLASS = o.dir;
      try { node = await installNode({ dir: path.join(tmpRoot, 'node') }); } finally { CLASS = prev; }
    }
    await installOmniroute({ dir: tmp, node, cacheOut: path.join(o.dir, 'npm'), onLine: o.onLine, onProgress: o.onNpm, signal: o.signal });
    // Hotová instalace jako archiv: rozbalení u studenta 244 s místo npm z cache 353–383 s + 50 s kopie (23. 11.)
    o.onProgress?.({ phase: 'pack' });
    const tarFile = path.join(o.dir, 'omniroute-app.tar');
    const t0 = Date.now();
    const code = await new Promise((res) => {
      const c = require('child_process').spawn(TAR(), ['-cf', tarFile + '.part', '-C', tmpRoot, 'omniroute'], { windowsHide: true, stdio: 'ignore' });
      const tick = setInterval(() => o.onProgress?.({ phase: 'pack', elapsed: Date.now() - t0 }), 1000);
      c.on('exit', (cd) => { clearInterval(tick); res(cd); });
      c.on('error', () => { clearInterval(tick); res(-1); });
    });
    if (code === 0) {
      rmrf(tarFile);
      await renameRetry(tarFile + '.part', tarFile);
      tarOk = true;
      rmrf(path.join(o.dir, 'npm')); // s archivem cache npm netřeba (1,2 GB); bez něj zůstane jako záloha
      o.onLine?.(`[třída] archiv OmniRoute za ${Math.round((Date.now() - t0) / 1000)} s`);
    } else { rmrf(tarFile + '.part'); o.onLine?.(`[třída] archiv OmniRoute se nepovedl (tar kód ${code}), zůstává cache npm`); }
  } finally { rmrf(tmpRoot); }
  fs.writeFileSync(path.join(o.dir, 'manifest.json'), JSON.stringify({ czekai: 1, omniroute: OMNI_VERSION, opencode: OC_VERSION, node: NODE.version, git: GIT.version, omniTar: tarOk ? 'omniroute-app.tar' : null, created: new Date().toISOString() }, null, 2));
  return o.dir;
}

/** Archiv hotové instalace OmniRoute ve složce pro třídu (z --priprav-tridu), jinak null. */
function classTar() {
  const f = CLASS && path.join(CLASS, 'omniroute-app.tar');
  return f && fs.existsSync(f) ? f : null;
}

/** Rozbalí archiv hotové instalace OmniRoute (tar.exe) do o.dir; průběh jako u npm (místo na disku). */
async function extractOmniTar(tarFile, o) {
  const part = o.dir + '.part';
  rmrf(part);
  fs.mkdirSync(part, { recursive: true });
  const t0 = Date.now();
  const freeBytes = () => { try { const st = fs.statfsSync(part); return st.bavail * st.bsize; } catch { return null; } };
  const free0 = freeBytes();
  const prog = { phase: 'npm', elapsed: 0, meta: OMNI_META, metaTotal: OMNI_META, tgz: OMNI_PKGS, total: OMNI_PKGS, written: 0, size: OMNI_BYTES, scripts: [], scriptsDone: OMNI_SCRIPTS, scriptsTotal: OMNI_SCRIPTS };
  const code = await new Promise((res) => {
    const c = require('child_process').spawn(TAR(), ['-xf', tarFile, '-C', part], { windowsHide: true, stdio: 'ignore' });
    const tick = setInterval(() => {
      prog.elapsed = Date.now() - t0;
      const fr = freeBytes();
      if (fr != null && free0 != null) prog.written = Math.max(prog.written, free0 - fr);
      o.onProgress?.({ ...prog });
    }, 1000);
    const kill = () => { try { c.kill(); } catch {} };
    o.signal?.addEventListener('abort', kill);
    c.on('exit', (cd) => { clearInterval(tick); res(cd); });
    c.on('error', () => { clearInterval(tick); res(-1); });
  });
  const inner = path.join(part, 'omniroute');
  if (code !== 0 || !fs.existsSync(path.join(inner, 'node_modules', 'omniroute', 'bin', 'omniroute.mjs'))) { rmrf(part); throw new Error(`tar skončil kódem ${code}`); }
  rmrf(o.dir);
  await renameRetry(inner, o.dir);
  rmrf(part);
  o.onLine?.(`[třída] OmniRoute rozbalen z archivu ve složce pro třídu za ${Math.round((Date.now() - t0) / 1000)} s`);
  return path.join(o.dir, 'node_modules', 'omniroute');
}

module.exports = { renameRetry, classTar, cpSyncBroken, prepareClassCache, findClassCache, setClassCache, OC_INTEGRITY, installOpencode, installNode, installGit, installOmniroute, untarFile, supportsAvx2, binVersion, OC_VERSION, NODE, GIT, OMNI_VERSION, OMNI_META, OMNI_PKGS, OMNI_BYTES, OMNI_SCRIPTS };
