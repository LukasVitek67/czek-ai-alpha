// czek-guard: plugin OpenCode proti smyčkám a drobení editů. Bez závislostí, jeden soubor.
// Háčky (ověřeno v @opencode-ai/plugin d.ts): tool.execute.before (výjimka = volání se neprovede),
// tool.execute.after (smí upravit výstup, který uvidí model), shell.env.
// Prahy podle OpenClaw / OpenHands / Gemini CLI: stejný vstup = poznámka, stejný vstup I výsledek =
// důraznější poznámka a pak blok. Čítače se po varování nenulují.
// Živý případ 12. 11.: Edit app.rs +1 −1 → cargo check | head -20 → Edit +1 −1 … pořád dokola
// (model vidí jen první chybu, opraví jeden řádek a každý krok posílá celý kontext znovu).
import { createHash } from 'node:crypto';

const norm = (v) => (Array.isArray(v) ? v.map(norm)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    : typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v);
const hash = (x) => createHash('sha1').update(JSON.stringify(norm(x)) || '').digest('hex').slice(0, 12);
const lines = (s) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
const base = (f) => String(f || '').split(/[\\/]/).pop();

export const DEFAULTS = {
  window: 10, repeat: 3, block: 5, tinyLines: 3, tinyEdits: 3, tinyWindow: 8, checkRepeat: 2,
  failEdits: 3, // tolik nepovedených editů téhož souboru → další edit blok, dokud ho model znovu nepřečte
  turnEdits: 8, // tolik editů téhož souboru od poslední zprávy uživatele → poznámka „přepiš to naráz“
  todoStreak: 3, // tolik todowrite za sebou bez jiné práce → blok
  todoShrink: true, // výstup todowrite zkrátit na potvrzení (celý seznam zpět = smyčka, viz níže)
};
const EDIT_TOOLS = /^(edit|multiedit|apply_patch|write)$/;
const fileOf = (args) => base(args?.filePath || args?.file_path || args?.path);
// Text výjimky z before() – její chybové události se nepočítají jako další selhání.
const OURS = 'Blocked by czek-guard';

// příkazy, u kterých je opakování se stejným vstupem normální (čekání na build, čtení logu)
const POLL = /^\s*(sleep\b|tail\b|cat\s+\S+\.log\b)|\bsleep\s+\d+\s*[;&]/;
// kontrola/sestavení, jejíž výstup je uříznutý na pár řádků → model vidí jen první chybu
const CHECK = /\b(cargo\s+(check|build|clippy|test)|tsc\b|npm\s+run\s+(build|check|lint|test)|pnpm\s+(build|check)|go\s+(build|vet)|dotnet\s+build|gradlew?\b|make\b)/;
const TRUNC = /\|\s*head\s+-(?:n\s*)?(\d+)/;

export class Guard {
  constructor(o = {}) {
    this.o = { ...DEFAULTS, ...o };
    this.calls = []; // { tool, input, pair, file, tiny, check }
    this.warned = new Map(); // klíč → pořadí volání, kdy se naposledy varovalo
    this.n = 0;
    this.failed = new Map(); // soubor → počet nepovedených editů od posledního čtení / úspěšného zápisu
    this.turn = new Map(); // soubor → počet editů od poslední zprávy uživatele
    this.edits = []; // poslední edity { file, old, new } kvůli poznání vracení změn tam a zpět
    this.todoRun = 0; // todowrite za sebou bez jiného nástroje
    this.widened = new Map(); // rozšířený příkaz → původní počet řádků (kvůli poznámce po doběhnutí)
  }

  /**
   * Před voláním, bez blokování: kontrola s uříznutým výstupem (`cargo check 2>&1 | head -30`) ukáže
   * modelu jen první chybu, ten opraví jeden řádek (+1 −1), spustí kontrolu znovu … (živě 12. a 13. 11.).
   * Příkaz se rovnou rozšíří: cargo krátký formát (jedna chyba = jeden řádek) a head 200.
   * Vrací true, když příkaz změnil (args se upravují na místě, OpenCode spustí upravený).
   */
  widen(tool, args) {
    if (tool !== 'bash' || typeof args?.command !== 'string') return false;
    const cmd = args.command;
    const t = TRUNC.exec(cmd);
    if (!t || !CHECK.test(cmd) || Number(t[1]) >= 150) return false;
    let c = cmd.replace(TRUNC, '| head -200');
    if (!/--message-format/.test(c)) c = c.replace(/\bcargo\s+(check|build|clippy)\b/, (m) => m + ' --message-format=short');
    args.command = c;
    this.widened.set(c.replace(/\s+/g, ' ').trim(), Number(t[1]));
    if (this.widened.size > 20) this.widened.delete(this.widened.keys().next().value);
    return true;
  }

  /** Nová zpráva uživatele: počty „za úkol“ se nulují (smyčky přes víc zpráv asistenta zůstávají). */
  userTurn() {
    this.turn.clear();
    this.todoRun = 0;
  }

