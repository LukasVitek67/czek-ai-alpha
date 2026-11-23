// Test úpravy rozhraní OpenCode: výběr složky jde přes window.__ZDARMA__, jinak beze změny.
'use strict';
const assert = require('assert');
const { patchBundle, isMainBundle } = require('../src/ocPatch');

// Tvar kódu z OpenCode 1.19.x (zkrácený): minifikované názvy obsahují i "$".
const src = 'function B2(){const e=rr();return r=>{if(C$e(e.platform,r.server)==="native"&&e.platform==="desktop"){e.openDirectoryPickerDialog({title:r.title,multiple:r.multiple}).then(r.onSelect);return}n.show(()=>f(_$e,se(r,{onSelect:s})),o)}}';
const { code, patched } = patchBundle(src);
assert.equal(patched, 1);

const run = (zdarma, platform) => {
  const calls = [];
  const window = zdarma ? { __ZDARMA__: { pickFolder: (o) => { calls.push(['zdarma', o]); return Promise.resolve('C:\\proj'); } } } : {};
  const ctx = { platform, openDirectoryPickerDialog: (o) => { calls.push(['native', o]); return Promise.resolve('N'); } };
  const fn = new Function('window', 'rr', 'C$e', 'n', 'f', '_$e', 'se', 's', 'o', `${code}; return B2();`);
  const open = fn(window, () => ctx, () => 'native', { show: () => calls.push(['server']) }, () => {}, null, () => {}, null, null);
  let selected;
  open({ title: 'T', multiple: true, server: {}, onSelect: (v) => { selected = v; } });
  return { calls, selected: () => selected };
};

let r = run(true, 'web');
assert.deepEqual(r.calls[0], ['zdarma', { title: 'T', multiple: true }], 'se Zdarmou jde výběr přes ni');
r = run(false, 'web');
assert.deepEqual(r.calls[0], ['server'], 'bez Zdarmy původní výběr OpenCode');
r = run(false, 'desktop');
assert.equal(r.calls[0][0], 'native', 'desktopové OpenCode beze změny');

assert.equal(patchBundle('nic tu není').patched, 0);
assert.ok(isMainBundle('http://127.0.0.1:4096/assets/index-pLP2E0sC.js'));
assert.ok(!isMainBundle('http://127.0.0.1:4096/assets/dialog-select-directory-v2-BHwQpi9O.js'));
console.log('ocpatch OK');
