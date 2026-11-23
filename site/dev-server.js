// Lokální náhled webu i API (bez Vercelu): node site/dev-server.js [port]. Proměnné z site/.env.local (není v gitu).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const port = Number(process.argv[2]) || 4870;
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const api = /^\/api\/([a-z]+)$/.exec(u.pathname);
  if (api && fs.existsSync(path.join(__dirname, 'api', api[1] + '.js'))) {
    let raw = '';
    for await (const c of req) raw += c;
    req.body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    return require(path.join(__dirname, 'api', api[1] + '.js'))(req, res);
  }
  if (u.pathname === '/' || u.pathname === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
  res.statusCode = 404; res.end('404');
}).listen(port, '127.0.0.1', () => console.log(`tierlist náhled: http://127.0.0.1:${port}`));
