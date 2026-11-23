// Řada visení přežije restart appky i vypadnutí řádků z 500 posledních volání OmniRoute (soubor zdarma-sync.json):
// chronicky visící model se nevrací po 24 h ani po restartu; návrat po uplynutí stupně stojí jedno visení, ne dvě.
// Živě 15. 11.: NVIDIA DeepSeek V4.1 Flash (103 visení, 0 odpovědí) byl po 26 h zase záloha a 2× visel po 45 s.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmniRoute } = require('../src/omniroute');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-hangmemo-'));
const H = 3600e3;
const KEY = 'nvidia/deepseek';
const mk = () => {
  const o = new OmniRoute({ dataDir: dir });
  o.nodeToProvider = new Map([['nvidia', 'nvidia'], ['zai', 'zai']]);
  o.baseLists = new Map([['zdarma-unlimited', [{ ref: 'nvidia/deepseek', provider: 'nvidia', id: 'deepseek' }, { ref: 'zai/glm', provider: 'zai', id: 'glm' }]]]);
  return o;
};
let seq = 0;
const row = (t, status, duration = 45000) => ({ id: 'r' + (seq++), timestamp: new Date(t).toISOString(), provider: 'nvidia', model: 'deepseek', status, duration, path: '/chat/completions' });
const dead = async (o, rows, now) => { o.api = async () => rows; await o.speedStats(now); return o.deadModels.has(KEY); };

(async () => {
  try {
    const t0 = Date.now();
    // 5× po sobě visel (poslední před hodinou) → venku; řada se zapíše na disk
    const hangs = [5, 4, 3, 2, 1].map((h) => row(t0 - h * H, 499));
    assert.strictEqual(await dead(mk(), hangs, t0), true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'zdarma-sync.json'), 'utf8'));
    assert.strictEqual(saved.hangs[KEY].n, 5, 'streak persisted');

    // restart appky o 30 h později, OmniRoute už ty řádky nevrací → pořád venku (5× = 3 dny)
    assert.strictEqual(await dead(mk(), [], t0 + 30 * H), true, 'still out after restart and after its rows left the window');
    // tytéž řádky znovu (ještě v okně API) se nezapočítají podruhé
    const again = mk();
    await dead(again, hangs, t0 + 2 * H);
    assert.strictEqual(again.hangMemo.get(KEY).n, 5, 'rows already counted in the memo are not counted twice');

    // po 4 dnech se zkusí znovu; JEDNO další visení ho hned zase vyřadí (6× = 7 dní)
    const t4 = t0 + 4 * 24 * H;
    assert.strictEqual(await dead(mk(), [], t4), false, 'probed again after its step ran out');
    assert.strictEqual(await dead(mk(), [row(t4 + 60e3, 499)], t4 + 120e3), true, 'a single new hang puts it out again');
    assert.strictEqual(await dead(mk(), [], t4 + 5 * 24 * H), true, '6 hangs = out for 7 days');

    // úspěch řadu smaže (i na disku)
    const healed = mk();
    assert.strictEqual(await dead(healed, [row(t4 + 3600e3, 200, 4000)], t4 + 2 * H), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'zdarma-sync.json'), 'utf8')).hangs[KEY], undefined, 'success clears the memo');
    console.log('omni-hang-memo OK');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
