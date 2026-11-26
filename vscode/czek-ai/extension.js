'use strict';
// czek-ai pro VS Code (uživatel 26. 11.: „integrace do VS Code jako alternativa / náhrada built-in chatu se stejnými
// možnostmi“). Dvě cesty:
//  1) panel czek-ai = celé rozhraní czek-ai (OpenCode + presety, pravidla učitele, vlastní presety, modely) pro otevřenou
//     složku – stránka webového mostu běžící czek-ai (src/webBridge.js), port a token z vscode.json v profilu czek-ai;
//     příkazy z editoru (zeptat se / vysvětlit / opravit / testy) vloží text do promptu chatu;
//  2) modely czek-ai (Max, High, Low) ve vestavěném chatu VS Code (Language Model Chat Provider, nástroje agenta VS Code).
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cfg = () => vscode.workspace.getConfiguration('czekAi');
const connFile = () => cfg().get('connectionFile') || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'czek-ai', 'vscode.json');
/** { port, token } z vscode.json, nebo null. */
function readConn() {
  try { const j = JSON.parse(fs.readFileSync(connFile(), 'utf8')); return Number(j.port) > 0 && /^[0-9a-f]{40}$/.test(j.token || '') ? { port: Number(j.port), token: j.token } : null; } catch { return null; }
}
const baseOf = (c) => `http://127.0.0.1:${c.port}`;
async function alive(c) {
  if (!c) return false;
  try { const r = await fetch(`${baseOf(c)}/__czek/ping?t=${c.token}`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
const b64 = (d) => Buffer.from(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Složka projektu: složka aktivního souboru ve workspace, jinak první složka workspace. */
function projectDir() {
  const doc = vscode.window.activeTextEditor?.document;
  const ws = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || vscode.workspace.workspaceFolders?.[0];
  return ws ? ws.uri.fsPath : '';
}

// ------------------------------------------------------------ spuštění czek-ai
function appCandidates() {
  const home = os.homedir();
  const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out = [];
  const own = cfg().get('appPath');
  if (own) out.push({ exe: own, args: [] });
  out.push({ exe: path.join(la, 'Programs', 'czek-ai', 'czek-ai.exe'), args: [] });
  const dev = path.join(home, '.czek-ai-dev');
  out.push({ exe: path.join(dev, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [dev] });
  for (const d of [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]) out.push({ exe: path.join(d, 'czek-ai.exe'), args: [] });
  return out.filter((c) => { try { return fs.statSync(c.exe).isFile(); } catch { return false; } });
}
let starting = null;
async function startApp() {
  if (await alive(readConn())) return true;
  if (starting) return starting;
  starting = (async () => {
    const c = appCandidates()[0];
    if (!c) {
      const pick = await vscode.window.showErrorMessage('czek-ai jsem nenašel. Nainstaluj ho, nebo nastav cestu (czekAi.appPath).', 'Nastavit cestu');
      if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'czekAi.appPath');
      return false;
    }
    spawn(c.exe, c.args, { detached: true, stdio: 'ignore', cwd: path.dirname(c.exe) }).unref();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Spouštím czek-ai…' }, async () => {
      for (let i = 0; i < 180; i++) { if (await alive(readConn())) return true; await new Promise((r) => setTimeout(r, 1000)); }
      vscode.window.showWarningMessage('czek-ai se nespustil do 3 minut.');
      return false;
    });
  })();
  try { return await starting; } finally { starting = null; refreshAll(); }
}

// ------------------------------------------------------------ panel s chatem
const views = new Set();
function html(webview, state) {
  const nonce = Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const body = state.url
    ? `<iframe id="f" src="${state.url}" allow="clipboard-read; clipboard-write" title="czek-ai"></iframe>`
    : `<div class="off"><p class="t">${state.noFolder ? 'Otevři složku projektu' : 'czek-ai neběží'}</p><p class="d">${state.noFolder ? 'Chat czek-ai pracuje v otevřené složce (Soubor → Otevřít složku).' : 'Chat ve VS Code používá běžící appku czek-ai (agent, modely, presety, klíče).'}</p>${state.noFolder ? '' : '<button id="s">Spustit czek-ai</button>'}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px var(--vscode-font-family)}
iframe{border:0;width:100%;height:100vh;display:block}
.off{padding:18px 16px}.t{font-weight:600;margin:0 0 6px}.d{margin:0 0 14px;color:var(--vscode-descriptionForeground)}
button{border:0;border-radius:3px;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head><body>${body}
<script nonce="${nonce}">const vs = acquireVsCodeApi(); document.getElementById('s')?.addEventListener('click', () => vs.postMessage({ cmd: 'start' }));</script></body></html>`;
}
async function render(webview) {
  const dir = projectDir();
  const c = readConn();
  const up = await alive(c);
  webview.html = html(webview, !dir ? { noFolder: true } : up ? { url: `${baseOf(c)}/${b64(dir)}/session` } : {});
}
function attach(webview) {
  webview.options = { enableScripts: true };
  webview.onDidReceiveMessage((m) => { if (m?.cmd === 'start') startApp(); });
  views.add(webview);
  render(webview);
}
const refreshAll = () => { for (const w of views) render(w).catch(() => {}); };

class ChatView {
  resolveWebviewView(view) {
    attach(view.webview);
    view.onDidDispose(() => views.delete(view.webview));
    view.onDidChangeVisibility(() => { if (view.visible && !view.webview.html.includes('<iframe')) render(view.webview); });
  }
}

// ------------------------------------------------------------ příkazy z editoru → prompt chatu
function selectionText(editor, wholeIfEmpty = true) {
  const doc = editor.document;
  let range = editor.selection;
  if (range.isEmpty && wholeIfEmpty) range = new vscode.Range(0, 0, doc.lineCount, 0);
  const code = doc.getText(range);
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const lines = range.isEmpty ? '' : range.start.line === range.end.line ? ` (řádek ${range.start.line + 1})` : ` (řádky ${range.start.line + 1}–${range.end.line + (range.end.character === 0 ? 0 : 1)})`;
  return { code, rel, lines, lang: doc.languageId, range };
}
const fence = (s) => { const t = s.includes('```') ? '````' : '```'; return [t, t]; };
function buildPrompt(kind, editor, extra = {}) {
  const { code, rel, lines, lang } = selectionText(editor, kind !== 'ask');
  const [a, b] = fence(code);
  const block = code.trim() ? `\n${a}${lang}\n${code.replace(/\s+$/, '')}\n${b}` : '';
  const where = `\`${rel}\`${lines}`;
  if (kind === 'explain') return `Vysvětli, co dělá tento kód ze souboru ${where} a proč:${block}`;
  if (kind === 'tests') return `Napiš testy pro tento kód ze souboru ${where}. Použij testovací nástroj, který projekt už má (jinak ten nejjednodušší pro tento jazyk), a testy spusť:${block}`;
  if (kind === 'fix') {
    const diags = (extra.diagnostics || []).map((d) => `- řádek ${d.range.start.line + 1}: ${d.message}${d.source ? ` (${d.source})` : ''}`).join('\n');
    return `Oprav ${diags ? 'tyto chyby' : 'problém'} v souboru ${where}${diags ? `:\n${diags}` : ''}${block}\nOprav to přímo v souboru a ověř, že chyba zmizela.`;
  }
  return `Soubor ${where}:${block}\n\n`;
}
async function insert(text) {
  let c = readConn();
  if (!(await alive(c))) { if (!(await startApp())) return; c = readConn(); }
  await vscode.commands.executeCommand('czekAi.chat.focus');
  // nově otevřený panel si stránku teprve načítá → chvíli zkoušet, dokud ji most nevidí
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${baseOf(c)}/__czek/vscode/insert?t=${c.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, dir: projectDir() }) });
      const j = await r.json();
      if (j.ok && j.pages > 0) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Chat czek-ai ještě není připravený – text je ve schránce, vlož ho do promptu (Ctrl+V).');
}
const editorCmd = (kind) => async (uri, extra) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Otevři soubor a vyber kód.'); return; }
  let diagnostics = extra?.diagnostics;
  if (kind === 'fix' && !diagnostics) {
    const sel = editor.selection;
    diagnostics = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => sel.isEmpty || d.range.intersection(sel));
  }
  await insert(buildPrompt(kind, editor, { diagnostics }));
};

