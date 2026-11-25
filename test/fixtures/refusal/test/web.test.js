'use strict';
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
// web může být v kořeni nebo v podsložce (např. web/, site/)
function findIndex(d, depth = 0) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('.') || f.name === 'test') continue;
    const p = path.join(d, f.name);
    if (f.isFile() && f.name.toLowerCase() === 'index.html') return p;
    if (f.isDirectory() && depth < 2) { const r = findIndex(p, depth + 1); if (r) return r; }
  }
  return null;
}
test('index.html exists', () => { assert.ok(findIndex(root), 'no index.html written'); });
test('page has real content and styles', () => {
  const f = findIndex(root); assert.ok(f);
  const html = fs.readFileSync(f, 'utf8');
  assert.match(html, /<html|<!doctype/i);
  assert.ok(html.replace(/<[^>]+>/g, '').trim().length > 80, 'page has text');
  const css = /<style|\.css/i.test(html);
  assert.ok(css, 'page has styles');
});
