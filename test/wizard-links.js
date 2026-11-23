// Průvodce klíči: odkazy „Otevřít stránku“ (keyUrl) u všech kroků se dají otevřít (HTTP < 400 po přesměrování).
// 401/403 = přihlašovací zeď (Mistral), stránka existuje. Rozbitý odkaz (404, 5xx, síť) = student se zasekne. Síť: ZDARMA_SKIP_NET=1 přeskočí. ~5 s.
'use strict';
const W = require('../src/wizard');
const { PROVIDERS } = require('../src/providers');

if (process.env.ZDARMA_SKIP_NET) { console.log('wizard-links přeskočeno (ZDARMA_SKIP_NET)'); process.exit(0); }
(async () => {
  const res = await Promise.all(W.STEPS.map(async (s) => {
    const url = PROVIDERS.find((p) => p.id === s.id).keyUrl;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000) });
        return { id: s.id, url, status: r.status, ok: r.status < 400 || r.status === 401 || r.status === 403 };
      } catch (e) { if (i) return { id: s.id, url, status: e.cause?.code || e.name, ok: false }; }
    }
  }));
  for (const r of res) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.status} ${r.url}`);
  const bad = res.filter((r) => !r.ok);
  if (bad.length) { console.error(`wizard-links FAILED: ${bad.map((r) => r.id).join(', ')}`); process.exit(1); }
  console.log(`wizard-links OK (${res.length} odkazů)`);
})();
