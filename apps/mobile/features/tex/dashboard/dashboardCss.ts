/**
 * The Tex dashboard's stylesheet (tex.lc/admin, `./TexDashboard.web`), as the
 * approved concept drew it: a dark hero with the headline numbers, then white
 * cards on a cool grey page. Web only, scoped under `.td`, one fixed light
 * palette like tex.lc's other pages. `.td` is its own scroller, as `.tx` is on
 * the landing: the app's web shell does not scroll the body.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";

/** The ink as an rgb triplet, for the cards' soft shadows. */
const INK_RGB = [1, 3, 5].map((i) => parseInt(C.ink.slice(i, i + 2), 16)).join(",");

export const DASHBOARD_CSS = `
.td{position:relative;height:100vh;height:100dvh;overflow-x:hidden;overflow-y:auto;background:${C.page};color:${C.ink};font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.td *{box-sizing:border-box}
.td .num{font-variant-numeric:tabular-nums}
.td .disp{font-family:Manrope,Inter,system-ui,sans-serif;letter-spacing:-0.02em}
.td a{color:${C.indigoInk}}
.td-hero{background:${C.ink};color:${C.heroText};padding:36px 24px 96px}
.td-wrap{max-width:1320px;margin:0 auto}
.td-hero .td-wrap{display:flex;flex-direction:column;gap:28px}
.td-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}
.td-brand{display:flex;align-items:center;gap:10px}
.td-mark{width:32px;height:32px;border-radius:10px;background:${C.indigo};display:flex;align-items:center;justify-content:center;font:800 16px Manrope,Inter,sans-serif;color:${C.card}}
.td-eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${C.line}}
.td-h1{margin:8px 0 0;font-size:40px;font-weight:800;letter-spacing:-0.03em}
.td-sub{font-size:15px;color:${C.line};margin-top:6px}
.td-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.td-seg{display:flex;background:${C.heroPanel};border-radius:12px;padding:4px}
.td-seg button{border:0;background:transparent;color:${C.line};font:600 14px Inter,sans-serif;padding:8px 14px;border-radius:9px;cursor:pointer;min-height:36px}
.td-seg button[aria-pressed="true"]{background:${C.heroText};color:${C.ink}}
.td-cta{display:flex;align-items:center;min-height:44px;padding:0 18px;border-radius:12px;background:${C.indigo};color:${C.card}!important;font:700 14px Inter,sans-serif;text-decoration:none}
.td-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.td-kpi{background:${C.heroPanel};border-radius:18px;padding:18px 20px;display:flex;flex-direction:column;gap:6px;min-width:0}
.td-kpi-label{font-size:13px;color:${C.line};font-weight:500}
.td-kpi-value{font-size:34px;font-weight:800}
.td-kpi-unit{font-size:14px;color:${C.muted};margin-left:8px;font-weight:500}
.td-kpi-note{font-size:13px;color:${C.muted}}
.td-kpi-note.crit{color:${C.redBright}}
.td-kpi svg{width:100%;height:32px;display:block}
.td-body{max-width:1320px;margin:-64px auto 0;padding:0 24px 64px;display:flex;flex-direction:column;gap:20px}
.td-row{display:flex;flex-wrap:wrap;gap:20px}
.td-row>.td-card{flex:1 1 480px;min-width:0}
.td-card{background:${C.card};border-radius:20px;box-shadow:0 1px 2px rgba(${INK_RGB},.06),0 8px 24px rgba(${INK_RGB},.06);padding:24px;display:flex;flex-direction:column;gap:16px;min-width:0}
.td-card-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}
.td-h2{margin:0;font-size:20px;font-weight:700}
.td-meta{font-size:13px;color:${C.ink3}}
.td-empty{font-size:14px;color:${C.ink4};padding:8px 0}
.td-rings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.td-ring{border:1px solid ${C.hair};border-radius:16px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.td-ring-dial{position:relative;width:96px;height:96px}
.td-ring-dial svg{width:96px;height:96px;transform:rotate(-90deg)}
.td-ring-value{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800}
.td-ring-name{font-size:14px;font-weight:600}
.td-ring-hint{font-size:12px;color:${C.ink3}}
.td-chart{width:100%;display:block}
.td-axis{display:flex;justify-content:space-between;font-size:12px;color:${C.ink3}}
.td-bars{display:flex;flex-direction:column;gap:10px}
.td-bar{display:grid;grid-template-columns:minmax(120px,200px) 1fr minmax(44px,auto);gap:12px;align-items:center;font-size:14px}
.td-bar-track{height:10px;border-radius:5px;background:${C.page};overflow:hidden}
.td-bar-fill{height:100%;border-radius:5px;background:${C.indigo}}
.td-bar-fill.warm{background:${C.amberDeep}}
.td-bar-fill.crit{background:${C.red}}
.td-bar-track.warm{background:${C.amberWash}}
.td-bar-value{text-align:right;font-size:14px}
.td-sep{border-top:1px solid ${C.hair};padding-top:14px;display:flex;flex-direction:column;gap:10px}
.td-small-h{font-size:13px;font-weight:600;color:${C.ink2}}
.td-hist{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;align-items:end;height:150px}
.td-hist-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%}
.td-hist-bar{width:100%;border-radius:8px 8px 4px 4px;background:${C.indigoSoft};min-height:3px}
.td-hist-pct{font-size:12px;color:${C.ink2}}
.td-hist-labels{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;font-size:12px;color:${C.ink3};text-align:center}
.td-models{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.td-model{border:1px solid ${C.hair};border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px}
.td-model-name{font-size:17px;font-weight:700}
.td-model-role{font-size:12px;color:${C.ink3}}
.td-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.td-stat{display:flex;flex-direction:column;gap:2px}
.td-stat span:first-child{font-size:12px;color:${C.ink3}}
.td-stat span:last-child{font-size:16px;font-weight:600}
.td-lines{display:flex;flex-direction:column;gap:6px;font-size:13px;color:${C.ink2};border-top:1px solid ${C.hair2};padding-top:10px}
.td-lines div{display:flex;justify-content:space-between;gap:8px}
.td-lines .bad{color:${C.red};font-weight:600}
.td-split{display:flex;height:14px;border-radius:7px;overflow:hidden;background:${C.page}}
.td-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:${C.ink2}}
.td-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.td-tasks{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.td-task{border:1px solid ${C.hair};border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:6px;cursor:pointer;background:${C.card};text-align:left;font:inherit;color:inherit}
.td-task:hover{border-color:${C.indigoHover}}
.td-task b{font-size:15px}
.td-task .big{font-size:24px;font-weight:800}
.td-task .meta{font-size:12px;color:${C.ink3}}
.td-task .crit{color:${C.red}}
.td-alerts{display:flex;flex-direction:column;gap:10px}
.td-alert{display:flex;gap:10px;align-items:flex-start;font-size:14px;padding:12px 14px;border-radius:12px;background:${C.amberAlert};color:${C.amberInk}}
.td-alert.crit{background:${C.redWash};color:${C.redInk}}
.td-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.td-select{position:relative}
.td-select>button,.td-select select{appearance:none;-webkit-appearance:none;border:1px solid ${C.line};background:${C.card};border-radius:10px;padding:7px 30px 7px 12px;font:500 13px Inter,sans-serif;color:${C.ink};cursor:pointer;min-height:34px;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background-image:linear-gradient(45deg,transparent 50%,${C.ink4} 50%),linear-gradient(135deg,${C.ink4} 50%,transparent 50%);background-position:calc(100% - 15px) 14px,calc(100% - 10px) 14px;background-size:5px 5px;background-repeat:no-repeat}
.td-select>button.on{border-color:${C.indigo};background-color:${C.indigoWash};color:${C.indigoInk2}}
.td-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:20;background:${C.card};border:1px solid ${C.hair};border-radius:12px;box-shadow:0 12px 32px rgba(${INK_RGB},.16);padding:6px;min-width:220px;max-height:320px;overflow:auto}
.td-pop label{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;font-size:13px;cursor:pointer}
.td-pop label:hover{background:${C.hair2}}
.td-pop .count{margin-left:auto;color:${C.ink4};font-size:12px}
.td-pop .all{border-bottom:1px solid ${C.hair2};margin-bottom:4px}
.td-clear{border:0;background:none;color:${C.indigoInk};font:600 13px Inter,sans-serif;cursor:pointer;padding:6px}
.td-table-wrap{overflow-x:auto}
.td-table{border-collapse:separate;border-spacing:3px;min-width:100%;font-size:13px}
.td-table th{font-weight:600;color:${C.ink3};text-align:center;padding:6px 8px;white-space:nowrap}
.td-table th.row{text-align:left}
.td-table td{text-align:center;padding:8px;border-radius:8px;min-width:88px}
.td-table td.name{text-align:left;padding:0;min-width:160px}
.td-table td.name button{border:0;background:none;font:500 13px Inter,sans-serif;color:${C.ink};cursor:pointer;padding:8px;text-align:left;width:100%;border-radius:8px}
.td-table td.name button:hover{background:${C.indigoWash}}
.td-table td .v{font-weight:700;display:block}
.td-table td .n{font-size:11px;color:${C.ink4}}
.td-table td.thin{opacity:.45}
.td-staff{max-width:520px;margin:120px auto;padding:24px;text-align:center;color:${C.ink2}}
@media (max-width:640px){
.td-hero{padding:24px 16px 88px}
.td-h1{font-size:30px}
.td-body{padding:0 16px 48px}
.td-card{padding:18px;border-radius:16px}
.td-bar{grid-template-columns:110px 1fr auto}
}
`;
