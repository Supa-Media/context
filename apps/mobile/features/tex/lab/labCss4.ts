/**
 * The shared text grid's styles (`views/grid/TextGrid.web.tsx`): Testing's grid (`labCss3.ts`) laid out as a panel
 * for the Architecture test chat and Replay's list, plus the step-output cells. `labCss3.ts` appends it.
 */
export const LAB_CSS_4 = String.raw`
.tl .tst.tgrid{display:flex;flex-direction:column;gap:0;padding:0;height:100%;min-height:0;background:var(--page);font-size:12px}
.tl .tst.tgrid .ph{padding:6px 10px;gap:6px}
.tl .tst.tgrid .scroll{overflow:auto;min-height:0;flex:1}
.tl .tst.tgrid tr.mr{cursor:pointer}
.tl .tst.tgrid td.o{white-space:nowrap;font-size:11px}
.tl .tst.tgrid td.o .tm{display:block;color:var(--muted);font-family:var(--mono);font-size:9.5px}
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
`;
