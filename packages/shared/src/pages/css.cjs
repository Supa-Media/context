/**
 * How a page looks before its own CSS: Context's own palette and type
 * (owner, 2026-10-27: "context/tex style fonts", no serif), light and dark,
 * and one accent the front matter may pick (`accent: green`).
 *
 * The faces are Instrument Sans and JetBrains Mono, the app's own
 * (`apps/mobile/features/design/tokens/typography.ts`). The runtime's sealed
 * frame loads nothing from the network, so it carries them inline
 * (`scripts/build-page-frame.mjs`); the cover picture links them like Tex's
 * cards do. Everywhere else the stacks fall back to the system's sans.
 *
 * Layout answers to the page's own width, not the window's (`container: pg`),
 * so the same page reads as a phone column in a side panel and spreads out
 * on a desktop. The blocks' sheet is `cssBlocks.cjs`.
 *
 * The page's own ```` ```css ```` fences come after this sheet, so a page can
 * restyle anything (`--pg-accent`, `.pg-nums`, `h1`).
 */

const { BLOCKS_CSS } = require("./cssBlocks.cjs");

const LIGHT = {
  bg: "#FFFDF9", surface: "#FFFFFF", ink: "#1A1714", body: "#4A443C", muted: "#635C52", line: "#E9E4DB", track: "#F2EEE7",
  good: "#3E7A4E", goodSoft: "#E3EFE5", warn: "#96600A", warnSoft: "#F7ECD9", hl: "#FBEFC4", dark: "#1A1714", darkInk: "#FFFDF9",
};
const DARK = {
  bg: "#191715", surface: "#221F1C", ink: "#F4F0E8", body: "#D7D1C7", muted: "#A79F94", line: "#36312B", track: "#2B2723",
  good: "#86C495", goodSoft: "#22322A", warn: "#E3A84F", warnSoft: "#3A2D18", hl: "#4A4020", dark: "#2D2925", darkInk: "#F4F0E8",
};
/** Each accent as [light, its light tint, dark, its dark tint]. Indigo is Context's own. */
const ACCENTS = {
  indigo: ["#2A45CF", "#E9ECFB", "#8A9BF2", "#242B4D"],
  green: ["#3E7A4E", "#E3EFE5", "#86C495", "#22322A"],
  orange: ["#B0570F", "#F8E9DA", "#F0A35C", "#3A2A1C"],
  plum: ["#7A4BC2", "#EFE7FA", "#B595F0", "#2C2240"],
  red: ["#B42318", "#FDE8E6", "#FF8A80", "#3D1F1C"],
  ink: ["#1A1714", "#F2EEE7", "#F4F0E8", "#2B2723"],
};
ACCENTS.blue = ACCENTS.indigo;

const SANS = `"Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif`;
const MONO = `"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace`;

/** The palette a page is drawn in: `theme: light|dark` in its front matter wins, else the viewer's. */
function pageTokens(fields, viewerDark) {
  const theme = String(fields?.theme ?? "").toLowerCase();
  const dark = theme === "dark" || theme === "night" ? true : theme === "light" || theme === "paper" ? false : viewerDark === true;
  const accent = ACCENTS[String(fields?.accent ?? "").toLowerCase()] ?? ACCENTS.indigo;
  const p = dark ? DARK : LIGHT;
  return {
    dark,
    vars:
      `--pg-bg:${p.bg};--pg-surface:${p.surface};--pg-ink:${p.ink};--pg-body:${p.body};--pg-muted:${p.muted};` +
      `--pg-line:${p.line};--pg-track:${p.track};--pg-good:${p.good};--pg-good-soft:${p.goodSoft};--pg-warn:${p.warn};` +
      `--pg-warn-soft:${p.warnSoft};--pg-hl:${p.hl};--pg-dark:${p.dark};--pg-dark-ink:${p.darkInk};` +
      `--pg-accent:${dark ? accent[2] : accent[0]};--pg-accent-soft:${dark ? accent[3] : accent[1]};--pg-accent-ink:${dark ? p.bg : "#FFFFFF"};` +
      `--pg-sans:${SANS};--pg-mono:${MONO};color-scheme:${dark ? "dark" : "light"};`,
  };
}

