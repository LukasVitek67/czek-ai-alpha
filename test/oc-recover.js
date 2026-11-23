'use strict';
// Matcher pro auto-zotavení okna OpenCode: pozná hlášku o pádu markdown workeru, nic jiného nechytá.
const assert = require('assert');
const { markdownWorkerFailed, shouldReloadOnGone } = require('../src/ocRecover');

// skutečné hlášky z bundlu OpenCode 1.19.5
assert.ok(markdownWorkerFailed('Markdown highlighting worker failed'), 'hláška onerror');
assert.ok(markdownWorkerFailed('Markdown highlighting worker failed [object Object]'), 'hláška s objektem za ní');
assert.ok(markdownWorkerFailed('Markdown worker response failed'), 'onmessageerror');
assert.ok(markdownWorkerFailed('... console.error: Markdown highlighting worker failed'), 's prefixem');

// nic jiného se nesmí splést za pád workeru (žádné zbytečné reloady)
for (const s of ['', null, undefined, 'highlighting ok', 'worker started', 'Markdown rendered', 'failed to fetch model', 'web worker spawned']) {
  assert.ok(!markdownWorkerFailed(s), 'nechytá: ' + JSON.stringify(s));
}

// pád rendereru: reload jen při skutečném pádu, ne při čistém konci / našem zabití
for (const r of ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']) assert.ok(shouldReloadOnGone(r), 'reload při: ' + r);
for (const r of ['clean-exit', 'killed', '', null, undefined, 'exited']) assert.ok(!shouldReloadOnGone(r), 'bez reloadu při: ' + JSON.stringify(r));

console.log('oc-recover OK (matcher workeru i pád rendereru: reload jen při skutečném pádu)');
