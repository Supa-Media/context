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
.td-kpi-label{font-size:14px;color:${C.ink2};font-weight:500}
.td-body{max-width:1240px;margin:0 auto;padding:20px 24px 72px;display:flex;flex-direction:column;gap:20px}
.td-row{display:flex;flex-wrap:wrap;gap:20px}
.td-row>.td-card{flex:1 1 480px;min-width:0}
.td-card{background:${C.card};border:1px solid ${C.line};border-radius:28px;padding:28px;display:flex;flex-direction:column;gap:18px;min-width:0}
.td-card-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px 16px}
.td-h2{font-family:var(--serif);font-weight:400;font-size:28px;line-height:1.1;letter-spacing:-.02em}
.td-meta{font-size:14px;color:${C.ink2};line-height:1.45}
.td-empty{font-size:15px;color:${C.ink2};padding:6px 0}
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
.td-spend-note{font-size:14px;color:${C.ink2};line-height:1.45}
.td-staff{max-width:520px;margin:0 auto;padding:96px 24px;display:flex;flex-direction:column;gap:14px}
.td-staff p{font-size:17px;line-height:1.5;color:${C.ink2}}
.td-foot{max-width:1240px;margin:0 auto;padding:24px 24px 40px;border-top:1px solid ${C.hair};font-size:14px;color:${C.ink2}}
.td-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.td-select select{height:44px;font-size:15px;background-position:calc(100% - 17px) 19px,calc(100% - 12px) 19px}
.td-link{all:unset;cursor:pointer;color:${C.blueDeep};font-weight:600;font-size:14px;text-decoration:underline;text-decoration-color:${C.bluePale};text-underline-offset:.2em}
.td-link:hover{color:${C.ink}}
.td-btn{appearance:none;border:1.5px solid ${C.hair};background:#fff;color:${C.ink};border-radius:12px;min-height:44px;padding:0 16px;font:600 14px var(--sans);cursor:pointer}
.td-btn:hover{border-color:${C.ink}}
.td-btn:disabled{opacity:.5;cursor:default}
.td-btn.primary{background:${C.ink};border-color:${C.ink};color:#fff}
.td-btn.light{background:${C.page};border-color:${C.page};color:${C.ink}}
.td-eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.hair};font-weight:600}
.td-today{display:flex;flex-wrap:wrap;gap:20px 40px;background:${C.ink};color:${C.page};border-radius:28px;padding:26px 28px}
.td-today-next{flex:1 1 420px;display:flex;flex-direction:column;gap:10px;min-width:0}
.td-today-line{font-family:var(--serif);font-size:clamp(24px,2.6vw,32px);line-height:1.2;letter-spacing:-.01em}
.td-today-checks{flex:1 1 360px;display:flex;flex-direction:column;gap:8px;min-width:0;border-left:1px solid ${C.inkRule};padding-left:24px;font-size:15px;line-height:1.45}
.td-today-checks .good{color:${C.bluePale}}
.td-today-checks .warn{color:${C.ochreWash}}
.td-today-checks .bad{color:${C.badWash};font-weight:600}
.td-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.td-tile{background:${C.card};border:1px solid ${C.line};border-radius:22px;padding:18px 20px;display:flex;flex-direction:column;gap:8px;min-width:0}
.td-kpi-label{font-size:14px;color:${C.ink2};font-weight:500}
.td-tile-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px}
.td-gauge{position:relative;height:16px;margin:2px 7px}
.td-gauge .track{position:absolute;left:-7px;right:-7px;top:6px;height:4px;border-radius:2px;background:${C.line}}
.td-gauge .tick{position:absolute;top:0;width:2px;height:16px;margin-left:-1px;background:${C.ink}}
.td-gauge .ring{position:absolute;top:2px;width:12px;height:12px;margin-left:-6px;border-radius:999px;border:1.5px solid ${C.ink3};box-sizing:border-box}
.td-gauge .dot{position:absolute;top:2px;width:12px;height:12px;margin-left:-6px;border-radius:999px;background:${C.blue}}
.td-gauge .dot.warn{background:${C.ochre}}
.td-pain{border-collapse:collapse;width:100%;min-width:760px;font-size:15px}
.td-pain th{text-align:left;font-size:13px;font-weight:500;color:${C.ink2};padding:8px 10px 8px 0;border-bottom:1px solid ${C.line}}
.td-pain td{padding:14px 10px 14px 0;border-bottom:1px solid ${C.line};vertical-align:top}
.td-pain-name{font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.td-pain-meta{font-size:13px;color:${C.ink3};line-height:1.4}
.td-pain-meta.working{color:${C.blueDeep};font-weight:600}
.td-pain-meta.still{color:${C.bad};font-weight:600}
.td-pain-meta.too_early{color:${C.ochre}}
.td-pain-act{text-align:right;white-space:nowrap}
.td-pain-act>*+*{margin-left:12px}
.td-chip{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap;background:${C.tray};color:${C.ink2}}
.td-chip.none,.td-chip.open{background:${C.badWash};color:${C.bad}}
.td-chip.working,.td-chip.triage,.td-chip.fixing{background:${C.ochreWash};color:${C.ochre}}
.td-chip.shipped,.td-chip.fixed{background:${C.blueWash};color:${C.blueDeep}}
.td-chip.new{background:${C.ink};color:#fff}
.td-dash{display:inline-block;width:14px;border-top:1.5px dashed ${C.ink3};margin-right:6px;vertical-align:middle}
.td-bugbars{display:flex;align-items:flex-end;gap:3px;height:52px}
.td-bugbars span{flex:1;background:${C.bad};border-radius:3px 3px 1px 1px;min-width:2px}
.td-bugbars span.zero{background:${C.line}}
.td-bugs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.td-bugs button{all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:12px 4px;border-bottom:1px solid ${C.line};min-height:44px}
.td-bugs button:hover .td-bug-title{text-decoration:underline}
.td-bugs .td-chip{grid-row:1/3;grid-column:2;align-self:center}
.td-bug-title{font-weight:600;font-size:15px}
.td-sheet{position:fixed;inset:0;z-index:50;display:flex;justify-content:flex-end}
.td-sheet-back{position:absolute;inset:0;background:rgba(22,24,28,.35)}
.td-sheet-body{position:relative;width:min(640px,100%);height:100%;overflow-y:auto;background:${C.card};padding:28px;display:flex;flex-direction:column;gap:14px;box-shadow:-24px 0 48px -24px rgba(22,24,28,.4)}
.td-note{white-space:pre-wrap;word-break:break-word;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid ${C.line};border-radius:14px;padding:14px;margin:0;max-height:50vh;overflow:auto}
.td-mail{display:flex;flex-direction:column;gap:8px;border-top:1px solid ${C.line};padding-top:12px}
.td-mail-line{display:flex;flex-direction:column;gap:2px;font-size:14px;white-space:pre-wrap}
.td-input{width:100%;font:15px/1.4 var(--sans);border:1.5px solid ${C.hair};border-radius:12px;padding:10px 12px;background:#fff;color:${C.ink};resize:vertical}
.td-error{font-size:14px;color:${C.bad}}
.td-cost{display:flex;flex-wrap:wrap;gap:20px 40px;align-items:center}
.td-cost-split{flex:1 1 360px;display:flex;flex-direction:column;gap:10px;min-width:0}
.td-more{background:${C.card};border:1px solid ${C.line};border-radius:28px;padding:20px 28px}
.td-more>summary{cursor:pointer;font-weight:600;font-size:16px;min-height:28px}
.td-more-body{display:flex;flex-direction:column;gap:20px;padding-top:20px}
@media (max-width:640px){
.td-wrap,.td-body{padding-left:16px;padding-right:16px}
.td-top{padding-top:36px}
.td-card{padding:20px;border-radius:22px}
.td-bar{grid-template-columns:110px 1fr auto}
.td-today{padding:20px}
.td-today-checks{border-left:0;padding-left:0;border-top:1px solid ${C.inkRule};padding-top:14px}
.td-sheet-body{padding:20px 16px}
}
`;
