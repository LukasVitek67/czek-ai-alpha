#!/usr/bin/env node
'use strict';
// Dev verze czek-ai na plochu (uživatel 26. 11.: „dej mi na plochu dev verzi, která si sama bude stahovat updates
// z private repa“). Klon soukromého repa v %LOCALAPPDATA%\czek-ai-dev (stav origin/main na GitHubu), npm ci,
// značka .git/czek-dev-channel (src/devUpdate.js: appka si pak sama stahuje nové commity) a zástupce „czek-ai dev“
// na ploše (electron.exe z klonu). Profil je stejný jako u nainstalované czek-ai (klíče, nastavení, relace).
// Znovu spuštěný skript klon srovná s GitHubem (jen když je čistý) a zástupce obnoví.
//   node tools/dev-install.js [--dir=<složka>] [--no-shortcut]      (CZEK_DESKTOP_DIR = jiná „plocha“ pro testy)
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const devUpdate = require('../src/devUpdate');

const repo = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
// %USERPROFILE%\.czek-ai-dev, NE %LOCALAPPDATA%: proces z balíčku MSIX (Claude desktop) má zápisy do AppData
// přesměrované do vlastní LocalCache → zástupce na ploše by mířil na složku, kterou Průzkumník nevidí (26. 11.).
// Tečka na začátku = hledání souboru s klíči (keysync.findRepoFile) složku přeskočí.
const dir = path.resolve(arg('dir') || process.env.CZEK_DEV_DIR || path.join(require('os').homedir(), '.czek-ai-dev'));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = (...a) => console.log('[dev-install]', ...a);

const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).trim();
if (!fs.existsSync(path.join(dir, '.git'))) {
  // klon z místního repa (rychle, bez stahování historie), pak origin = GitHub a stav přesně podle GitHubu
  say('klon do', dir);
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', repo, dir], { env, stdio: 'inherit' });
  git('remote', 'set-url', 'origin', url);
  git('fetch', '--quiet', 'origin', 'main');
  git('reset', '--quiet', '--hard', 'origin/main');
  git('branch', '--quiet', '--set-upstream-to=origin/main', 'main');
} else {
  if (git('remote', 'get-url', 'origin') !== url) throw new Error(`${dir} je klon jiného repa`);
  git('fetch', '--quiet', 'origin', 'main');
  try { git('merge', '--ff-only', '--quiet', 'origin/main'); } catch (e) { say('klon nejde srovnat s GitHubem (vlastní změny?) – nechávám, jak je:', e.message.split('\n')[0]); }
}
fs.writeFileSync(path.join(dir, '.git', devUpdate.MARK), 'czek-ai dev: sama se aktualizuje z origin/main (src/devUpdate.js)\n');
say('verze', git('log', '-1', '--format=%h %s'));

const exe = process.platform === 'win32' ? path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(dir, 'node_modules', '.bin', 'electron');
if (!fs.existsSync(exe)) {
  say('npm ci (electron z cache, ~1–2 min)…');
  // electron 43 nemá postinstall: binárku stáhne až install.js (jinak při prvním require('electron')) → zavolat ho
  const ci = () => spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0
    && (fs.existsSync(exe) || spawnSync(process.execPath, [path.join(dir, 'node_modules', 'electron', 'install.js')], { cwd: dir, stdio: 'inherit' }).status === 0)
    && fs.existsSync(exe);
  if (!ci()) { say('npm ci / stažení electronu selhalo, zkouším znovu…'); if (!ci()) throw new Error('npm ci selhal'); }
  try { git('checkout', '--', 'package-lock.json'); } catch {}
}

if (!process.argv.includes('--no-shortcut') && process.platform === 'win32') {
  // ikona: build/icon.png (256×256) zabalená do .ico (PNG uvnitř ICO umí Windows od Visty)
  const png = fs.readFileSync(path.join(dir, 'build', 'icon.png'));
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICO, 1 obrázek
  head.writeUInt8(0, 6); head.writeUInt8(0, 7); // 0 = 256 px
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  const ico = path.join(dir, '.git', 'czek-dev.ico');
  fs.writeFileSync(ico, Buffer.concat([head, png]));
  const desk = process.env.CZEK_DESKTOP_DIR || '';
  const ps = `$d = if ($env:CZ_DESK) { $env:CZ_DESK } else { [Environment]::GetFolderPath('Desktop') }
$p = Join-Path $d 'czek-ai dev.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p)
$s.TargetPath = $env:CZ_EXE
$s.Arguments = '"' + $env:CZ_DIR + '"'
$s.WorkingDirectory = $env:CZ_DIR
$s.IconLocation = $env:CZ_ICON + ',0'
$s.Description = 'czek-ai dev - verze ze soukromeho repa, sama se aktualizuje'
$s.Save()
Write-Output $p`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...env, CZ_EXE: exe, CZ_DIR: dir, CZ_ICON: ico, CZ_DESK: desk }, encoding: 'utf8' }).trim();
  say('zástupce', out);
}
say('hotovo – spouštět zástupcem „czek-ai dev“ (nainstalovaná czek-ai musí být zavřená, profil je společný)');
