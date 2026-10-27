/**
 * How a page looks before its own CSS: Tex's card palette
 * (`apps/mcp/src/agent/visuals/kit.js`) as page tokens, light and dark, and
 * one accent the front matter may pick (`accent: green`).
 *
 * The page's own ```` ```css ```` fences come after this sheet, so a page can
 * restyle anything (`--pg-accent`, `.pg-stat`, `h1`). They run only inside the
 * runtime's sealed frame, whose CSP loads nothing from the network, so this
 * sheet names system fonts only.
 */

const LIGHT = {
  bg: "#F6F5F1", surface: "#FFFFFF", ink: "#16161A", body: "#3E3E44", muted: "#5F5F66", line: "#E3E1DA", track: "#ECEAE3",
  good: "#1E7B4A", goodSoft: "#E2F0E7", warn: "#B4540A", warnSoft: "#FBEBDD", hl: "#FFF1B8",
};
const DARK = {
  bg: "#121316", surface: "#1C1D21", ink: "#F1F1F3", body: "#D2D2D8", muted: "#A9A9B3", line: "#2E3036", track: "#2A2C31",
  good: "#6FD9A3", goodSoft: "#1E3A2B", warn: "#F0A35C", warnSoft: "#3A2A1C", hl: "#4A4020",
};
const ACCENTS = {
  blue: ["#1F5FD1", "#E3ECFB", "#7AA7FF", "#1E2A44"],
  green: ["#1E7B4A", "#E2F0E7", "#6FD9A3", "#1E3A2B"],
  orange: ["#B4540A", "#FBEBDD", "#F0A35C", "#3A2A1C"],
  plum: ["#7A4BC2", "#EFE7FA", "#B595F0", "#2C2240"],
  red: ["#B42318", "#FDE8E6", "#FF8A80", "#3D1F1C"],
  ink: ["#16161A", "#ECEAE3", "#F1F1F3", "#2A2C31"],
};

