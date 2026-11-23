// czek-guard: nástroj look – agent se podívá na okno appky, kterou staví. Živě 20. 11. (FurryBee, egui): uživatel
// „album covers cover the text, songs are in a super small list, can't even play a song – why do you not test the app?
// You just type and hope for the best.“ Model (Nemotron 3 Ultra) obrázky nečte a okno appky neviděl nikdy.
// look: snímek okna (look.ps1, PrintWindow) → model s viděním přes czek-ai (CZEK_VISION_URL = proxy závodu
// /czek/vision → OmniRoute) → přesný popis rozložení a chyb + odpověď na otázku agenta; PNG zůstane v projektu.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOK_PROMPT = 'You are the eyes of a developer who cannot see the screen. This is a screenshot of the desktop app they are building. Describe it precisely: window title; every visible panel, list, table, button, slider and text (copy text exactly); sizes and positions (left/right/top, roughly how much of the window each area takes); colors. Then list EVERY problem you can see: overlapping elements (e.g. an image covering text), cut-off or unreadable text, lists or areas that are too small or empty although there is space, misaligned or missing controls, placeholder/garbage content, error messages or dialogs, a blank or black window. Be concrete and complete, no preamble.';

const PS1 = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'look.ps1');

/** Snímek okna → { file, title, process, width, height, method } nebo { error, windows }. */
export function capture({ target = '', pid = 0, out }, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let so = '';
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1(), '-Target', String(target), '-Out', out, '-ProcId', String(pid || 0)], { windowsHide: true });
    const t = setTimeout(() => { try { ps.kill(); } catch {} resolve({ error: 'capture timed out' }); }, timeoutMs);
    ps.stdout.on('data', (d) => { so += d; });
    ps.on('error', (e) => { clearTimeout(t); resolve({ error: e.message }); });
    ps.on('close', () => {
      clearTimeout(t);
      const line = so.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ error: 'capture failed: ' + so.trim().slice(0, 300) }); }
    });
  });
}

/** PNG → popis od modelu s viděním přes czek-ai. */
export async function describe(url, file, prompt, timeoutMs = 120000) {
  const img = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: [img], prompt }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.text) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

/**
 * Nástroj look pro OpenCode (plug = @opencode-ai/plugin).
 * @param {{lastApp: (sessionID: string) => string|null, visionUrl?: () => string|undefined}} o
 */
export function lookTool(plug, ctx, o) {
  const z = plug.tool.schema;
  return plug.tool({
    description: [
      'Look at the window of a running desktop app (screenshot) and get a precise description of what is on screen from a vision model, plus an answer to your question.',
      'Use it whenever you change a GUI app (native/egui/Tauri/Electron): build, start the app with the bash tool (it keeps running in the background), then call look with a concrete question, e.g. "Is any text covered by images? Does the track list fill the window? Is there an error dialog?".',
      'Fix what it reports and look again. Never tell the user a GUI works without having looked at it.',
      'The screenshot PNG is saved in the project (.czek/screenshots/) and its path is returned.',
    ].join('\n'),
    args: {
      target: z.string().optional().describe('Process name (e.g. "FurryBee" or "FurryBee.exe") or part of the window title. Omit to use the app you started last in this session.'),
      question: z.string().optional().describe('What exactly to check on the screen.'),
    },
    async execute(args, toolCtx) {
      const target = String(args.target || o.lastApp(toolCtx?.sessionID) || '').trim();
      if (!target) return 'No app to look at: pass target (the app process name, e.g. "FurryBee", or part of its window title). Start the app first with the bash tool.';
      const dir = path.join(toolCtx?.directory || ctx?.directory || process.cwd(), '.czek', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `look-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
      let shot = await capture({ target, out });
      for (let i = 0; i < 4 && shot.error === 'not found'; i++) { await new Promise((r) => setTimeout(r, 2000)); shot = await capture({ target, out }); } // appka se teprve otevírá
      if (shot.error) {
        return `No visible window found for "${target}"${shot.error === 'not found' ? '' : ` (${shot.error})`}. Is the app running (start it with the bash tool), did it crash (read its log), or is the name different? Processes with windows now: ${(shot.windows || []).join(', ') || 'none'}.`;
      }
      const head = `Screenshot of "${shot.title}" (${shot.process}, ${shot.width}×${shot.height} px, ${shot.method}) saved as ${shot.file}.`;
      const url = (o.visionUrl || (() => process.env.CZEK_VISION_URL))();
      if (!url) return `${head}\nNo vision model is available in this app, so nobody can describe it. If your model can read images, open the PNG with the read tool.`;
      const q = String(args.question || '').trim();
      try {
        const r = await describe(url, shot.file, LOOK_PROMPT + (q ? `\n\nThe developer asks: ${q}\nAnswer that question explicitly at the end.` : ''));
        return `${head}\nWhat a vision model (${r.model}) sees:\n${r.text}`;
      } catch (e) {
        return `${head}\nThe vision model failed (${e.message}). Try again in a minute; if your model can read images, open the PNG with the read tool.`;
      }
    },
  });
}
