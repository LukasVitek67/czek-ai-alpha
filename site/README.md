# czek-ai veřejný tierlist (web + API na Vercelu, data v Supabase)

- `index.html` – veřejná stránka (tabulka modelů z `/api/tierlist`).
- `api/report.js` – POST anonymního souhrnu z czek-ai (`src/publicTier.js`); IP a id instalace jen jako sha256 se solí.
- `api/tierlist.js` – GET veřejného souhrnu za 72 h (cache 5 min).
- `dev-server.js` – lokální náhled: `node site/dev-server.js 4870` (proměnné ze `site/.env.local`, není v gitu).

Supabase projekt `czek-ai-tierlist` (eu-central-1, zdarma; přístupové údaje má jen správce): tabulka `public.reports`
(RLS bez politik = anon nic), funkce `submit_report` (zápis jen s heslem, v `private.config` je jen jeho sha256 pod k='api_secret_sha256'; limity
20 hlášení/h z IP, 4/h z instalace, počty 0..500), `tierlist(p_hours)` (veřejné čtení; každá instalace max 200 volání
na model), `prune_reports()` (smaže starší 30 dní).

Proměnné prostředí na Vercelu: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (veřejný publishable klíč), `TIER_API_SECRET`
(heslo; v databázi jen sha256), `TIER_HASH_SALT` (libovolný tajný řetězec). Výměna hesla: nové heslo jen do souboru
(nikdy nevypisovat), jeho sha256 do `private.config` k='api_secret_sha256', heslo do proměnné na Vercelu, redeploy.
