// Typy argumentů nástrojů podle schématu (v chatu uživatele 10× SchemaError: "offset":"0", "timeout":"10000").
'use strict';
const assert = require('assert');
const { coerceArgs } = require('../src/proxy');

const read = { type: 'object', properties: { filePath: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'integer' } } };
const bash = { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, background: { type: 'boolean' } } };
const todo = { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { priority: { type: 'number' } } } } } };

const j = (r) => JSON.parse(r.args);
assert.deepStrictEqual(j(coerceArgs('{"filePath":"a.ts","offset":"0","limit":"1000"}', read)), { filePath: 'a.ts', offset: 0, limit: 1000 });
assert.deepStrictEqual(j(coerceArgs('{"command":"ls","timeout":"10000","background":"false"}', bash)), { command: 'ls', timeout: 10000, background: false });
assert.deepStrictEqual(j(coerceArgs('{"todos":"[{\\"priority\\":\\"2\\"}]"}', todo)), { todos: [{ priority: 2 }] });
assert.strictEqual(coerceArgs('{"filePath":"123"}', read).fixed, false, 'text zůstane textem, když ho schéma chce');
assert.strictEqual(coerceArgs('{"offset":"abc"}', read).fixed, false, 'nečíselný text se nemění');
assert.strictEqual(coerceArgs('{rozbité', read).args, '{rozbité', 'neplatný JSON se nechá být');
assert.strictEqual(coerceArgs('{"offset":"5"}', null).fixed, false, 'bez schématu beze změny');
console.log('coerce OK');
