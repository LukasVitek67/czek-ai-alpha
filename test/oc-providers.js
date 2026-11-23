// OpenCode „Připojit poskytovatele“: s ocProviders (výchozí ve Zdarmě) se nepíše enabled_providers ["zdarma"],
// takže dialog se seznamem webů (Z.AI…) zůstane vidět; tierlisty Zdarmy jsou dál bez jednotlivých modelů.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-ocprov-'));
delete process.env.OPENCODE_CONFIG_DIR;
const oc = require('../src/opencode');
const tiers = require('../src/tiers');
const models = [{ key: 'kilo/stealth/glyph-cluster', id: 'stealth/glyph-cluster', provider: 'kilo', usable: true, tools: true, context: 256000 }];
const ov = tiers.overview(models, { tiers: {} }, { autoOrder: (m) => m, isUncensored: () => false });
const read = (r) => JSON.parse(fs.readFileSync(r.file, 'utf8'));
let c = read(oc.writeConfig(4999, models, { tiers: ov, onlyTiers: true, ocProviders: false }));
assert.deepStrictEqual(c.enabled_providers, ['zdarma'], 'bez ocProviders jen Zdarma');
c = read(oc.writeConfig(4999, models, { tiers: ov, onlyTiers: true, ocProviders: true }));
assert.strictEqual(c.enabled_providers, undefined, 'ocProviders: omezení zmizí');
assert.ok(Object.keys(c.provider.zdarma.models).every((k) => !k.includes('/')), 'Zdarma dál jen tierlisty');
const u = read(oc.writeConfig(4999, models, { tiers: ov, onlyTiers: true, ocProviders: true }));
u.enabled_providers = ['zdarma', 'zai']; fs.writeFileSync(oc.writeConfig(4999, models, { tiers: ov, onlyTiers: true, ocProviders: true }).file, JSON.stringify(u));
c = read(oc.writeConfig(4999, models, { tiers: ov, onlyTiers: true, ocProviders: true }));
assert.deepStrictEqual(c.enabled_providers, ['zdarma', 'zai'], 'vlastní enabled_providers uživatele se nemaže');
console.log('oc-providers OK');
