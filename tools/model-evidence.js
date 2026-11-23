#!/usr/bin/env node
'use strict';
// Ověřené modely z měření (src/evidence.js): sloučí výsledky benchmarků do src/model-evidence.json.
//   node tools/model-evidence.js ingest [složka…]   – výchozí: všechny docs/research/**/results + seeds
//   node tools/model-evidence.js show               – které modely jsou teď ověřené a v jakém pořadí
const fs = require('fs');
const path = require('path');
const E = require('../src/evidence');

const repo = path.join(__dirname, '..');
const FILE = path.join(repo, 'src', 'model-evidence.json');
const SEEDS = path.join(repo, 'docs', 'research', 'model-evidence-seeds.json');

function resultDirs() {
  const base = path.join(repo, 'docs', 'research');
  const out = [];
  const walk = (d, depth) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (!f.isDirectory()) continue;
      const p = path.join(d, f.name);
      if (f.name === 'results' || path.basename(d) === 'model-evidence-runs') out.push(p); else if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

function ingest(dirs) {
  const old = E.load(FILE);
  const records = [];
  for (const [key, runs] of Object.entries(old)) for (const r of runs) records.push({ key, ...r });
  try { records.push(...JSON.parse(fs.readFileSync(SEEDS, 'utf8')).records); } catch {}
  let files = 0;
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
      let r; try { r = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      const rel = path.relative(repo, path.join(d, f));
      const got = E.recordsFrom(r, rel);
      if (got.length) files++;
      records.push(...got);
    }
  }
  const models = E.summarize(records);
  fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), maxAgeDays: E.MAX_AGE_DAYS, minRate: E.MIN_RATE, models }, null, 1) + '\n');
  console.log(`model-evidence: ${files} souborů s výsledky, ${Object.keys(models).length} modelů → ${path.relative(repo, FILE)}`);
}

function show() {
  const p = E.proven(E.load(FILE));
  const rows = Object.values(p);
  if (!rows.length) return console.log('Žádný ověřený model (měření starší než ' + E.MAX_AGE_DAYS + ' dní vypršela).');
  for (const r of rows) console.log(`${String(r.rank + 1).padStart(2)}. ${r.key.padEnd(34)} úlohy ${r.fixtures}, úspěch ${r.ok}/${r.runs}, medián ${r.medianS ?? '?'} s, naposledy ${r.lastOk.slice(0, 10)}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'ingest') ingest(args.length ? args.map((a) => path.resolve(a)) : resultDirs());
else if (cmd === 'show') show();
else { console.error('použití: node tools/model-evidence.js ingest [složka…] | show'); process.exit(2); }