  /** Před voláním: vrátí text chyby, když se má volání zablokovat. */
  before(tool, args) {
    if (tool === 'bash' && POLL.test(String(args?.command || ''))) return null;
    const input = hash([tool, args]);
    const recent = this.calls.slice(-this.o.window);
    const same = recent.filter((c) => c.input === input);
    if (same.length >= this.o.block - 1 && new Set(same.map((c) => c.pair)).size === 1) {
      return `${OURS}: this exact ${tool} call already ran ${same.length} times with the same result. Repeating it cannot help. Do something different: read the full error, change the approach, or tell the user what is blocking you.`;
    }
    // Issue anomalyco/opencode#25254 (komentář 20. 9.): nepovedené edity téhož souboru prokládané jinými
    // voláními vestavěný doom_loop nikdy nechytí. Po N selháních edit souboru zablokovat, dokud ho model
    // znovu nepřečte (nebo nepřepíše celý přes write).
    if (/^(edit|multiedit|apply_patch)$/.test(tool)) {
      const file = fileOf(args);
      const f = file && this.failed.get(file);
      if (f >= this.o.failEdits) {
        return `${OURS}: ${f} edits of ${file} have failed in a row, so your idea of the file's content is out of date (a formatter may have changed it, or an earlier edit already applied). Read ${file} again with the read tool first. Then either make one edit with oldString copied exactly from the fresh content, or rewrite the whole file with the write tool.`;
      }
    }
    if (tool === 'todowrite' && this.todoRun >= this.o.todoStreak) {
      return `${OURS}: todowrite was called ${this.todoRun} times in a row without any other work in between. The todo list is saved. Do the next task now (read, edit, run), and update the list only after an item is actually finished.`;
    }
    return null;
  }

  /** Volání skončilo chybou (událost message.part.updated se stavem error; after() se pak nevolá). */
  fail(tool, args, error) {
    const err = String(error ?? '');
    if (err.includes(OURS)) return;
    this.n++;
    const input = hash([tool, args]);
    this.calls.push({ tool, input, pair: input + hash('ERR ' + err), file: '', tiny: false, check: '', poll: false });
    if (this.calls.length > 60) this.calls.shift();
    if (tool !== 'todowrite') this.todoRun = 0;
    if (/^(edit|multiedit|apply_patch)$/.test(tool)) {
      const file = fileOf(args);
      if (file) this.failed.set(file, (this.failed.get(file) || 0) + 1);
    }
  }

  /**
   * Úprava výstupu nástroje před tím, než ho uvidí model (vrátí nový text, nebo null = beze změny).
   * todowrite vrací modelu celý seznam úkolů jako JSON; model ho „zkontroluje“, něco změní, zavolá todowrite
   * znovu… (Vashchuk, „Agent doom loop“, 2026: $250 za noc v nekonečném TodoWrite). GUI OpenCode bere seznam
   * z metadat, ne z tohoto textu, takže stačí krátké potvrzení.
   */
  shrink(tool, args, output) {
    if (tool !== 'todowrite' || !this.o.todoShrink || !Array.isArray(args?.todos)) return null;
    const t = args.todos;
    const by = (s) => t.filter((x) => x?.status === s).length;
    const cur = t.find((x) => x?.status === 'in_progress') || t.find((x) => x?.status === 'pending');
    const next = cur ? ` Work on: "${String(cur.content || '').slice(0, 160)}".` : '';
    return `Todo list saved (${t.length} items: ${by('completed')} completed, ${by('in_progress')} in progress, ${by('pending')} pending).${next} Do the work now; call todowrite again only when an item's status changes.`;
  }