/** The palette a page is drawn in: `theme: light|dark` in its front matter wins, else the viewer's. */
function pageTokens(fields, viewerDark) {
  const theme = String(fields?.theme ?? "").toLowerCase();
  const dark = theme === "dark" || theme === "night" ? true : theme === "light" || theme === "paper" ? false : viewerDark === true;
  const accent = ACCENTS[String(fields?.accent ?? "").toLowerCase()] ?? ACCENTS.blue;
  const p = dark ? DARK : LIGHT;
  return {
    dark,
    vars:
      `--pg-bg:${p.bg};--pg-surface:${p.surface};--pg-ink:${p.ink};--pg-body:${p.body};--pg-muted:${p.muted};` +
      `--pg-line:${p.line};--pg-track:${p.track};--pg-good:${p.good};--pg-good-soft:${p.goodSoft};--pg-warn:${p.warn};` +
      `--pg-warn-soft:${p.warnSoft};--pg-hl:${p.hl};--pg-accent:${dark ? accent[2] : accent[0]};--pg-accent-soft:${dark ? accent[3] : accent[1]};` +
      `color-scheme:${dark ? "dark" : "light"};`,
  };
}

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--pg-bg);color:var(--pg-body)}
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.pg{max-width:760px;margin:0 auto;padding:28px 20px 56px}
h1,h2,h3,h4{color:var(--pg-ink);text-wrap:balance;margin:0}
h1{font:600 clamp(30px,6vw,42px)/1.08 "Iowan Old Style","Palatino Linotype",Georgia,serif;letter-spacing:-.01em;margin:4px 0 12px}
h2{font:600 22px/1.25 "Iowan Old Style","Palatino Linotype",Georgia,serif;margin:0 0 10px}
h3{font-size:17px;margin:18px 0 6px}
p{margin:0 0 12px}
a{color:var(--pg-accent)}
hr{border:0;border-top:1px solid var(--pg-line);margin:24px 0}
code{font:.88em ui-monospace,Menlo,monospace;background:var(--pg-track);padding:1px 5px;border-radius:4px;color:var(--pg-ink)}
.pg-code{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:10px;padding:12px;overflow-x:auto;font:13px/1.5 ui-monospace,Menlo,monospace}
.pg-code code{background:none;padding:0}
.pg-head{margin-bottom:8px}
.pg-head>p:first-of-type{font-size:18px;line-height:1.5;color:var(--pg-ink)}
.pg-kicker{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pg-muted)}
.pg-section{padding-top:22px;margin-top:22px;border-top:1px solid var(--pg-line)}
.pg-tabs{display:flex;gap:4px;overflow-x:auto;margin:18px 0 0;border-bottom:1px solid var(--pg-line)}
.pg-tabs button{font:600 14px/1 inherit;font-family:inherit;color:var(--pg-muted);background:none;border:0;border-bottom:2px solid transparent;padding:10px 12px;cursor:pointer;white-space:nowrap}
.pg-tabs button[aria-selected=true]{color:var(--pg-ink);border-bottom-color:var(--pg-accent)}
.pg-tabs+.pg-section,.pg-tabs~.pg-section{border-top:0;margin-top:0}
ul,ol{padding-left:1.3em;margin:0 0 12px}
li{margin:3px 0}
.pg-tasks{list-style:none;padding-left:0}
.pg-tasks li{display:flex;gap:10px;align-items:flex-start}
.pg-tasks input{margin-top:5px;width:16px;height:16px;accent-color:var(--pg-good);flex:none}
.pg-tasks li.done>span{color:var(--pg-muted);text-decoration:line-through}
blockquote{margin:0 0 12px;padding:10px 14px;border-left:3px solid var(--pg-line);color:var(--pg-body)}
blockquote p{margin:0}
.pg-alert{border-radius:8px;border-left-width:4px;background:var(--pg-surface)}
.pg-alert-note,.pg-alert-tip{border-left-color:var(--pg-accent)}
.pg-alert-warning,.pg-alert-caution,.pg-alert-important{border-left-color:var(--pg-warn);background:var(--pg-warn-soft)}
.pg-table{overflow-x:auto;margin:0 0 14px;border:1px solid var(--pg-line);border-radius:10px;background:var(--pg-surface)}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-top:1px solid var(--pg-line)}
thead th{border-top:0;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--pg-muted);cursor:pointer;user-select:none}
.pg-img{max-width:100%;border-radius:10px;display:block;margin:6px 0 12px;background:var(--pg-track);min-height:40px}
.pg-block{margin:4px 0 18px}
.pg-caption{font-weight:600;color:var(--pg-ink);font-size:15px;margin-bottom:10px}
.pg-sub{display:block;font-size:13px;color:var(--pg-muted);line-height:1.4}
.pg-foot{font-size:12px;color:var(--pg-muted);margin:8px 0 0}
.pg-what{display:block;color:var(--pg-ink);font-weight:500}
.pg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.pg-stat{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:12px;padding:11px 13px;min-width:0}
.pg-stat small{display:block;font-size:12px;color:var(--pg-muted)}
.pg-stat strong{display:block;font-size:22px;line-height:1.2;color:var(--pg-ink);font-variant-numeric:tabular-nums}
.pg-cmp,.pg-progress{display:grid;gap:12px}
.pg-cmp-row,.pg-prog-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px}
.pg-cmp-name{color:var(--pg-ink);font-weight:500}
.pg-cmp-value{color:var(--pg-ink);font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.pg-track{grid-column:1/-1;height:9px;border-radius:5px;background:var(--pg-track);position:relative}
.pg-fill{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--pg-accent)}
.over .pg-fill{background:var(--pg-warn)}
.done .pg-fill{background:var(--pg-good)}
.pick .pg-cmp-name::after{content:"Best";margin-left:8px;font-size:11px;font-weight:600;color:var(--pg-good);background:var(--pg-good-soft);padding:2px 6px;border-radius:99px}
.pg-limit{position:absolute;top:-4px;bottom:-4px;border-left:2px dashed var(--pg-ink);opacity:.45}
.pg-cmp-row .pg-sub,.pg-prog-row .pg-sub{grid-column:1/-1}
.pg-sort{display:block;margin:0 0 10px auto;font:600 12px/1 inherit;font-family:inherit;color:var(--pg-accent);background:var(--pg-accent-soft);border:0;border-radius:6px;padding:5px 8px;cursor:pointer}
.pg-chart svg{width:100%;height:190px;display:block}
.pg-bar{fill:var(--pg-accent)}
.pg-line{fill:none;stroke:var(--pg-accent);stroke-width:3;vector-effect:non-scaling-stroke}
.pg-dot{fill:var(--pg-surface);stroke:var(--pg-accent);stroke-width:2;vector-effect:non-scaling-stroke}
.pg-axis{stroke:var(--pg-line);stroke-width:1;vector-effect:non-scaling-stroke}
.pg-goal{stroke:var(--pg-good);stroke-width:1.5;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}
.pg-chart-keys{display:grid;gap:6px;margin-top:6px;text-align:center;font-size:12px}
.pg-chart-keys strong{display:block;color:var(--pg-ink);font-variant-numeric:tabular-nums;font-size:13px}
.pg-key{color:var(--pg-muted)}
.pg-timeline{list-style:none;padding:0;margin:0;border-left:2px solid var(--pg-line)}
.pg-timeline li{display:grid;grid-template-columns:minmax(70px,auto) minmax(0,1fr);gap:12px;padding:6px 0 10px 14px;position:relative}
.pg-timeline li::before{content:"";position:absolute;left:-6px;top:13px;width:10px;height:10px;border-radius:50%;background:var(--pg-accent)}
.pg-when{font-weight:600;color:var(--pg-accent);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-steps,.pg-places{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.pg-steps li,.pg-places li{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;align-items:start}
.pg-num{width:28px;height:28px;border-radius:50%;background:var(--pg-accent-soft);color:var(--pg-accent);display:grid;place-items:center;font-weight:700;font-size:13px}
.pg-map{font-size:13px;font-weight:600;text-decoration:none;background:var(--pg-accent-soft);padding:4px 9px;border-radius:7px}
.pg-choose{display:grid;gap:8px}
.pg-option{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--pg-surface);border:1.5px solid var(--pg-line);border-radius:12px;padding:12px 14px;cursor:pointer}
.pg-option:hover{border-color:var(--pg-accent)}
.pg-option.on{border-color:var(--pg-good);background:var(--pg-good-soft)}
.pg-tick{font-size:12px;font-weight:600;color:var(--pg-accent);white-space:nowrap}
.pg-option.on .pg-tick{color:var(--pg-good)}
.pg-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.pg-col{background:var(--pg-track);border-radius:12px;padding:10px}
.pg-col h4{font-size:13px;display:flex;justify-content:space-between;margin:2px 4px 8px}
.pg-col h4 span{color:var(--pg-muted);font-weight:500}
.pg-card{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:9px;padding:9px 10px;margin-top:6px}
.pg-people{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.pg-person{display:flex;gap:12px;align-items:flex-start;background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:12px;padding:11px}
.pg-face{width:36px;height:36px;border-radius:50%;background:var(--pg-accent-soft);color:var(--pg-accent);display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.pg-vs{border:1px solid var(--pg-line);border-radius:12px;overflow:hidden;background:var(--pg-surface)}
.pg-vs-head,.pg-vs-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:10px;padding:9px 12px;border-top:1px solid var(--pg-line)}
.pg-vs-head{border-top:0;background:var(--pg-track);color:var(--pg-ink)}
.pg-vs-row .win{color:var(--pg-good);font-weight:600}
.pg-broken{border:1px dashed var(--pg-warn);border-radius:10px;padding:10px 12px}
.pg-problem{color:var(--pg-warn);font-size:13px}
.pg-broken pre{margin:0;white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,monospace}
.pg-box{width:100%;border:0;display:block;margin:4px 0 18px;border-radius:12px;background:var(--pg-surface)}
.pg-box iframe{width:100%;height:100%;border:0;display:block;border-radius:12px}
.pg-c{background:var(--pg-hl);border-bottom:2px solid var(--pg-warn);cursor:pointer}
[data-edit][contenteditable=true]{outline:none;border-radius:4px}
[data-edit][contenteditable=true]:focus{box-shadow:0 0 0 2px var(--pg-accent-soft)}
:focus-visible{outline:2px solid var(--pg-accent);outline-offset:2px}
@media (max-width:520px){.pg{padding:20px 16px 48px}.pg-timeline li{grid-template-columns:minmax(0,1fr)}.pg-vs-head,.pg-vs-row{font-size:14px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

module.exports = { pageTokens, BASE_CSS, ACCENTS };
