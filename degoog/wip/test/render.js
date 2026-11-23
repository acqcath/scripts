// Renders recorded results with degoog 1.2.0's own result template (test/fixtures/result.html): shared by the
// jsdom replay (page.test.js) and the headless layout-shift check (headless/run.cjs)
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const render = (tpl, c) => {
  tpl = tpl.replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each \1\}\}/g, (_, k, body) => (c[k] || []).map((x) => render(body, x)).join(""));
  for (let i = 0; i < 4; i++) tpl = tpl.replace(/\{\{([#^])if (\w+)\}\}([\s\S]*?)\{\{\/if \2\}\}/g, (_, s, k, body) => ((s === "#") === !!c[k] ? body : ""));
  return tpl.replace(/\{\{t:[^}]+\}\}/g, "x").replace(/\{\{ (\w+) \}\}/g, (_, k) => esc(c[k]));
};
const fmt = (iso) => (iso ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)) : "");
const ctx = (r, i) => ({ index: i, title: r.title, url: r.url, cite_url: r.url.replace(/^https?:\/\//, ""), snippet: r.snippet, published_at: fmt(r.publishedAt),
  favicon_url: "", favicon_host: (() => { try { return new URL(r.url).hostname; } catch { return ""; } })(), thumbnail_url: r.thumbnail || "",
  sources: (r.sources || []).map((name) => ({ name })), duration: r.duration || "", is_video: !!r.duration, show_actions: true, action_block: true, action_score: true });
module.exports = { esc, render, fmt, ctx };
