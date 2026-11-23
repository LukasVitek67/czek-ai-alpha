// Jádro spouštění na pozadí (src/guard/launch.mjs): které příkazy jsou dlouho běžící (appka, dev server) a co z nich guard
// udělá. Příkazy jsou skutečné z relace uživatele 15.–17. 11. (musicbee clone).
import assert from 'node:assert';
import { isLongRunning, backgroundize, releaseLocks } from '../src/guard/launch.mjs';

const LONG = [
  'cd "/c/Users/student/Documents/Claude code/musicbee clone" && npm run dev &',
  'cd "/c/Users/student/Documents/Claude code/musicbee clone" && npm run dev > dev.log 2>&1 &',
  'cd "/c/Users/student/Documents/Claude code/musicbee clone" && cargo run --release',
  "cd /c/Users/student/Documents/Claude\\ code/musicbee\\ clone && cargo run --release -- 'C:\\Users\\student\\Music'",
  'cd /c/Users/student/Documents/Claude\\ code/musicbee\\ clone && cargo run 2>&1 &\nsleep 3\nps aux | grep music',
  'cd "/c/Users/student/Desktop" && ./musicbee_clone.exe',
  'cd /c/Users/student/Desktop && ./FurryBee.exe 2>&1 &\nsleep 3\ntasklist | findstr FurryBee',
  "cd /c/Users/student/Desktop && powershell -Command \"& .\\FurryBee.exe 'C:\\Users\\student\\Music\\hudba' 2>&1\"",
  'timeout 60 cargo run --release',
  'npx tauri dev',
  'npm run tauri dev',
  'npm start',
  'npx vite',
  'python -m http.server 8000',
  '"C:/Users/x/Documents/app/target/release/app.exe"',
];
const SHORT = [
  'cd "/c/Users/student/Documents/Claude code/musicbee clone" && cargo build --release',
  'cargo check --message-format=short 2>&1 | head -200',
  'npm run build',
  'npx tauri build --ci',
  'npm install',
  './target/release/app.exe --version',
  'C:/Program Files/Git/bin/bash.exe -c "echo hi"',
  'cp target/release/app.exe /c/Users/student/Desktop/',
  'tail -n 50 dev.log',
  'node app.js',
  'ls -la',
];
// Živě 20. 11. večer (FurryBee, 0.15.23), doslova z guard.jsonl: kopírování a výpis .exe šly „na pozadí“ (5×),
// spuštění s kontrolou `ps aux | grep` naopak viselo do limitu 120 s (4×)
LONG.push(
  '"C:/Users/student/Desktop/FurryBee.exe" 2>&1 &\nsleep 3\nps aux | grep -i furrybee',
  'cd "C:/Users/student/Desktop" && ./FurryBee.exe 2>&1 &\nsleep 3\nps aux | grep -i furrybee',
  'cd /c/Users/student/Desktop && ./FurryBee.exe &\nsleep 3\nps aux | grep -i furrybee',
  'cd /c/Users/student/Desktop && ./FurryBee.exe > furrybee.log 2>&1 &\nsleep 8\ncat furrybee.log',
  '"C:/Users/student/Desktop/FurryBee.exe" 2>&1 &\nsleep 3\njobs',
  'cd "C:\\Users\\student\\Documents\\Claude code\\musicbee clone" && ./target/release/musicbee-clone.exe',
  'start "" "C:/Users/student/Desktop/FurryBee.exe"',
  'cmd //c start FurryBee.exe',
  'powershell -Command "Start-Process -FilePath .\\FurryBee.exe"',
);
SHORT.push(
  'cp target/release/musicbee_clone.exe "C:\\Users\\student\\Desktop\\FurryBee.exe"',
  'ls -la "C:/Users/student/Desktop/FurryBee.exe"',
  'cp "C:/Users/student/Documents/Claude code/musicbee clone/target/release/musicbee_clone.exe" "C:/Users/student/Desktop/FurryBee.exe"\nls -la "C:/Users/student/Desktop/FurryBee.exe"',
  'tasklist | grep -i furrybee',
  'taskkill //F //IM FurryBee.exe',
  'where FurryBee.exe',
  'rm -f target/release/FurryBee.exe',
  'file "C:/Users/student/Desktop/FurryBee.exe"',
  'ps aux | grep -i "FurryBee.exe"',
);
for (const c of LONG) assert.ok(isLongRunning(c), 'má být na pozadí: ' + c);
for (const c of SHORT) assert.ok(!isLongRunning(c), 'nemá být na pozadí: ' + c);
// appka na pozadí jen do svého spuštění: modelova kontrola `& sleep 3; ps aux | grep` / `jobs` / `cat log` pryč
// (podshell by po ní skončil a appku by pak guard před dalším buildem nemohl ukončit)
const body = (cmd) => /\( ([\s\S]*?)\n\) > '/.exec(backgroundize(cmd, { session: 'ses_body' }).command)[1];
assert.strictEqual(body('"C:/Users/student/Desktop/FurryBee.exe" 2>&1 &\nsleep 3\nps aux | grep -i furrybee'), '"C:/Users/student/Desktop/FurryBee.exe" 2>&1');
assert.strictEqual(body('cd "C:/Users/student/Desktop" && ./FurryBee.exe 2>&1 &\nsleep 3\nps aux | grep -i furrybee'), 'cd "C:/Users/student/Desktop" && ./FurryBee.exe 2>&1');
assert.strictEqual(body('( "C:/x/FurryBee.exe" & sleep 3; tasklist | findstr Furry )'), '"C:/x/FurryBee.exe"');
assert.strictEqual(body('cd /c/Users/student/Desktop && ./FurryBee.exe > furrybee.log 2>&1 &\nsleep 8\ncat furrybee.log'), 'cd /c/Users/student/Desktop && ./FurryBee.exe > furrybee.log 2>&1');
assert.ok(/czek_i -lt 6 ]/.test(backgroundize(LONG.at(-9), { session: 'ses_body' }).command), 'appka: čeká 6 s');

const r = backgroundize(LONG[1], { session: 'ses_test', cwd: 'C:/p' });
assert.ok(r && r.log.endsWith('.log'));
assert.ok(/\( cd "\/c\/Users\/student\/Documents\/Claude code\/musicbee clone" && npm run dev > dev\.log 2>&1\n\) > '.+\.log' 2>&1 < \/dev\/null &/.test(r.command), 'celý příkaz v závorce na pozadí, koncový & pryč: ' + r.command);
assert.ok(/winpid/.test(r.command) && /tail -n 60/.test(r.command), 'uloží PID a vrátí konec logu');
assert.ok(/czek_i -lt 15/.test(r.command) && /ready|listening/.test(r.command), 'dev server: čeká max 15 s, skončí dřív při adrese');
const rc = backgroundize(LONG[2], { session: 'ses_test' });
assert.ok(/czek_i -lt 25/.test(rc.command) && /Running `/.test(rc.command), 'cargo run: skončí hned na „Running `" (binárka běží), strop 25 s pro studený překlad – neblokuje a nehrozí 120s kill');
assert.strictEqual(backgroundize(r.command, { session: 'ses_test' }), null, 'už přepsaný příkaz se nepřepisuje znovu');
assert.strictEqual(backgroundize('cargo build --release', { session: 'ses_test' }), null);
// bez spuštěných appek se build nemění
assert.strictEqual(releaseLocks('cargo build --release', { session: 'ses_nic' }), null);
console.log(`guard-launch OK (${LONG.length} dlouho běžících, ${SHORT.length} krátkých příkazů rozpoznáno správně)`);