  /** Po volání: vrátí poznámku k připojení na konec výstupu (nebo ''). */
  after(tool, args, output) {
    this.n++;
    const cmd = tool === 'bash' ? String(args?.command || '') : '';
    const poll = tool === 'bash' && POLL.test(cmd);
    const input = hash([tool, args]);
    const pair = input + hash(String(output ?? ''));
    const file = /^(edit|write|multiedit|apply_patch)$/.test(tool) ? base(args?.filePath || args?.file_path || args?.path) : '';
    const tiny = tool === 'edit' && Math.max(lines(args?.oldString), lines(args?.newString)) <= this.o.tinyLines && !args?.replaceAll;
    const trunc = TRUNC.exec(cmd);
    const check = tool === 'bash' && CHECK.test(cmd) ? cmd.replace(/\s+/g, ' ').trim() : '';
    this.calls.push({ tool, input, pair, file, tiny, check, poll });
    if (this.calls.length > 60) this.calls.shift();
    this.todoRun = tool === 'todowrite' ? this.todoRun + 1 : 0;
    // čerstvé čtení nebo úspěšný zápis souboru = model zná aktuální obsah → selhání se nulují
    if (tool === 'read' || EDIT_TOOLS.test(tool)) { const f = fileOf(args); if (f) this.failed.delete(f); }
    if (poll) return '';
    const cut = this.widened.get(cmd.replace(/\s+/g, ' ').trim());

    const recent = this.calls.slice(-this.o.window);
    const notes = [];
    const once = (key, every, text) => {
      const last = this.warned.get(key);
      if (last != null && this.n - last < every) return;
      this.warned.set(key, this.n);
      notes.push(text);
    };

    // 1) stejný vstup i výsledek
    const samePair = recent.filter((c) => c.pair === pair).length;
    const sameInput = recent.filter((c) => c.input === input).length;
    if (samePair >= this.o.repeat) {
      once('pair:' + pair, 2, `You have run this exact ${tool} call ${samePair} times and got the same result each time. It will be blocked if repeated. Change the approach or ask the user.`);
    } else if (sameInput >= this.o.repeat) {
      once('input:' + input, 3, `You have repeated this exact ${tool} call ${sameInput} times. If the result is not what you need, try a different command or read the relevant file instead.`);
    }

    // 2) ping-pong A-B-A-B
    const k = this.calls.length;
    if (k >= 4 && this.calls[k - 1].input === this.calls[k - 3].input && this.calls[k - 2].input === this.calls[k - 4].input && this.calls[k - 1].input !== this.calls[k - 2].input) {
      once('pingpong', 4, 'You are alternating between the same two calls. Stop and decide on one change that would make progress.');
    }

    // 3) drobení editů: mnoho malých editů téhož souboru
    if (tiny && file) {
      const win = this.calls.slice(-this.o.tinyWindow);
      const count = win.filter((c) => c.tiny && c.file === file).length;
      if (count >= this.o.tinyEdits) {
        once('tiny:' + file, this.o.tinyEdits, `This is your ${count}th one-line edit of ${file} in a row. Each step re-sends the whole conversation, so this is slow. Collect ALL remaining problems first (full compiler/test output, not just the first lines), then fix them together: several edits in one step (call the edit tool multiple times in one response) or rewrite the affected function in one edit.`);
      }
    }

    // 3b) +1 −1 tam a zpět: edit, který přesně vrací dřívější edit téhož souboru
    if (tool === 'edit' && file && typeof args?.oldString === 'string' && typeof args?.newString === 'string') {
      const o = norm(args.oldString), nw = norm(args.newString);
      const undo = this.edits.some((e) => e.file === file && e.old === nw && e.new === o);
      this.edits.push({ file, old: o, new: nw });
      if (this.edits.length > 30) this.edits.shift();
      if (undo) {
        once('undo:' + file + ':' + hash([o, nw]), 1, `This edit undoes one of your earlier edits of ${file} (you changed it to this before and then back). You are going in circles. Stop editing ${file}, re-read the actual error or test output, and decide what the code must look like before the next edit.`);
      }
    }

    // 3c) mnoho editů téhož souboru v jednom úkolu (i přes víc zpráv asistenta, kde vestavěný doom_loop nevidí)
    if (file && EDIT_TOOLS.test(tool)) {
      const c = (this.turn.get(file) || 0) + 1;
      this.turn.set(file, c);
      if (c >= this.o.turnEdits) {
        once('turn:' + file, this.o.turnEdits, `You have changed ${file} ${c} times for this request. If you are fixing it piece by piece, stop: read the whole file once, list every problem, then fix them in one larger edit or rewrite the file with write.`);
      }
    }

    // 4) opakovaná kontrola s uříznutým výstupem (… | head -20)
    if (cut) {
      notes.push(`czek-guard widened this command (output was cut to ${cut} lines, which hides all but the first error). This is the full list. Fix ALL of these errors in this one step (call the edit tool several times in one response, or rewrite the affected function), then run the check once.`);
    } else if (check) {
      const checks = this.calls.slice(-12).filter((c) => c.check === check).length;
      if (trunc && Number(trunc[1]) <= 40 && checks >= this.o.checkRepeat) {
        once('check:' + check, 4, `You ran this check ${checks} times with output cut to ${trunc[1]} lines, so you only see the first error each time. List all errors at once, e.g. \`cargo check --message-format=short 2>&1 | grep -E "^(error|warning: unused)" | head -60\` (or the equivalent for this tool), then fix them in one step.`);
      }
    }

    return notes.length ? '\n\n<system-reminder>\n' + notes.join('\n') + '\n</system-reminder>' : '';
  }
}

// Neinteraktivní shell: příkazy, které by čekaly na vstup (editor, pager, potvrzení), se nezaseknou.
// UTF-8: na české Windows je výchozí kódová stránka 1250, Python a další nástroje pak padají na
// UnicodeEncodeError u diakritiky a emoji (známá chyba OpenCode na Windows bez UTF-8 locale).
export const SHELL_ENV = {
  CI: '1', GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', npm_config_yes: 'true', DEBIAN_FRONTEND: 'noninteractive', GIT_TERMINAL_PROMPT: '0',
  LANG: 'C.UTF-8', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
};
