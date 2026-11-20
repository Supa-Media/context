/**
 * The Testing tab's styles (Dev2, 2026-11-15: "build this EXACTLY how it is here"), ported from the prototype
 * https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K onto the Lab's own tokens (`labCss.ts`), so light and dark follow
 * the Lab. Scoped under `.tl .tst`; `labCss2.ts` appends it.
 */
import { LAB_CSS_4 } from "./labCss4";

export const LAB_CSS_3 = String.raw`
.tl .body.testing{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.tl .bar .ratio{margin-left:8px}
.tl .tst .plan{color:var(--accent)}
.tl .tst{--star:#C27C0E;--tbub:var(--accent-dim);height:100%;display:grid;grid-template-rows:minmax(0,1fr);font-size:13px;line-height:1.45;padding:10px;gap:10px;background:var(--chrome)}
.tl[data-theme="dark"] .tst{--star:#F0B240}
@media (prefers-color-scheme: dark){.tl:not([data-theme="light"]) .tst{--star:#F0B240}}
.tl .tst button{font:inherit;color:inherit;cursor:pointer}
.tl .tst button:focus-visible,.tl .tst input:focus-visible,.tl .tst select:focus-visible,.tl .tst [tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tl .tst .cols{display:grid;grid-template-columns:250px minmax(0,1fr) 340px;gap:10px;min-height:0}
@media (max-width:980px){.tl .tst .cols{grid-template-columns:1fr!important}.tl .tst{height:auto;overflow:auto}}
.tl .tst .panel{background:var(--page);border:1px solid var(--line2);border-radius:12px;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.tl .tst .scroll{overflow:auto;min-height:0;flex:1}
.tl .tst .ph{padding:10px 12px;border-bottom:1px solid var(--line2);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tl .tst .ph b{font-weight:600}
.tl .tst .muted{color:var(--muted)}.tl .tst .small{font-size:12px}.tl .tst .mono{font-family:var(--mono);font-size:11px}
.tl .tst .set{padding:8px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--line2)}
.tl .tst .set.drop{background:var(--accent-dim)}
.tl .tst .sethead{display:flex;justify-content:space-between;align-items:center;padding:2px 4px;font-weight:600}
.tl .tst .chat{border:1px solid transparent;border-radius:8px;padding:7px 8px;text-align:left;background:none;display:flex;flex-direction:column;gap:2px;width:100%}
.tl .tst .chat:hover{background:var(--s3)}
.tl .tst .chat.on{background:var(--s3);border-color:var(--line2)}
.tl .tst .chat .t{font-weight:500;display:flex;justify-content:space-between;gap:6px}
.tl .tst .dot{width:8px;height:8px;border-radius:4px;display:inline-block;flex-shrink:0}
.tl .tst .lock{background:color-mix(in srgb,var(--team) 12%,var(--page));color:var(--team);border-radius:8px;padding:8px;font-size:12px;display:flex;flex-direction:column;gap:6px}
.tl .tst .btn{border:1px solid var(--line2);background:var(--page);border-radius:8px;padding:6px 11px}
.tl .tst .btn.p{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.tl .tst .btn.sm{padding:3px 8px;font-size:12px}
.tl .tst .btn.ghost{border-color:transparent;background:none;color:var(--accent)}
.tl .tst a.btn{text-decoration:none;color:var(--accent)}
.tl .tst select{border:1px solid var(--line2);border-radius:8px;padding:6px 8px;background:var(--page);color:var(--text);font:inherit}
.tl .tst .insp{padding:12px;display:flex;flex-direction:column;gap:12px}
.tl .tst .cap{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.tl .tst .seg{display:flex;flex-wrap:wrap;gap:4px}
.tl .tst .seg button{border:1px solid var(--line2);background:var(--page);border-radius:7px;padding:4px 10px;font-size:12px}
.tl .tst .seg button.on{border-color:var(--accent);background:var(--accent-dim);color:var(--accent);font-weight:600}
.tl .tst .field{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px;align-items:start}
.tl .tst .must{display:flex;flex-direction:column;gap:4px}
.tl .tst .must div{display:flex;gap:6px;align-items:center}
.tl .tst .must input,.tl .tst .txtf{flex:1;border:1px solid var(--line2);border-radius:6px;padding:5px 7px;background:var(--page);color:var(--text);font:inherit;min-width:0}
.tl .tst textarea{width:100%;border:1px solid var(--line2);border-radius:8px;padding:8px;background:var(--page);color:var(--text);font:inherit;min-height:70px;resize:vertical}
.tl .tst .note{background:var(--s3);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--muted)}
.tl .tst .c-ok{color:var(--ok)}.tl .tst .c-bad{color:var(--bad)}.tl .tst .c-open{color:var(--muted)}.tl .tst .c-no{color:var(--line2)}.tl .tst .c-must{color:var(--warn)}.tl .tst .c-star{color:var(--star)}
.tl .tst .starc{color:var(--star)}
.tl .tst table.chatgrid{display:table;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:12px}
.tl .tst table.chatgrid th,.tl .tst table.chatgrid td{border-bottom:1px solid var(--line2);border-right:1px solid var(--line2);padding:5px 6px;text-align:left;vertical-align:top;overflow:hidden;text-overflow:ellipsis}
.tl .tst table.chatgrid thead{display:table-header-group}.tl .tst table.chatgrid thead th{position:sticky;top:0;background:var(--s3);z-index:1;font-weight:600;white-space:nowrap}
.tl .tst table.chatgrid thead th .hname{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .tst .rs{position:absolute;right:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:3}
.tl .tst .rs:hover{background:var(--accent);opacity:.4}
.tl .tst table.chatgrid td.num{text-align:right;color:var(--muted);cursor:grab;user-select:none;white-space:nowrap}
.tl .tst td.num .grip{color:var(--line2);margin-right:3px;font-size:12px}
.tl .tst tr.mr:hover td.num .grip{color:var(--muted)}
.tl .tst table.chatgrid td.nc{white-space:nowrap}
.tl .tst table.chatgrid td.txt{white-space:normal;word-break:break-word;line-height:1.35}
.tl .tst table.chatgrid td.dc{cursor:cell}
.tl .tst table.chatgrid td.dc.on{box-shadow:inset 0 0 0 2px var(--accent)}
.tl .tst tr.mr:hover td{background:var(--s3)}
.tl .tst tr.mr.sel td{background:var(--accent-dim)}
.tl .tst tr.mr.tex td{background:color-mix(in srgb,var(--tbub) 45%,var(--page))}
.tl .tst tr.mr.tex.sel td{background:var(--accent-dim)}
.tl .tst tr.mr.dragging td{opacity:.45}
.tl .tst .texwho{color:var(--accent)}
.tl .tst .cv{color:var(--text);font-size:11px}
.tl .tst .ed{width:100%;font:inherit;font-size:12px;border:1px solid var(--accent);border-radius:4px;padding:2px 4px;background:var(--page);color:var(--text);resize:vertical;min-height:0}
.tl .tst .edwrap{display:flex;flex-direction:column;gap:3px}
.tl .tst .rowx{border:0;background:none;color:var(--muted);opacity:0;font-size:13px;width:20px;padding:0}
.tl .tst tr.mr:hover .rowx{opacity:1}
.tl .tst td.x{border-right:0!important;white-space:nowrap}
.tl .tst tr.addrow td{border-right:0!important}
.tl .tst .colmenu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;background:var(--page);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);padding:10px;width:250px;max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:4px}
.tl .tst .colmenu .cm{display:flex;align-items:center;gap:4px}.tl .tst .colmenu .cm label{flex:1;font-size:13px}
.tl .tst .colmenu .btn.sm{padding:1px 7px}
.tl .tst .quote{background:var(--s3);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:2px}
.tl .tst .kind{color:var(--accent);font-size:11px;font-weight:600}.tl .tst .kind.bad{color:var(--bad)}
.tl .tst .inmsg{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
.tl .tst .insf{width:100%;font:inherit;border:1px solid var(--line2);border-radius:6px;padding:5px 7px;background:var(--page);color:var(--text)}
.tl .tst .inbox{border:1px solid var(--line2);border-radius:8px;padding:8px 10px}
.tl .tst .inbox summary{cursor:pointer}
.tl .tst .inbox > *:not(summary){margin-top:6px}
.tl .tst .inrow{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px;align-items:start;padding:2px 0}
.tl .tst .inrow b{font-weight:600;font-size:12px}
.tl .tst .panel.fold{align-items:center;justify-content:flex-start;gap:10px;padding:10px 0;color:var(--muted);font-weight:600;cursor:pointer}
.tl .tst .panel.fold:hover{color:var(--text);background:var(--s3)}
.tl .tst .panel.fold .foldname{writing-mode:vertical-rl;font-size:12px;letter-spacing:.04em}
.tl .tst .foldbtn{border:none;background:none;color:var(--muted);padding:2px 6px;border-radius:6px;font-size:13px;line-height:1}
.tl .tst .foldbtn:hover{background:var(--s3);color:var(--text)}
.tl .tst .pics{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.tl .tst .pics img{width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line2);display:block}
.tl .tst .pics .pic{position:relative}
.tl .tst .pics .pic button{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:9px;border:1px solid var(--line2);background:var(--page);font-size:11px;line-height:1;padding:0}
.tl .tst .picadd{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--accent);cursor:pointer}
.tl .tst .picadd input{display:none}
.tl .tst .hist{position:absolute;right:0;top:calc(100% + 4px);z-index:30;width:320px;max-height:420px;overflow:auto;background:var(--page);border:1px solid var(--line2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:6px}
.tl .tst .hist .hr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:6px 8px;border-radius:7px}
.tl .tst .hist .hr:hover{background:var(--s3)}
.tl .tst .hist .hr.cur{background:var(--accent-dim)}
.tl .tst .legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);padding:8px 12px 12px}
.tl .tst .banner{background:color-mix(in srgb,var(--team) 12%,var(--page));color:var(--team);padding:8px 12px;font-size:12px;border-bottom:1px solid var(--line2)}
.tl .tst .empty{padding:30px;text-align:center;color:var(--muted)}
.tl .tst kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;padding:0 4px}
.tl .ratio{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.tl .ratio .rbar{display:flex;width:160px;height:8px;border-radius:4px;overflow:hidden;background:var(--line2)}
.tl .ratio .rbar i{display:block;height:100%}
.tl .ratio .ok{color:var(--ok);font-weight:600}.tl .ratio .warn{color:var(--warn);font-weight:600}
.tl .dropline{position:fixed;height:3px;background:var(--accent);border-radius:2px;z-index:50;pointer-events:none}
.tl.rowdrag,.tl.rowdrag *{cursor:grabbing!important;user-select:none}
/* The Lab's own .ph, .seg, .num, .dot, .rbar and table rules are for other pages: undone here so the tab reads as the prototype. */
.tl .tst .ph{margin-bottom:0}
.tl .tst .dot{flex:none}
.tl .tst .seg{background:none;padding:0;border-radius:0}
.tl .tst .seg button{flex:none;display:inline-block;color:var(--text)}
.tl .tst .seg button.on{color:var(--accent)}
.tl .tst table.chatgrid .num{display:table-cell;background:none;border-radius:0;border-top:0;border-left:0}
.tl .tst table.chatgrid .num span{font-size:inherit;color:inherit}
.tl .tst table.chatgrid td.num .grip{color:var(--line2);font-size:12px}
.tl .tst table.chatgrid th{color:var(--text)}
.tl .tst .rowx{height:auto;min-height:0;line-height:1.2;display:inline-block;vertical-align:top}
.tl .ratio .rbar{position:static;height:8px;border:0;padding:0;border-radius:4px;overflow:hidden}
` + LAB_CSS_4;
