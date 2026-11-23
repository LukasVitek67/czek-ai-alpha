'use strict';
// Využití limitů: kolik požadavků a tokenů šlo dnes na každé API a model, co hlásí poskytovatel
// v hlavičkách (zbývá / limit) a jestli má model nebo účet pauzu. Ukládá se po dnech do usage.json.
const fs = require('fs');

const today = () => new Date().toISOString().slice(0, 10);
// Klíč projektu: složka bez ohledu na lomítka a velikost písmen (Windows).
const projKey = (dir) => String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

class Usage {
  /**
   * @param {string|null} file          denní využití (usage.json)
   * @param {string|null} projectsFile  součty za projekty od začátku (usage-projects.json)
   */
  constructor(file, projectsFile = null) {
    this.file = file;
    this.projectsFile = projectsFile;
    this.day = today();
    this.data = { day: this.day, providers: {} };
    this.projects = { since: Date.now(), projects: {} };
    this.saveTimer = null;
    if (file) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d && d.day === this.day && d.providers) this.data = d;
      } catch {}
    }
    if (projectsFile) {
      try {
        const d = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
        if (d && d.projects) this.projects = d;
      } catch {}
    }
  }

  recordProject(e, tin, tout) {
    if (!e.project) return;
    const k = projKey(e.project);
    const p = (this.projects.projects[k] ||= { dir: e.project, requests: 0, ok: 0, errors: 0, tokensIn: 0, tokensOut: 0, firstAt: Date.now(), lastAt: 0, models: {} });
    const m = (p.models[e.model] ||= { providerName: e.providerName || '', requests: 0, tokensIn: 0, tokensOut: 0, lastAt: 0 });
    p.requests++;
    if (e.ok) p.ok++; else p.errors++;
    p.tokensIn += tin; p.tokensOut += tout; p.lastAt = Date.now();
    m.requests++; m.tokensIn += tin; m.tokensOut += tout; m.lastAt = Date.now();
  }

  rollDay() {
    const d = today();
    if (d !== this.data.day) this.data = { day: d, providers: {} };
  }

  /**
   * @param {object} e  {provider, providerName, model, ok, kind, error, usage, rate, tier}
   */
  record(e) {
    this.rollDay();
    const p = (this.data.providers[e.provider] ||= { name: e.providerName || e.provider, requests: 0, ok: 0, errors: 0, tokensIn: 0, tokensOut: 0, lastAt: 0, rate: null, models: {} });
    const m = (p.models[e.model] ||= { requests: 0, ok: 0, errors: 0, tokensIn: 0, tokensOut: 0, lastAt: 0, lastError: null, rate: null });
    const tin = Number(e.usage?.prompt_tokens) || 0;
    const tout = Number(e.usage?.completion_tokens) || 0;
    for (const o of [p, m]) {
      o.requests++;
      if (e.ok) o.ok++; else o.errors++;
      o.tokensIn += tin;
      o.tokensOut += tout;
      o.lastAt = Date.now();
      if (e.rate) o.rate = { ...e.rate, at: Date.now() };
    }
    m.lastError = e.ok ? null : { kind: e.kind || 'other', message: String(e.error || '').slice(0, 200) };
    if (e.tier) m.tier = e.tier;
    this.recordProject(e, tin, tout);
    this.scheduleSave();
  }

  scheduleSave() {
    if ((!this.file && !this.projectsFile) || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.file) try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch {}
      if (this.projectsFile) try { fs.writeFileSync(this.projectsFile, JSON.stringify(this.projects)); } catch {}
    }, 2000);
  }

  /** Součty projektu od začátku (null, když ho proxy ještě neviděla), modely seřazené podle tokenů. */
  project(dir) {
    const p = dir ? this.projects.projects[projKey(dir)] : null;
    if (!p) return null;
    const models = Object.entries(p.models).map(([key, m]) => ({ key, ...m })).sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut));
    return { ...p, models };
  }

  /** Součet přes všechny projekty od začátku. */
  allProjects() {
    let tokensIn = 0, tokensOut = 0, requests = 0;
    const list = Object.values(this.projects.projects);
    for (const p of list) { tokensIn += p.tokensIn; tokensOut += p.tokensOut; requests += p.requests; }
    return { projects: list.length, tokensIn, tokensOut, requests, since: this.projects.since };
  }

  /** Pro zobrazení: poskytovatelé a jejich modely od posledního použití, s pauzami z registru. */
  snapshot(registry) {
    this.rollDay();
    const now = Date.now();
    const cooling = (key) => {
      const c = registry?.coolingInfo?.(key);
      return c && c.until > now ? { until: c.until, reason: c.reason } : null;
    };
    const providers = Object.entries(this.data.providers).map(([id, p]) => ({
      id, name: p.name, requests: p.requests, ok: p.ok, errors: p.errors, tokensIn: p.tokensIn, tokensOut: p.tokensOut, lastAt: p.lastAt, rate: p.rate,
      cooling: cooling(`provider:${id}`),
      models: Object.entries(p.models).map(([key, m]) => ({ key, ...m, cooling: cooling(key) })).sort((a, b) => b.lastAt - a.lastAt),
    })).sort((a, b) => b.lastAt - a.lastAt);
    return { day: this.data.day, providers };
  }
}

module.exports = { Usage, projKey };
