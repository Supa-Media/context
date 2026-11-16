/**
 * The shared text grid's styles (`views/grid/TextGrid.web.tsx`): Testing's grid (`labCss3.ts`) laid out as a panel
 * for the Architecture test chat and Replay's list, plus the step-output cells. `labCss3.ts` appends it.
 */
import { LAB_CSS_5 } from "./labCss5";

export const LAB_CSS_4 = String.raw`
.tl .tst.tgrid{display:flex;flex-direction:column;gap:0;padding:0;height:100%;min-height:0;background:var(--page);font-size:12px}
.tl .tst.tgrid .ph{padding:6px 10px;gap:6px}
.tl .tst.tgrid .scroll{overflow:auto;min-height:0;flex:1}
.tl .tst.tgrid tr.mr{cursor:pointer}
.tl .tst.tgrid td.o{white-space:nowrap;font-size:11px}
.tl .tst.tgrid td.o .tm{display:block;color:var(--muted);font-family:var(--mono);font-size:10px}
.tl .tst.tgrid td.o.hot{background:var(--accent-dim)}
.tl .tst.tgrid td.o.on{box-shadow:inset 0 0 0 2px var(--accent)}
.tl .tst.tgrid td.o.bad{color:var(--bad)}
.tl .tst.tgrid tr.prod td{color:var(--muted)}
.tl .tst.tgrid tr.prod td .texwho{color:color-mix(in srgb,var(--accent) 60%,var(--muted))}
.tl .tst.tgrid tr.test td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
.tl .tst.tgrid tr.sepr td{background:color-mix(in srgb,var(--warn) 12%,var(--page));color:var(--warn);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px}
.tl .tst.tgrid tr.sepr.day td{background:none;color:var(--muted);text-align:center;font-weight:500;letter-spacing:0;text-transform:none;font-size:11px}
.tl .tst.tgrid td.ac{white-space:nowrap}
.tl .tst.tgrid td.ac button{border:1px solid var(--line2);background:var(--page);border-radius:6px;font-size:11px;padding:0 6px;margin-right:2px;line-height:18px}
.tl .tst.tgrid .texcell{background:none}
.tl .rmoments:has(.tgrid){overflow:hidden}
.tl .rmoments .tst.tgrid{flex:1;height:auto;border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.tl .rmoments .tst.tgrid .ph:empty{display:none}
.tl .archsplit{position:absolute;inset:0;display:flex;flex-direction:column}
.tl .archcv{position:relative;flex:1;min-height:200px;overflow:hidden}
.tl .sbx{flex:0 0 auto;height:min(330px,42%);display:flex;flex-direction:column;border-top:1px solid var(--line);background:var(--page);min-height:0}
.tl .sbx .tst.tgrid{flex:1;height:auto}
.tl .sbx .tst.tgrid select{padding:3px 6px;font-size:12px}
.tl .sbxtag{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--page));border-radius:999px;padding:2px 8px}
.tl .sbx .sbwrites{left:0;right:auto;width:340px}
.tl .sbx .sbwrites .wr{display:flex;gap:8px;font-size:12px;border:1px solid var(--line2);border-radius:8px;padding:5px 8px}
.tl .sbx .sbwrites .wr .k{color:var(--warn);font-weight:600}
.tl .sbc{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line2)}
.tl .sbc select,.tl .sbc input{border:1px solid var(--line2);border-radius:8px;padding:6px 8px;background:var(--page);color:var(--text);font:inherit;font-size:13px}
.tl .sbc input{flex:1;min-width:0}
.tl .sbc .btn{border:1px solid var(--line2);background:var(--page);border-radius:8px;padding:6px 12px}
.tl .sbc .btn.p{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.tl .sbc .btn:disabled{opacity:.5}
.tl .runctl{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:8px}
.tl .runctl select,.tl .labrun select{border:1px solid var(--line2);border-radius:8px;padding:4px 6px;background:var(--page);color:var(--text);font:inherit;font-size:12px}
.tl .runctl .btn,.tl .labrun .btn{border:1px solid var(--line2);background:var(--page);border-radius:8px;padding:3px 9px;font-size:12px;color:var(--text);display:inline-flex;gap:5px;align-items:center}
.tl .runctl .btn.p,.tl .labrun .btn.p{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.tl .labrun{display:inline-flex;gap:6px;align-items:center;font-size:12px;margin-left:6px}
.tl .labrun a{color:var(--accent)}
.tl .tst .pill,.tl .labrun .pill,.tl .runctl .pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap}
.tl .pill.q{background:var(--s3);color:var(--muted)}.tl .pill.r{background:var(--accent-dim);color:var(--accent)}.tl .pill.d{background:color-mix(in srgb,var(--ok) 14%,var(--page));color:var(--ok)}.tl .pill.f{background:color-mix(in srgb,var(--bad) 14%,var(--page));color:var(--bad)}
.tl .spin{width:9px;height:9px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:tlsp .8s linear infinite;display:inline-block}
@keyframes tlsp{to{transform:rotate(360deg)}}


.tl .tst tr.try td{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--warn) 10%,transparent) 6px 12px)}
.tl .tst tr.try.sel td{box-shadow:inset 0 0 0 1px var(--warn)}
.tl .tst .trytag{font-size:10px;font-weight:700;color:var(--warn);letter-spacing:.04em;text-transform:uppercase;margin-right:4px}
.tl .tst .compose{border-top:1px solid var(--line2);padding:8px;display:flex;gap:6px;flex-wrap:wrap}
.tl .tst .compose input{flex:1;min-width:160px;border:1px solid var(--line2);border-radius:8px;padding:7px 9px;background:var(--page);color:var(--text);font:inherit}
.tl .tst .steps{display:flex;flex-direction:column;gap:4px}
.tl .tst .step{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:6px;align-items:start;font-size:12px;border:1px solid var(--line2);border-radius:7px;padding:5px 7px}
.tl .tst .step .tm{color:var(--muted);font-family:var(--mono);font-size:11px}
.tl .tst .runrow{border:1px solid var(--line2);border-radius:9px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;text-align:left;background:var(--page);width:100%}
.tl .tst .runrow.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.tl .tst .runrow .l1{display:flex;gap:6px;align-items:center;justify-content:space-between}
.tl .tst .mcp{font-family:var(--mono);font-size:11px;background:var(--s3);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-word}
.tl .tst .miss{font-size:12px;border-left:3px solid var(--bad);padding:2px 0 2px 8px}
.tl .tst .pernode{display:inline-block;margin-right:8px}
.tl .tst #runsPanel,.tl .tst #tryPanel{overflow:auto}
` + LAB_CSS_5;
