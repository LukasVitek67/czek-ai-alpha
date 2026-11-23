// Domovská složka jako git repozitář: Zdarma vypne snímky OpenCode (snapshot:false) a umí to vrátit.
// Vlastní nastavení uživatele (snapshot true/false bez značky) nechá být.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-snap-'));
process.env.OPENCODE_CONFIG_DIR = path.join(tmp, 'cfg');
const oc = require('../src/opencode');
const read = () => JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));

// homeInGit: .git v nadřazené složce se najde, bez něj null
const home = path.join(tmp, 'a', 'home');
fs.mkdirSync(home, { recursive: true });
// (dočasná složka sama může ležet v repozitáři – na tomhle PC je git celý C:\Users\student)
assert.strictEqual(oc.homeInGit(home), oc.homeInGit(tmp));
fs.mkdirSync(path.join(tmp, 'a', '.git'));
assert.strictEqual(oc.homeInGit(home), path.join(tmp, 'a'));

oc.writeConfig(4545, [], { tiers: [], snapshotOff: true });
assert.strictEqual(read().snapshot, false);
assert.ok(fs.existsSync(oc.SNAP_MARK()));
oc.writeConfig(4545, [], { tiers: [], snapshotOff: false });
assert.strictEqual('snapshot' in read(), false);
assert.ok(!fs.existsSync(oc.SNAP_MARK()));

// uživatel si to nastavil sám → nesahat
const c = read(); c.snapshot = true; fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify(c));
oc.writeConfig(4545, [], { tiers: [], snapshotOff: true });
assert.strictEqual(read().snapshot, true);
const d = read(); d.snapshot = false; fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify(d));
oc.writeConfig(4545, [], { tiers: [], snapshotOff: false });
assert.strictEqual(read().snapshot, false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('oc-snapshot OK');