class FixActions {
  provideCodeActions(doc, range, ctx) {
    if (!ctx.diagnostics?.length) return [];
    const a = new vscode.CodeAction('Opravit s czek-ai', vscode.CodeActionKind.QuickFix);
    a.command = { command: 'czekAi.fix', title: 'Opravit s czek-ai', arguments: [doc.uri, { diagnostics: ctx.diagnostics }] };
    return [a];
  }
}

// ------------------------------------------------------------ modely czek-ai ve vestavěném chatu VS Code
const TIERS = [
  { id: 'max', name: 'czek-ai Max', detail: 'nejsilnější free modely přes czek-ai' },
  { id: 'high', name: 'czek-ai High', detail: 'rychlejší free modely přes czek-ai' },
  { id: 'low', name: 'czek-ai Low', detail: 'nejrychlejší, na drobnosti' },
];
const textOf = (parts) => (parts || []).map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : typeof p?.value === 'string' ? p.value : '')).join('');
/** Zprávy VS Code → OpenAI chat formát (text, volání nástrojů, výsledky nástrojů). */
function toOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : m.role === 3 ? 'system' : 'user';
    let text = '';
    const calls = [];
    for (const p of m.content || []) {
      if (p instanceof vscode.LanguageModelTextPart) text += p.value;
      else if (p instanceof vscode.LanguageModelToolCallPart) calls.push({ id: p.callId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } });
      else if (p instanceof vscode.LanguageModelToolResultPart) out.push({ role: 'tool', tool_call_id: p.callId, content: textOf(p.content) || '(prázdné)' });
    }
    if (calls.length) out.push({ role: 'assistant', content: text || null, tool_calls: calls });
    else if (text) out.push({ role, content: text });
  }
  return out;
}
/** Proud SSE (OpenAI) → části odpovědi VS Code. */
async function streamTo(res, progress, token) {
  const dec = new TextDecoder();
  const calls = new Map();
  let buf = '';
  for await (const chunk of res.body) {
    if (token?.isCancellationRequested) break;
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) progress.report(new vscode.LanguageModelTextPart(delta.content));
      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? 0;
        const cur = calls.get(k) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(k, cur);
      }
    }
  }
  for (const c of calls.values()) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { raw: c.args }; }
    progress.report(new vscode.LanguageModelToolCallPart(c.id || `call_${Math.random().toString(36).slice(2)}`, c.name, input));
  }
}
const chatProvider = {
  async provideLanguageModelChatInformation() {
    if (cfg().get('chatModels') === false) return [];
    return TIERS.map((t) => ({ id: t.id, name: t.name, family: 'czek-ai', version: '1', detail: t.detail, tooltip: 'Modely přes běžící appku czek-ai (free tiery, závod modelů, záloha).', maxInputTokens: 96000, maxOutputTokens: 8000, capabilities: { toolCalling: true, imageInput: false } }));
  },
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    let c = readConn();
    if (!(await alive(c))) { if (!(await startApp())) throw new Error('czek-ai neběží'); c = readConn(); }
    const ctrl = new AbortController();
    const sub = token?.onCancellationRequested?.(() => ctrl.abort());
    try {
      const tools = (options?.tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
      const body = { model: model.id, stream: true, messages: toOpenAI(messages), max_tokens: 8000, ...(tools.length ? { tools, tool_choice: options?.toolMode === vscode.LanguageModelChatToolMode?.Required ? 'required' : 'auto' } : {}) };
      const res = await fetch(`${baseOf(c)}/__czek/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) throw new Error(`czek-ai: ${res.status} ${(await res.text()).slice(0, 300)}`);
      if (!/event-stream/.test(res.headers.get('content-type') || '')) { // model neumí proud → celá odpověď najednou
        const j = await res.json();
        const msg = j.choices?.[0]?.message || {};
        if (msg.content) progress.report(new vscode.LanguageModelTextPart(msg.content));
        for (const tc of msg.tool_calls || []) { let input = {}; try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {} progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function?.name, input)); }
        return;
      }
      await streamTo(res, progress, token);
    } finally { sub?.dispose?.(); }
  },
  async provideTokenCount(model, text) {
    const s = typeof text === 'string' ? text : textOf(text?.content);
    return Math.ceil(s.length / 4);
  },
};

// ------------------------------------------------------------ aktivace
function activate(context) {
  const reg = (d) => context.subscriptions.push(d);
  reg(vscode.window.registerWebviewViewProvider('czekAi.chat', new ChatView(), { webviewOptions: { retainContextWhenHidden: true } }));
  reg(vscode.commands.registerCommand('czekAi.focus', () => vscode.commands.executeCommand('czekAi.chat.focus')));
  reg(vscode.commands.registerCommand('czekAi.reload', () => refreshAll()));
  reg(vscode.commands.registerCommand('czekAi.start', () => startApp()));
  reg(vscode.commands.registerCommand('czekAi.openTab', () => {
    const p = vscode.window.createWebviewPanel('czekAi.tab', 'czek-ai', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    p.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    attach(p.webview);
    p.onDidDispose(() => views.delete(p.webview));
  }));
  for (const k of ['ask', 'explain', 'fix', 'tests']) reg(vscode.commands.registerCommand(`czekAi.${k}`, editorCmd(k)));
  reg(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  if (vscode.lm?.registerLanguageModelChatProvider) reg(vscode.lm.registerLanguageModelChatProvider('czek-ai', chatProvider));
  // stavový řádek: czek-ai běží / neběží
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  sb.command = 'czekAi.focus';
  reg(sb);
  let wasUp = null;
  const tick = async () => {
    const up = await alive(readConn());
    sb.text = up ? '$(comment-discussion) czek-ai' : '$(debug-disconnect) czek-ai';
    sb.tooltip = up ? 'czek-ai běží – otevřít chat (Ctrl+Alt+C)' : 'czek-ai neběží – klikni a spusť ho v panelu';
    sb.show();
    if (wasUp !== null && up !== wasUp) refreshAll();
    wasUp = up;
  };
  tick();
  const t = setInterval(tick, 5000);
  reg({ dispose: () => clearInterval(t) });
  reg(vscode.window.onDidChangeActiveTextEditor(() => { /* jiná složka → panel přepnout */ const d = projectDir(); if (d !== lastDir) { lastDir = d; refreshAll(); } }));
}
let lastDir = '';
function deactivate() {}

module.exports = { activate, deactivate, _test: { buildPrompt, toOpenAI, streamTo, chatProvider, html, readConn, projectDir } };
