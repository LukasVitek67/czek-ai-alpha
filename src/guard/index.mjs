// czek-guard: plugin OpenCode proti smyčkám a drobení editů (logika v guard-core.mjs).
// Pozor: OpenCode zavolá KAŽDÝ export souboru pluginu jako plugin → tady smí být jen jeden export.
import path from 'node:path';
import fs from 'node:fs';
import { Guard, SHELL_ENV } from './guard-core.mjs';
import { autoCheck } from './autocheck.mjs';
import { searchTools, loadPluginApi, findRg } from './search.mjs';
import { lookTool } from './look.mjs';
import { backgroundize, releaseLocks, pruneLogs, findLaunch } from './launch.mjs';

// Úplný log czek-ai: každé rozhodnutí guardu (blok, přepis příkazu, poznámka modelu, kontrola po editu,
// zastavení opakování, zkrácení kontextu) jako JSON řádek do souboru z CZEK_GUARD_LOG (nastaví czek-ai).
const glog = (kind, msg, data) => {
  const f = process.env.CZEK_GUARD_LOG;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), kind, msg, ...data }) + '\n'); } catch {}
};

const guards = new Map(); // sessionID → Guard
const guardOf = (id, opts) => {
  let g = guards.get(id);
  if (!g) { g = new Guard(opts); guards.set(id, g); if (guards.size > 50) guards.delete(guards.keys().next().value); }
  return g;
};

