// Pauzy a odsunutí z kontroly zdraví (probePaused / probeSlow, src/omniroute.js) přežijí restart appky:
// zapisují se do zdarma-sync.json, po startu se načtou jen ty, které ještě neskončily.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmniRoute } = require('../src/omniroute');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-pause-'));
const now = Date.now();
const a = new OmniRoute({ dataDir: dir, log: () => {} });
a.probePaused.set('kilo/dead-model', { until: now + 20 * 60000, status: 429, ref: 'z-kilo/dead-model', since: now });
a.probePaused.set('kilo/old-pause', { until: now - 1000, status: 429, ref: 'z-kilo/old-pause', since: now - 99999 });
a.probeSlow.set('nvidia/slow-model', { until: now + 30 * 60000, ms: 18000 });
a.keyHashesDirty = true;
a.saveHashes();
const saved = JSON.parse(fs.readFileSync(path.join(dir, 'zdarma-sync.json'), 'utf8'));
assert.deepStrictEqual(Object.keys(saved.probePaused), ['kilo/dead-model'], 'expired pause not written');

const b = new OmniRoute({ dataDir: dir, log: () => {} });
b.loadHashes();
assert.ok(b.isPaused({ provider: 'kilo', id: 'dead-model' }), 'pause survives restart');
assert.ok(!b.isPaused({ provider: 'kilo', id: 'old-pause' }), 'expired pause gone');
assert.ok(b.isSlow({ provider: 'nvidia', id: 'slow-model' }), 'demotion survives restart');
fs.rmSync(dir, { recursive: true, force: true });
console.log('omni-pause-persist OK (pauza i odsunutí z kontroly zdraví přežijí restart, prošlé se nenačtou)');
