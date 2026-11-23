// Vidění pro modely bez obrázků. Živě 20. 11. (FurryBee): uživatel poslal obrázek („here is his pic, use it…“) a
// OpenCode ho modelu nahradil větou „ERROR: Cannot read image.png (this model does not support image input)“ – tier
// Max (Nemotron 3 Ultra) obrázky nečte, obrázek tak nikdo neviděl. Teď: combo hlásí obrázky (plugin, src/opencode.js),
// proxy závodu (src/race.js) každý obrázek ve zprávách uloží jako soubor do projektu (.czek/obrazky/) a nahradí
// textem: cesta k souboru + popis od modelu s viděním (main.js visionDescribe přes OmniRoute). Popis se drží podle
// otisku obrázku (každý krok posílá celou historii znovu) – v paměti i jako .txt vedle souboru.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_IMAGE_PROMPT = 'A software developer who cannot see this image needs it described precisely. Say what it shows; for a picture or character: subject, pose, style, line work, main colors (hex if you can); for a screenshot of an app: every visible panel, list, button and text, and every problem (overlapping elements, cut-off or unreadable text, tiny or empty lists, error messages). Copy any visible text exactly. Be concrete and complete, no preamble.';

const inflight = new Map(); // otisk → rozpracovaný popis
const isImagePart = (p) => p && typeof p === 'object' && (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image');
const urlOf = (p) => (typeof p.image_url === 'string' ? p.image_url : p.image_url?.url) || p.url || p.image || '';

/** Obsahuje některá zpráva obrázek? */
function hasImages(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content) && m.content.some(isImagePart));
}

/** Pracovní složka OpenCode ze systémového promptu („Working directory: C:\…“). */
function cwdOf(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'system') continue;
    const s = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p?.text || '').join('\n') : '';
    const x = /Working directory:\s*(.+)/.exec(s);
    if (x) return x[1].trim();
  }
  return null;
}

/** data:image/png;base64,… → { buf, ext } (jiná URL → null). */
function decodeDataUrl(url) {
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(String(url || ''));
  if (!m) return null;
  const ext = { jpeg: 'jpg', 'svg+xml': 'svg' }[m[1].toLowerCase()] || m[1].toLowerCase();
  return { buf: Buffer.from(m[2], 'base64'), ext };
}

/**
 * Nahradí obrázky ve zprávách textem (soubor + popis). Mění body.messages na místě, vrací počet nahrazených.
 * @param {object} body tělo chat/completions
 * @param {{describe: (dataUrls: string[], prompt: string) => Promise<{text: string, model: string}>, fallbackDir: () => string, cache?: Map, log?: Function}} o
 */
async function rewriteImages(body, o) {
  const msgs = body?.messages;
  if (!hasImages(msgs)) return 0;
  const cache = o.cache || new Map();
  const cwd = cwdOf(msgs);
  const dir = cwd && fs.existsSync(cwd) ? path.join(cwd, '.czek', 'obrazky') : o.fallbackDir();
  let n = 0;
  for (const m of msgs) {
    if (!Array.isArray(m?.content)) continue;
    for (let i = 0; i < m.content.length; i++) {
      const p = m.content[i];
      if (!isImagePart(p)) continue;
      const url = urlOf(p);
      const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
      // soubor podle pracovní složky TOHOTO dotazu (titulek relace ji v promptu nemá → jinak by se zapamatovala
      // záložní složka a krok agenta by dostal cestu mimo projekt); v mezipaměti jen popis
      let file = null;
      const dec = decodeDataUrl(url);
      if (dec) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          file = path.join(dir, `obrazek-${h}.${dec.ext}`);
          if (!fs.existsSync(file)) fs.writeFileSync(file, dec.buf);
        } catch (e) { file = null; o.log?.(`obrázek nejde uložit: ${e.message}`); }
      }
      const descFile = file ? file + '.txt' : null;
      let d = cache.get(h);
      if (!d) { try { if (descFile && fs.existsSync(descFile)) { const j = JSON.parse(fs.readFileSync(descFile, 'utf8')); if (j.text) d = { desc: j.text, model: j.model }; } } catch {} }
      if (!d) {
        // souběžné dotazy se stejným obrázkem (titulek relace + krok agenta) → jedno volání vidění
        let pr = inflight.get(h);
        if (!pr) { pr = o.describe([url], USER_IMAGE_PROMPT).then((r) => ({ desc: r.text, model: r.model }), (e) => ({ desc: null, why: e.message })); inflight.set(h, pr); pr.finally(() => inflight.delete(h)); }
        d = await pr;
        o.log?.(`obrázek ${h}: ${d.desc ? 'popsán modelem ' + d.model : 'bez popisu (' + d.why + ')'}${file ? ', soubor ' + file : ''}`, { hash: h, file, model: d.model, error: d.why });
      }
      if (d.desc) { cache.set(h, d); if (cache.size > 500) cache.delete(cache.keys().next().value); }
      if (d.desc && descFile && !fs.existsSync(descFile)) { try { fs.writeFileSync(descFile, JSON.stringify({ text: d.desc, model: d.model })); } catch {} }
      const where = file ? `saved as "${file}"${dec ? ` (${dec.buf.length} bytes, ${dec.ext})` : ''}` : (dec ? 'could not be saved' : `at ${url.slice(0, 200)}`);
      const text = d.desc
        ? `[Image from the user, ${where}. Your model cannot see images, so a vision model (${d.model}) describes it: ${d.desc}]`
        : `[Image from the user, ${where}. A description could not be obtained (${String(d.why || 'no vision model').slice(0, 200)}). Use the file directly if the task needs it, and tell the user you could not see it.]`;
      m.content[i] = { type: 'text', text };
      n++;
    }
  }
  // OpenCode u modelu bez obrázků přidá místo obrázku tuto větu – s popisem už neplatí
  for (const m of msgs) if (Array.isArray(m?.content)) m.content = m.content.filter((p) => !(p?.type === 'text' && /^ERROR: Cannot read "[^"]+" \(this model does not support image input\)/.test(p.text || '')));
  return n;
}

module.exports = { hasImages, cwdOf, decodeDataUrl, rewriteImages, USER_IMAGE_PROMPT };
