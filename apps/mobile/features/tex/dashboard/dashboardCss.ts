/**
 * The Tex dashboard's stylesheet (tex.lc/admin, `./TexDashboard.web`), in
 * tex.lc's own look (`../launch/texLaunchCss.ts`): paper, a Libron headline,
 * Instrument Sans for everything else, near-white cards on warm hairlines, and
 * Tex blue as the one accent. Web only, scoped under `.td`, light only like
 * tex.lc's other pages. `.td` is its own scroller, as `.tx` is on the
 * landing: the app's web shell does not scroll the body.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";

export const DASHBOARD_CSS = `
.td{--sans:"Instrument Sans",ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;--serif:"Libron",ui-serif,Georgia,serif;
  position:relative;height:100vh;height:100dvh;overflow-x:hidden;overflow-y:auto;background:${C.page};color:${C.ink};font-family:var(--sans);-webkit-font-smoothing:antialiased;color-scheme:light}
.td *{box-sizing:border-box}
:where(.td) :where(h1,h2,h3,p){margin:0}
.td .num{font-variant-numeric:tabular-nums}
.td a{color:inherit}
.td button:focus-visible,.td a:focus-visible,.td select:focus-visible{outline:2px solid ${C.ink};outline-offset:3px}
.td-wrap{max-width:1240px;margin:0 auto;padding:0 24px}
.td-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:32px}
.td-brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.td-mark{display:block;width:44px;height:44px}
.td-mark svg{display:block;width:100%;height:100%;overflow:visible}
.td-word{font-size:26px;font-weight:600;letter-spacing:-.02em}
.td-word b{color:${C.blue};font-weight:inherit}
.td-staff-pill{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1.5px solid ${C.hair};border-radius:999px;font-size:14px;font-weight:500;color:${C.ink2}}
.td-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:20px 32px;padding-top:56px}
.td-h1{font-family:var(--serif);font-weight:400;font-size:clamp(38px,4.4vw,60px);line-height:1.04;letter-spacing:-.02em}
.td-sub{font-size:17px;line-height:1.5;color:${C.ink2};margin-top:12px}
.td-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.td-seg{display:flex;gap:4px;padding:4px;border:1.5px solid ${C.hair};border-radius:999px;background:${C.card}}
.td-seg button{all:unset;cursor:pointer;font-size:15px;font-weight:500;color:${C.ink2};padding:0 16px;height:36px;display:inline-flex;align-items:center;border-radius:999px}
.td-seg button[aria-pressed="true"]{background:${C.ink};color:#fff}
.td-cta{display:inline-flex;align-items:center;height:46px;padding:0 22px;border-radius:14px;background:${C.ink};color:#fff!important;font-size:15px;font-weight:600;text-decoration:none}
.td-cta:hover{background:#000}
.td-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding-top:32px}
.td-kpi{background:${C.card};border:1px solid ${C.line};border-radius:24px;padding:20px 22px;display:flex;flex-direction:column;gap:6px;min-width:0}
.td-kpi-label{font-size:14px;color:${C.ink2};font-weight:500}
.td-kpi-value{font-size:40px;font-weight:600;letter-spacing:-.03em;line-height:1.1}
.td-kpi-unit{font-size:15px;color:${C.ink3};margin-left:6px;font-weight:500}
.td-kpi-note{font-size:13px;color:${C.ink3};line-height:1.4}
.td-kpi-note.crit{color:${C.bad}}
.td-kpi svg{width:100%;height:32px;display:block;margin:4px 0}
.td-body{max-width:1240px;margin:0 auto;padding:20px 24px 72px;display:flex;flex-direction:column;gap:20px}
.td-row{display:flex;flex-wrap:wrap;gap:20px}
.td-row>.td-card{flex:1 1 480px;min-width:0}
.td-card{background:${C.card};border:1px solid ${C.line};border-radius:28px;padding:28px;display:flex;flex-direction:column;gap:18px;min-width:0}
.td-card-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px 16px}
.td-h2{font-family:var(--serif);font-weight:400;font-size:28px;line-height:1.1;letter-spacing:-.02em}
.td-meta{font-size:14px;color:${C.ink2};line-height:1.45}
.td-empty{font-size:15px;color:${C.ink2};padding:6px 0}
.td-rings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.td-ring{border:1px solid ${C.line};border-radius:20px;padding:18px 14px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;background:#fff}
.td-ring-dial{position:relative;width:96px;height:96px}
.td-ring-dial svg{width:96px;height:96px;transform:rotate(-90deg)}
.td-ring-value{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600;letter-spacing:-.02em}
.td-ring-name{font-size:15px;font-weight:600;letter-spacing:-.01em}
.td-ring-hint{font-size:13px;color:${C.ink3}}
.td-chart{width:100%;display:block}
.td-axis{display:flex;justify-content:space-between;font-size:13px;color:${C.ink3}}
.td-bars{display:flex;flex-direction:column;gap:10px}
.td-bar{display:grid;grid-template-columns:minmax(120px,200px) 1fr minmax(44px,auto);gap:12px;align-items:center;font-size:15px}
.td-bar-track{height:10px;border-radius:5px;background:${C.tray};overflow:hidden}
.td-bar-fill{height:100%;border-radius:5px;background:${C.blue}}
.td-bar-fill.warm{background:${C.ochre}}
.td-bar-fill.crit{background:${C.bad}}
.td-bar-value{text-align:right;font-size:14px;color:${C.ink2}}
.td-sep{border-top:1px solid ${C.line};padding-top:16px;display:flex;flex-direction:column;gap:12px}
.td-small-h{font-size:14px;font-weight:600;color:${C.ink}}
.td-hist{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;align-items:end;height:150px}
.td-hist-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%}
.td-hist-bar{width:100%;border-radius:10px 10px 4px 4px;background:${C.blue};min-height:3px}
.td-hist-pct{font-size:13px;color:${C.ink2}}
.td-hist-labels{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;font-size:13px;color:${C.ink3};text-align:center}
.td-models{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.td-model{border:1px solid ${C.line};border-radius:20px;padding:18px;display:flex;flex-direction:column;gap:12px;background:#fff}
.td-model-name{font-size:19px;font-weight:600;letter-spacing:-.02em}
.td-model-role{font-size:12px;color:${C.ink3}}
.td-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.td-stat{display:flex;flex-direction:column;gap:2px}
.td-stat span:first-child{font-size:13px;color:${C.ink3}}
.td-stat span:last-child{font-size:17px;font-weight:600}
.td-lines{display:flex;flex-direction:column;gap:6px;font-size:14px;color:${C.ink2};border-top:1px solid ${C.line};padding-top:10px}
.td-lines div{display:flex;justify-content:space-between;gap:8px}
.td-lines .bad{color:${C.bad};font-weight:600}
.td-split{display:flex;height:14px;border-radius:7px;overflow:hidden;background:${C.tray}}
.td-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:14px;color:${C.ink2}}
.td-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.td-tasks{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.td-task{all:unset;box-sizing:border-box;cursor:pointer;border:1px solid ${C.line};border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:6px;background:#fff}
.td-task:hover{border-color:${C.ink}}
.td-task b{font-size:15px;font-weight:600}
.td-task .big{font-size:28px;font-weight:600;letter-spacing:-.03em}
.td-task .meta{font-size:13px;color:${C.ink3}}
.td-task .crit{color:${C.bad}}
.td-alerts{display:flex;flex-direction:column;gap:10px}
.td-alert{display:flex;gap:10px;align-items:flex-start;font-size:15px;line-height:1.45;padding:12px 16px;border-radius:14px;background:${C.ochreWash};color:${C.ink}}
.td-alert>span{color:${C.ochre}}
.td-alert.crit{background:${C.badWash}}
.td-alert.crit>span{color:${C.bad}}
.td-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.td-select{position:relative}
.td-select>button,.td-select select{appearance:none;-webkit-appearance:none;border:1.5px solid ${C.hair};background-color:#fff;border-radius:999px;padding:0 32px 0 14px;height:36px;font:500 14px var(--sans);color:${C.ink};cursor:pointer;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background-image:linear-gradient(45deg,transparent 50%,${C.ink3} 50%),linear-gradient(135deg,${C.ink3} 50%,transparent 50%);background-position:calc(100% - 17px) 15px,calc(100% - 12px) 15px;background-size:5px 5px;background-repeat:no-repeat}
.td-select>button:hover,.td-select select:hover{border-color:${C.ink}}
.td-select>button.on{border-color:${C.blue};background-color:${C.blueWash};color:${C.blueDeep}}
.td-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:20;background:${C.card};border:1px solid ${C.line};border-radius:16px;box-shadow:0 24px 48px -24px rgba(22,24,28,.3);padding:6px;min-width:230px;max-height:320px;overflow:auto}
.td-pop label{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;font-size:14px;cursor:pointer}
.td-pop label:hover{background:${C.tray}}
.td-pop input{accent-color:${C.blue}}
.td-pop .count{margin-left:auto;color:${C.ink3};font-size:13px}
.td-pop .all{border-bottom:1px solid ${C.line};margin-bottom:4px}
.td-clear{all:unset;cursor:pointer;color:${C.ink2};font-size:14px;padding:6px;text-decoration:underline;text-decoration-color:${C.hair};text-underline-offset:.2em}
.td-clear:hover{color:${C.ink}}
.td-table-wrap{overflow-x:auto}
.td-table{border-collapse:separate;border-spacing:3px;min-width:100%;font-size:14px}
.td-table th{font-weight:600;color:${C.ink2};text-align:center;padding:6px 8px;white-space:nowrap}
.td-table th.row{text-align:left}
.td-table td{text-align:center;padding:8px;border-radius:10px;min-width:88px}
.td-table td.name{text-align:left;padding:0;min-width:160px}
.td-table td.name button{all:unset;box-sizing:border-box;font-size:14px;font-weight:500;color:${C.ink};cursor:pointer;padding:8px;width:100%;border-radius:10px}
.td-table td.name button:hover{background:${C.tray}}
.td-table td .v{font-weight:600;display:block}
.td-table td .n{font-size:12px;color:${C.ink3}}
.td-table td.thin{opacity:.45}
.td-trends{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.td-trend{border:1px solid ${C.line};border-radius:20px;padding:16px 18px;background:#fff;display:flex;flex-direction:column;gap:4px;min-width:0}
.td-trend-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.td-trend-name{font-size:14px;font-weight:600}
.td-trend-value{font-size:28px;font-weight:600;letter-spacing:-.03em}
.td-delta{font-size:13px;font-weight:600;padding:2px 8px;border-radius:999px;background:${C.tray};color:${C.ink2};white-space:nowrap}
.td-delta.good{background:${C.blueWash};color:${C.blueDeep}}
.td-delta.bad{background:${C.badWash};color:${C.bad}}
.td-trend-plot{position:relative;margin:6px 0 2px}
.td-trend-dots span{position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:999px;border:1.5px solid #fff}
.td-spend-note{font-size:14px;color:${C.ink2};line-height:1.45}
.td-staff{max-width:520px;margin:0 auto;padding:96px 24px;display:flex;flex-direction:column;gap:14px}
.td-staff p{font-size:17px;line-height:1.5;color:${C.ink2}}
.td-foot{max-width:1240px;margin:0 auto;padding:24px 24px 40px;border-top:1px solid ${C.hair};font-size:14px;color:${C.ink2}}
@media (max-width:640px){
.td-wrap,.td-body{padding-left:16px;padding-right:16px}
.td-top{padding-top:36px}
.td-card{padding:20px;border-radius:22px}
.td-bar{grid-template-columns:110px 1fr auto}
}
`;