/** The page frame, its type, its words and the parts every page has. */
const PROSE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--pg-bg);color:var(--pg-body)}
body{font:16px/1.55 var(--pg-sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.pg{container:pg/inline-size;min-height:100%;background:var(--pg-bg)}
.pg-in{padding-inline:20px;max-width:1120px;margin-inline:auto}
@container pg (min-width:760px){.pg-in{padding-inline:56px}}
h1,h2,h3,h4{color:var(--pg-ink);text-wrap:balance;margin:0;font-family:var(--pg-sans)}
h1{font-weight:600;font-size:40px;line-height:1.02;letter-spacing:-.025em}
@container pg (min-width:760px){h1{font-size:64px}}
h2{font-weight:600;font-size:30px;line-height:1.06;letter-spacing:-.02em}
@container pg (min-width:760px){h2{font-size:42px}}
h3{font-weight:600;font-size:19px;line-height:1.25;margin:22px 0 6px}
h4{font-weight:600;font-size:16px}
p{margin:0 0 12px;max-width:68ch}
a{color:var(--pg-accent);text-underline-offset:2px}
hr{border:0;border-top:1px solid var(--pg-line);margin:28px 0}
strong{color:var(--pg-ink);font-weight:600}
code{font:.86em var(--pg-mono);background:var(--pg-track);padding:1px 5px;border-radius:5px;color:var(--pg-ink)}
.pg-code{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:10px;padding:12px 14px;overflow-x:auto;font:13px/1.55 var(--pg-mono)}
.pg-code code{background:none;padding:0}
.pg-k{font:500 12px/1.3 var(--pg-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--pg-accent)}
.pg-dek{font-size:18px;line-height:1.45;color:var(--pg-muted);max-width:46ch;margin:0}
.pg-body{padding-bottom:96px}
.pg-body>.pg-block:first-child,.pg-body>p:first-child{margin-top:24px}
.pg-cover{background:var(--pg-bg)}
.pg-cover-t{display:grid;gap:12px;padding-block:24px 8px}
.pg-cover-plain .pg-cover-t{padding-top:calc(var(--pg-top,0px) + 36px)}
.pg-cover-split{display:grid}
.pg-cover-split>.pg-ph{height:300px;border-radius:0}
@container pg (min-width:760px){
.pg-cover-split{grid-template-columns:1.05fr 1fr;min-height:460px}
.pg-cover-split>.pg-ph{height:auto;order:2}
.pg-cover-split .pg-cover-t{align-content:end;padding:80px 48px 40px 56px;margin:0;max-width:none}
.pg-cover-plain .pg-cover-t{padding-top:64px}
.pg-cover-split h1,.pg-cover-plain h1{font-size:72px}
}
.pg-cover-col{display:grid;grid-template-columns:1.4fr 1fr;grid-template-rows:170px 170px;gap:4px}
.pg-cover-col>.pg-ph{border-radius:0}
.pg-cover-col>.pg-ph:first-child{grid-row:1/3}
.pg-cover-col.n1{grid-template-columns:1fr;grid-template-rows:260px}
.pg-cover-col.n1>.pg-ph:first-child,.pg-cover-col.n2>.pg-ph:first-child{grid-row:auto}
.pg-cover-col.n2{grid-template-columns:1fr 1fr;grid-template-rows:240px}
@container pg (min-width:760px){.pg-cover-col.n3{grid-template-columns:2fr 1fr 1fr;grid-template-rows:300px}.pg-cover-col.n3>.pg-ph:first-child{grid-row:auto}.pg-cover-col h1{font-size:76px}}
.pg-cover-num{background:var(--pg-dark);color:var(--pg-dark-ink)}
.pg-cover-num .pg-in{display:grid;gap:22px;padding-block:calc(var(--pg-top,0px) + 44px) 30px}
.pg-cover-num .pg-lead{display:grid;gap:12px}
.pg-cover-num .pg-k,.pg-cover-num h1,.pg-cover-num .pg-dek{color:inherit}
.pg-cover-num .pg-k{opacity:.7}
.pg-cover-num h1{font-size:34px}
.pg-cover-num .pg-dek{opacity:.78}
.pg-big{font-weight:600;font-size:112px;line-height:.86;letter-spacing:-.045em;font-variant-numeric:tabular-nums}
.pg-big small{font-size:30px;letter-spacing:-.01em;opacity:.55;font-weight:500}
.pg-dots{display:block;width:100%;height:auto;max-width:560px}
.pg-dots .on{fill:currentColor}
.pg-dots .off{fill:color-mix(in srgb,currentColor 14%,transparent)}
@container pg (min-width:760px){.pg-cover-num .pg-in{grid-template-columns:1fr 1fr;align-items:end;column-gap:48px;padding-block:72px 44px}.pg-cover-num h1{font-size:44px}.pg-big{font-size:150px}}
.pg-statusline{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;font-size:13px;color:var(--pg-muted)}
.pg-cover-num .pg-statusline{color:inherit;opacity:.85}
.pg-pill{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;padding:5px 11px;border-radius:99px;background:var(--pg-warn-soft);color:var(--pg-warn)}
.pg-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.pg-pill.ok{background:var(--pg-good-soft);color:var(--pg-good)}
.pg-section{padding-top:56px;display:grid;gap:18px;align-content:start}
.pg-section>*{margin-top:0;margin-bottom:0}
.pg-sec-h{display:grid;gap:8px}
.pg-sec-h .pg-dek{font-size:16px;max-width:60ch}
.pg-tabs{display:flex;gap:4px;overflow-x:auto;margin:32px 0 0;border-bottom:1px solid var(--pg-line)}
.pg-tabs button{font:600 14px/1 var(--pg-sans);color:var(--pg-muted);background:none;border:0;border-bottom:2px solid transparent;padding:12px 12px;cursor:pointer;white-space:nowrap;min-height:44px}
.pg-tabs button[aria-selected=true]{color:var(--pg-ink);border-bottom-color:var(--pg-accent)}
.pg-tabs~.pg-section{padding-top:28px}
ul,ol{padding-left:1.3em;margin:0 0 12px}
li{margin:3px 0}
.pg-tasks{list-style:none;padding-left:0;border-top:1px solid var(--pg-line)}
.pg-tasks li{display:flex;gap:12px;align-items:flex-start;padding:11px 0;margin:0;border-bottom:1px solid var(--pg-line)}
.pg-tasks input{margin-top:3px;width:18px;height:18px;accent-color:var(--pg-accent);flex:none}
.pg-tasks li.done>span{color:var(--pg-muted);text-decoration:line-through}
blockquote{margin:0 0 12px;padding:4px 0 4px 16px;border-left:3px solid var(--pg-accent);color:var(--pg-ink);font-size:18px;line-height:1.45}
blockquote p{margin:0}
.pg-alert{border-radius:12px;border-left:0;background:var(--pg-accent-soft);padding:14px 16px;font-size:15px}
.pg-alert-warning,.pg-alert-caution,.pg-alert-important{background:var(--pg-warn-soft)}
.pg-table{overflow-x:auto;margin:0 0 14px;border-top:1px solid var(--pg-line)}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:10px 12px 10px 0;border-bottom:1px solid var(--pg-line)}
thead th{font:500 12px/1.3 var(--pg-mono);letter-spacing:.05em;text-transform:uppercase;color:var(--pg-muted);cursor:pointer;user-select:none}
td{font-variant-numeric:tabular-nums}
@container pg (max-width:600px){
.pg-table-cards{overflow:visible;border-top:0}
.pg-table-cards table,.pg-table-cards tbody,.pg-table-cards tr,.pg-table-cards td{display:block;width:auto}
.pg-table-cards thead{display:none}
.pg-table-cards tr{background:var(--pg-surface);border-radius:16px;box-shadow:inset 0 0 0 1px var(--pg-line);padding:14px 16px 6px;margin:0 0 10px}
.pg-table-cards td{display:grid;grid-template-columns:minmax(84px,34%) minmax(0,1fr);gap:12px;padding:7px 0;border-bottom:1px solid var(--pg-line);font-size:15px}
.pg-table-cards td:last-child{border-bottom:0}
.pg-table-cards td::before{content:attr(data-label);font:500 11px/1.6 var(--pg-mono);letter-spacing:.05em;text-transform:uppercase;color:var(--pg-muted)}
.pg-table-cards td:first-child{display:block;font-size:17px;font-weight:600;color:var(--pg-ink);padding:0 0 8px}
.pg-table-cards td:first-child::before{display:none}
}
.pg-img{max-width:100%;border-radius:14px;display:block;margin:6px 0 12px;background:var(--pg-track);min-height:40px}
.pg-ph{position:relative;overflow:hidden;background:var(--pg-accent-soft);border-radius:14px;min-width:0}
.pg-ph::before{content:attr(data-i);position:absolute;inset:0;display:grid;place-items:center;font:600 34px var(--pg-sans);color:var(--pg-accent);opacity:.55}
.pg-ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.pg-ph img:not([src]){visibility:hidden}
.pg-ph-label{position:absolute;right:8px;bottom:8px;font:600 11px var(--pg-sans);color:#fff;background:rgba(0,0,0,.5);padding:3px 8px;border-radius:99px}
.pg-faces{display:inline-flex;flex:none;padding-left:7px}
.pg-faces i{width:26px;height:26px;border-radius:50%;margin-left:-7px;display:grid;place-items:center;font:700 10px var(--pg-sans);font-style:normal;color:#fff;box-shadow:0 0 0 2px var(--pg-bg)}
.pg-faces .f0{background:#C2410C}.pg-faces .f1{background:#0F766E}.pg-faces .f2{background:#6D28D9}.pg-faces .f3{background:#2A45CF}.pg-faces .f4{background:#BE185D}.pg-faces .f5{background:#3E7A4E}.pg-faces .more{background:var(--pg-muted)}
.pg-c{background:var(--pg-hl);border-bottom:2px solid var(--pg-warn);cursor:pointer}
[data-edit][contenteditable=true]{outline:none;border-radius:4px}
[data-edit][contenteditable=true]:focus{box-shadow:0 0 0 2px var(--pg-accent-soft)}
:focus-visible{outline:2px solid var(--pg-accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const BASE_CSS = PROSE_CSS + BLOCKS_CSS;

module.exports = { pageTokens, BASE_CSS, ACCENTS };