/** @type {import('@opencode-ai/plugin').Plugin} */
export const CzekGuard = async (ctx, options) => {
  const opts = options && typeof options === 'object' ? options : {};
  const pending = new Map(); // callID → args (after hook je dostává taky, ale ne ve všech verzích)
  const launched = new Map(); // callID → { log, note } příkazů přepsaných na spuštění na pozadí
  const lastApp = new Map(); // sessionID → název procesu appky spuštěné naposledy (výchozí cíl nástroje look)
  const appName = (exe) => String(exe || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '');
  // build / instalace závislostí: výchozí limit nástroje bash je 120 s. Release build Tauri trval 100–300 s → OpenCode
  // ho zabil a agent ho pustil znovu (15.–17. 11.: 4× zbytečně). 10 minut = strop nástroje.
  const BUILD = /\b(?:cargo\s+(?:build|test|install|tauri\s+build)|tauri\s+build|npm\s+(?:run\s+(?:build|tauri\s+build)|install|ci|i)\b|pnpm\s+(?:build|install)|yarn\s+(?:build|install)|dotnet\s+(?:build|publish)|gradlew?\s+\w|mvn\s|go\s+build|pip\s+install)/;
  const BUILD_TIMEOUT = 600000;
  pruneLogs();
  const failedSeen = new Set(); // callID chyb, které už guard započítal (událost přijde i vícekrát)
  // Nekonečné opakování: OpenCode 1.19.5 zkouší „opakovatelnou“ chybu (429/5xx) bez horní hranice.
  // Živě 13. 11.: Z.ai GLM Flash vracel 529 „[1305] The service may be temporarily overloaded“ a relace
  // visela v „retrying … attempt #N“, seznam úkolů se pořád ukazoval (OpenCode ho kreslí, dokud relace
  // není idle). Přes OmniRoute už byly zkoušené všechny modely combo, další opakování nepomůže.
  const maxRetries = Number(opts.maxRetries ?? 3);
  const aborted = new Set();
  // Přetečení kontextu, které OpenCode nepozná: zkracování spustí jen u chyb ze svého seznamu frází
  // („prompt is too long“, „maximum context length“…), hlášku Z.ai „Prompt exceeds max length“ tam nemá
  // (ověřeno v binárce 1.19.5). Živě 13. 11.: kontext dorostl na 98,7k, OpenCode zkracuje až od
  // 131072 − 32000 = 99 072 (kontroluje součet z MINULÉHO kroku), další dotaz i s rezervou na odpověď
  // (max_tokens 32000) přetekl → chyba a konec. Guard počká, až relace stojí, a zavolá zkrácení s auto:true
  // (OpenCode po něm sám pokračuje, stejně jako u přetečení, které pozná). Nejvýš 2× za 10 min na relaci.
  const OVERFLOW = /prompt exceeds max(imum)? length|exceeds (the )?max(imum)? (input |prompt |context )?length|too many (input )?tokens|context (length|window|size) (exceeded|is exceeded)|input (is )?too long|prompt (is )?too long/i;
  const toCompact = new Map(); // sessionID → { providerID, modelID }
  const compacted = new Map(); // sessionID → [časy]
  // Výstupní limit (finish „length“, např. 8192 tokenů spotřebovaných na uvažování, bez nástroje): OpenCode 1.19.5
  // pak relaci ukončí a uživatel musí napsat „pokračuj“. Guard to udělá sám: po idle relace pošle pokračování
  // se stejným modelem a agentem. Nejvýš 2× za 10 min na relaci (smyčka by jinak nikdy neskončila).
  const lastAsst = new Map(); // sessionID → { finish, providerID, modelID, agent } poslední dokončená odpověď asistenta
  const continued = new Map(); // sessionID → [časy automatických pokračování]
  const CONTINUE_TEXT = 'Your previous reply was cut off at the output token limit. Continue exactly where you stopped. Keep reasoning brief; write large files in several smaller write/edit calls.';
  // Volání nástroje napsané jako TEXT (nebo v uvažování) místo skutečného volání: odpověď skončí „stop“ bez
  // nástroje a OpenCode úkol ukončí. Změřeno 15. 11. (oprava chyb v projektu, tier Unlimited): po přepnutí modelu
  // uprostřed úkolu (Nemotron → GLM 4.5 Flash) napsal GLM do uvažování „<tool_call>proxy_read <arg_key>filePath…“
  // a agent skončil po 4 krocích s neopravenými testy. Guard to pozná a pošle výzvu zavolat nástroj správně.
  const TOOL_AS_TEXT = /<tool_call>|<\/tool_call>|<arg_key>|<arg_value>|<function=|<invoke\s+name=|<\|tool_call|\bproxy_(?:read|edit|write|bash|glob|grep|task|webfetch|skill)\b|"tool_calls"\s*:\s*\[/;
  const TOOLTEXT_TEXT = 'Your previous reply wrote a tool call as plain text (for example <tool_call>...), so nothing was executed and the task is not finished. Make the same call again through the real function-calling interface. Never write tool calls inside your text or reasoning.';
  const partsOf = new Map(); // sessionID → { messageID, texts: Map(id dílu → text), tool: bylo volání nástroje }
  // Agent skončí („stop“, bez nástroje), ale poslední kontrola po editu hlásila chyby = projekt nejde přeložit.
  // Živě 20. 11. (FurryBee): po 83 editech napsal „Currently stuck fixing 3 … errors. Next: fix these errors …“ a relace
  // stála do rána. Guard pošle pokračování (ne když se model ptá uživatele), nejvýš 3× za hodinu na relaci.
  const broken = new Map(); // sessionID → počet chyb z poslední kontroly po editu
  const brokenSent = new Map(); // sessionID → [časy]
  // Závod modelů (src/race.js): vítěz začal odpovídat a pak 90 s nic → proxy krok ukončí chybou „stream_stalled“.
  // OpenCode takovou chybu nezopakuje (ověřeno test/oc-race.js) a relace by stála; guard pošle pokračování.
  const STALLED_TEXT = 'The model stopped responding in the middle of your previous step, so that step was cancelled. Continue the task from where it stopped (repeat the last tool call if it did not run).';
  const BROKEN_TEXT = (n) => `The project still does not compile: the last check after your edit reported ${n} error${n > 1 ? 's' : ''}, so the task is not finished. Continue fixing ${n > 1 ? 'them' : 'it'} now, using the full compiler message from that check (read its note/help lines). If you truly cannot go on without the user, ask one concrete question instead of stopping.`;
  const autoContinue = (id, la, why = 'length') => {
    if (!la.providerID || !la.modelID) return;
    const now = Date.now();
    const recent = (continued.get(id) || []).filter((t) => now - t < 600000);
    const model = { providerID: la.providerID, modelID: la.modelID };
    if (recent.length >= 2) { glog('continue-skip', `automatické pokračování relace ${id} přeskočeno: už 2× za 10 min`, { session: id, ...model, count: recent.length }); return; }
    if (why === 'broken') {
      const hour = (brokenSent.get(id) || []).filter((t) => now - t < 3600000);
      if (hour.length >= 3) { glog('continue-skip', `pokračování relace ${id} s chybami překladu přeskočeno: už 3× za hodinu`, { session: id, ...model, count: hour.length }); return; }
      brokenSent.set(id, [...hour, now]);
    }
    continued.set(id, [...recent, now]);
    const errs = broken.get(id) || 0;
    glog('continue', why === 'tooltext' ? `odpověď relace ${id} obsahovala volání nástroje jako text → posílám výzvu zavolat ho správně (${recent.length + 1}. za 10 min)`
      : why === 'stalled' ? `model v relaci ${id} zmlkl uprostřed odpovědi (závod modelů krok ukončil) → posílám pokračování (${recent.length + 1}. za 10 min)`
      : why === 'broken' ? `relace ${id} skončila, ale projekt nejde přeložit (${errs} chyb po posledním editu) → posílám pokračování (${recent.length + 1}. za 10 min)`
        : `odpověď relace ${id} skončila limitem výstupu → posílám pokračování (${recent.length + 1}. za 10 min)`, { session: id, ...model, agent: la.agent, count: recent.length + 1, why, ...(why === 'broken' ? { errors: errs } : {}) });
    const text = why === 'tooltext' ? TOOLTEXT_TEXT : why === 'broken' ? BROKEN_TEXT(errs) : why === 'stalled' ? STALLED_TEXT : CONTINUE_TEXT;
    // až po doběhnutí obsluhy události; promptAsync jen odešle zprávu a hned vrátí (neblokuje hook)
    setTimeout(() => { ctx?.client?.session?.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }], model, ...(la.agent ? { agent: la.agent } : {}) } }).catch((e) => glog('continue-error', `pokračování relace ${id} selhalo: ${e?.message || e}`, { session: id })); }, 300);
  };
  glog('start', `plugin načten pro ${ctx?.directory || '?'}`, { options: opts });
  // Uvažování modelu přes OmniRoute. Samotné OpenCode posílá u GLM přímo na Z.ai `thinking: {type: "enabled",
  // clear_thinking: false}` (+ teplota 1), u dalších rodin podobné volby, ale jen podle ID poskytovatele/modelu.
  // Přes OmniRoute je model `auto/coding` / combo, takže OpenCode nepošle nic a OmniRoute uvažování nezapne
  // (Z.ai jde formátem Claude: thinking jen z `thinking` / `reasoning_effort` v požadavku, jinak bez něj a
  // s vyhozeným reasoning_content z historie; openai-to-claude.ts v omniroute 3.8.53). `reasoning_effort` je
  // univerzální volba, kterou OmniRoute převádí pro každého poskytovatele zvlášť a u nepodporujících modelů maže.
  // Volba pluginu reasoningEffort: 'medium' (výchozí), 'low' / 'high', 'off' = neposílat.
  const effort = opts.reasoningEffort ?? 'medium';
  // glob/grep přes rg bez node_modules (search.mjs); search:false vypne
  const tools = opts.search === false ? {} : await searchTools(ctx).catch(() => ({}));
  // Tichá degradace: když se glob/grep nenasadí (chybí rg nebo plugin), OpenCode použije vestavěné bez
  // časového stropu a bez vyloučení node_modules/target → hledání může viset stovky sekund (sebe-audit 23. 11.:
  // rg byl v ~/.cache, hledalo se jen v ~/.local/share → 160–225 s). Ať je to příště hned v logu, ne tiše.
  if (opts.search !== false && !Object.keys(tools).length) {
    glog('search-fallback', findRg()
      ? 'guard glob/grep se nenasadil: plugin @opencode-ai/plugin nenačten → OpenCode použije vestavěné hledání (bez stropu, bez vyloučení node_modules/target)'
      : 'guard glob/grep se nenasadil: ripgrep nenalezen (PATH ani opencode/bin v ~/.local/share či ~/.cache) → OpenCode použije vestavěné hledání (bez stropu, bez vyloučení node_modules/target)',
    { rg: findRg() || null });
  }
  // look: snímek okna appky + popis od modelu s viděním (look.mjs); look:false vypne
  if (opts.look !== false && process.platform === 'win32') {
    const plug = await loadPluginApi().catch(() => null);
    if (plug?.tool?.schema) tools.look = lookTool(plug, ctx, { lastApp: (id) => lastApp.get(id) || null });
  }
  return {
    ...(Object.keys(tools).length ? { tool: tools } : {}),
    'chat.params': async (input, output) => {
      if (!effort || effort === 'off' || !output?.options) return;
      if (input?.model?.providerID !== 'opencode-omniroute' || input?.agent === 'title') return;
      if (output.options.reasoningEffort == null) output.options.reasoningEffort = effort;
    },
    // nová zpráva uživatele → počty „za úkol“ od nuly
    'chat.message': async (input) => {
      // stav překladu jen z editů v tomto kole (dotaz uživatele bez editů → žádné pokračování „oprav build“)
      if (input?.sessionID) { guardOf(input.sessionID, opts).userTurn(); lastAsst.delete(input.sessionID); broken.delete(input.sessionID); }
    },
    'tool.execute.before': async (input, output) => {
      pending.set(input.callID, output.args);
      if (pending.size > 200) pending.delete(pending.keys().next().value);
      const g = guardOf(input.sessionID, opts);
      const cmdBefore = output.args?.command;
      if (g.widen(input.tool, output.args)) glog('widen', `příkaz s uříznutým výstupem rozšířen: ${cmdBefore} → ${output.args.command}`, { session: input.sessionID, from: cmdBefore, to: output.args.command });
      const msg = g.before(input.tool, output.args);
      if (msg) { glog('block', `ZABLOKOVÁNO ${input.tool}: ${msg}`, { session: input.sessionID, tool: input.tool, args: output.args }); throw new Error(msg); }
      // appka / dev server → na pozadí s logem (jinak nástroj visí do limitu 120 s a pak appku zabije), viz launch.mjs;
      // build / kopírování → nejdřív ukončit appky spuštěné v téže relaci (zamčený .exe)
      if (input.tool === 'bash' && typeof output.args?.command === 'string' && BUILD.test(output.args.command) && !(Number(output.args.timeout) >= BUILD_TIMEOUT)) {
        glog('timeout', `build dostal limit ${BUILD_TIMEOUT / 60000} min místo ${Math.round((Number(output.args.timeout) || 120000) / 1000)} s: ${output.args.command}`, { session: input.sessionID, command: output.args.command });
        output.args.timeout = BUILD_TIMEOUT;
      }
      if (input.tool === 'bash' && typeof output.args?.command === 'string' && opts.background !== false) {
        const orig = output.args.command;
        const bg = backgroundize(orig, { session: input.sessionID, cwd: output.args.workdir || ctx?.directory });
        if (bg) {
          output.args.command = bg.command;
          launched.set(input.callID, bg);
          const L = findLaunch(orig);
          if (L) lastApp.set(input.sessionID, appName(L.exe));
          glog('background', `dlouho běžící příkaz spuštěn na pozadí (výstup ${bg.log}): ${orig}`, { session: input.sessionID, from: orig, log: bg.log });
        } else {
          const rl = releaseLocks(orig, { session: input.sessionID });
          if (rl) { output.args.command = rl; glog('release', `před příkazem ukončeny appky spuštěné na pozadí: ${orig}`, { session: input.sessionID, command: orig }); }
        }
      }
    },
    'tool.execute.after': async (input, output) => {
      const args = input.args ?? pending.get(input.callID);
      pending.delete(input.callID);
      const g = guardOf(input.sessionID, opts);
      const short = g.shrink(input.tool, args, output.output);
      if (short != null && typeof output.output === 'string') { glog('shrink', `výstup ${input.tool} zkrácen pro model`, { session: input.sessionID, tool: input.tool, original: output.output, shortened: short }); output.output = short; }
      let note = g.after(input.tool, args, output.output);
      const bg = launched.get(input.callID);
      // cargo run: název binárky z „Running `target\\debug\\x.exe`“
      if (bg && typeof output.output === 'string') { const m = /Running `([^`]+?\.exe)/.exec(output.output); if (m) lastApp.set(input.sessionID, appName(m[1])); }
      if (bg) {
        launched.delete(input.callID);
        const n = `\n\n<system-reminder>\n${bg.note}\n</system-reminder>`;
        note = note ? note.replace('\n</system-reminder>', '\n' + bg.note + '\n</system-reminder>') : n;
      }
      // po úspěšném editu kontrolu (cargo check / tsc) spustí guard sám, viz autocheck.mjs
      const file = args?.filePath || args?.file_path;
      if (opts.autoCheck !== false && /^(edit|write|multiedit)$/.test(input.tool) && file) {
        const abs = path.isAbsolute(file) ? file : path.resolve(ctx?.directory || process.cwd(), file);
        const t0 = Date.now();
        const rep = await autoCheck(abs).catch((e) => { glog('autocheck-error', `kontrola po editu selhala: ${e?.message || e}`, { file: abs }); return ''; });
        if (rep) glog('autocheck', `kontrola po editu ${abs} (${Date.now() - t0} ms): ${rep}`, { session: input.sessionID, file: abs, ms: Date.now() - t0, report: rep });
        // stav překladu relace pro pokračování po „stop“ (jen celý výsledek kontroly, ne věta „checked together“)
        const remain = /\b(\d+) errors? remains?:/.exec(rep || '');
        if (remain) broken.set(input.sessionID, Number(remain[1]));
        else if (/after this edit: no errors/.test(rep || '')) broken.delete(input.sessionID);
        if (rep) note = note ? note.replace('\n</system-reminder>', '\n' + rep + '\n</system-reminder>') : '\n\n<system-reminder>\n' + rep + '\n</system-reminder>';
      }
      if (note) glog('note', `poznámka modelu k ${input.tool}: ${note.replace(/<\/?system-reminder>/g, '').trim()}`, { session: input.sessionID, tool: input.tool, note });
      if (note && typeof output.output === 'string') output.output += note;
    },
    // Nástroj, který skončí výjimkou (edit „Could not find oldString“…), tool.execute.after nespustí
    // (ověřeno v binárce 1.19.5). Selhání proto guard bere z události o části zprávy.
    event: async ({ event }) => {
      if (event?.type === 'message.updated') {
        const m = event.properties?.info;
        if (m?.role === 'assistant' && m.sessionID) lastAsst.set(m.sessionID, { id: m.id, finish: m.finish, providerID: m.providerID, modelID: m.modelID, agent: m.mode, stalled: /stream_stalled/.test(JSON.stringify(m.error || '')) });
        if (m?.role === 'assistant' && m.error && m.error.name !== 'ContextOverflowError' && m.providerID && m.modelID
          && OVERFLOW.test(JSON.stringify(m.error))) {
          toCompact.set(m.sessionID, { providerID: m.providerID, modelID: m.modelID });
          glog('overflow', `přetečení kontextu, které OpenCode nepozná (${m.providerID}/${m.modelID}): ${m.error?.data?.message || m.error?.name} → zkrátím, až relace stojí`, { session: m.sessionID, error: m.error });
        }
        return;
      }
      if (event?.type === 'session.status') {
        const id = event.properties?.sessionID;
        const st = event.properties?.status;
        const overflowIdle = st?.type === 'idle' && toCompact.has(id);
        if (st?.type === 'idle') {
          const la = lastAsst.get(id);
          lastAsst.delete(id);
          if (la?.finish === 'length' && !overflowIdle) autoContinue(id, la);
          // vítěz závodu modelů zmlkl uprostřed odpovědi a proxy krok ukončila chybou (src/race.js) → pokračovat
          else if (la?.stalled && !overflowIdle) autoContinue(id, la, 'stalled');
          else if (la?.finish === 'stop' && !overflowIdle) {
            const rec = partsOf.get(id);
            const text = rec && rec.messageID === la.id && !rec.tool ? [...rec.texts.values()].join(' ') : null;
            if (text != null && TOOL_AS_TEXT.test(text)) autoContinue(id, la, 'tooltext');
            // projekt nejde přeložit a model se uživatele neptá → pokračovat
            else if (text != null && broken.get(id) > 0 && !/\?\s*$/.test(text.trim())) autoContinue(id, la, 'broken');
          }
          partsOf.delete(id);
        }
        if (st?.type === 'idle' && toCompact.has(id)) {
          const body = toCompact.get(id);
          toCompact.delete(id);
          const now = Date.now();
          const recent = (compacted.get(id) || []).filter((t) => now - t < 600000);
          if (recent.length < 2) {
            compacted.set(id, [...recent, now]);
            glog('compact', `spouštím zkrácení kontextu relace ${id} (auto, pak pokračuje sama)`, { session: id, ...body });
            // až po doběhnutí obsluhy události (relace musí být opravdu volná)
            setTimeout(() => { ctx?.client?.session?.summarize({ path: { id }, body: { ...body, auto: true } }).catch((e) => glog('compact-error', `zkrácení relace ${id} selhalo: ${e?.message || e}`, { session: id })); }, 300);
          } else glog('compact-skip', `zkrácení relace ${id} přeskočeno: už 2× za 10 min`, { session: id });
        }
        if (st?.type !== 'retry') { if (st?.type === 'idle') aborted.delete(id); return; }
        if (maxRetries > 0 && st.attempt >= maxRetries && id && !aborted.has(id)) {
          aborted.add(id);
          glog('retry-abort', `relace ${id}: pokus ${st.attempt} – zastavuji nekonečné opakování; důvod chyby: ${st.message}`, { session: id, attempt: st.attempt, message: st.message });
          try { await ctx?.client?.session?.abort({ path: { id } }); } catch (e) { glog('retry-abort-error', `zastavení relace ${id} selhalo: ${e?.message || e}`, { session: id }); }
        }
        return;
      }
      if (event?.type !== 'message.part.updated') return;
      const p = event.properties?.part;
      // text a uvažování poslední odpovědi (kvůli TOOL_AS_TEXT); jen konec textu, víc není potřeba
      if (p?.sessionID && p.messageID && (p.type === 'text' || p.type === 'reasoning' || p.type === 'tool')) {
        let rec = partsOf.get(p.sessionID);
        if (!rec || rec.messageID !== p.messageID) { rec = { messageID: p.messageID, texts: new Map(), tool: false }; partsOf.set(p.sessionID, rec); }
        if (p.type === 'tool') rec.tool = true;
        else if (typeof p.text === 'string') rec.texts.set(p.id, p.text.slice(-4000));
        if (partsOf.size > 200) partsOf.delete(partsOf.keys().next().value);
      }
      if (!p || p.type !== 'tool' || p.state?.status !== 'error' || failedSeen.has(p.callID)) return;
      failedSeen.add(p.callID);
      if (failedSeen.size > 500) failedSeen.delete(failedSeen.values().next().value);
      const args = p.state.input ?? pending.get(p.callID);
      pending.delete(p.callID);
      glog('tool-fail', `nástroj ${p.tool} selhal (započítáno): ${p.state.error}`, { session: p.sessionID, tool: p.tool, args, error: p.state.error });
      guardOf(p.sessionID || event.properties?.sessionID, opts).fail(p.tool, args, p.state.error);
    },
    'shell.env': async (_input, output) => {
      for (const [k, v] of Object.entries(SHELL_ENV)) if (output.env[k] == null) output.env[k] = v;
    },
  };
};
