/**
 * Several steps picked at once and Make component (Dev, 2026-11-27; artboard /lab-new-component-artboards, its
 * `kit/board2.css`): the Shift-drag box, the bar above the toolbar, the Name and Goal popover, a new component's
 * reference card and sidebar dot, and the toast's Undo. `labCss5.ts` appends it.
 */
export const LAB_CSS_MULTI = String.raw`
.tl .mbox{position:absolute;z-index:2;border:1px solid var(--accent);background:var(--accent-dim);pointer-events:none}
.tl .mbar{left:50%;bottom:calc(62px + env(safe-area-inset-bottom,0px));z-index:4;transform:translateX(-50%);gap:2px;padding:4px;flex-wrap:wrap;max-width:min(420px,calc(100% - 32px));white-space:nowrap}
.tl .mbar .mcount{font-size:13px;color:var(--text2);padding:0 8px 0 10px;font-variant-numeric:tabular-nums}
.tl .mbar .sep{width:1px;height:20px;background:var(--line);margin:0 2px}
.tl .mbar .mmake{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:none;border-radius:8px;background:none;color:var(--text);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.tl .mbar .mmake:hover,.tl .mbar .mmake.on{background:var(--chip)}
.tl .mbar .mmake .dia{width:15px;height:15px;fill:color-mix(in srgb,var(--comp) 14%,transparent);stroke:var(--comp);stroke-width:1.8}
.tl .mbar .mkbd{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--dim);margin-left:4px;letter-spacing:.04em}
.tl .mbar .mmake[aria-disabled=true]{color:var(--dim);cursor:default;background:none}
.tl .mbar .mmake[aria-disabled=true] .dia{stroke:var(--dim);fill:none}
.tl .mbar .mx{width:30px;height:30px;color:var(--muted);border:none;background:none}
.tl .mbar .mx .i{width:14px;height:14px}
.tl .mbar .mwhy{flex-basis:100%;font-size:12px;color:var(--muted);padding:6px 10px 4px;border-top:1px solid var(--line);margin-top:4px;white-space:normal;contain:inline-size}
.tl .mbar .mwhy b{color:var(--text);font-weight:600}
.tl .mpop{position:absolute;z-index:5;left:calc(50% + 20px);bottom:calc(112px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:300px;max-width:calc(100% - 32px);box-sizing:border-box;background:var(--page);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:12px;display:flex;flex-direction:column;gap:10px}
.tl .mpop .mf{display:flex;flex-direction:column;gap:4px}
.tl .mpop .mf>span{font-size:12px;color:var(--muted);font-weight:500}
.tl .mpop .mf small{font-size:11px;color:var(--dim);font-weight:400;margin-left:4px}
.tl .mpop input{height:32px;box-sizing:border-box;width:100%;border:1px solid var(--line2);border-radius:8px;background:var(--page);color:var(--text);padding:0 10px;font:inherit;font-size:13px;outline:none;text-overflow:ellipsis}
.tl .mpop input::placeholder{color:var(--dim)}
.tl .mpop input:focus{border:2px solid var(--accent);padding:0 9px}
.tl .mpop .mfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.tl .mpop .mfrom{font-size:12px;color:var(--dim)}
.tl .mpop .primary{border-radius:8px;height:30px;padding:0 14px}
.tl .gref .chgo{fill:var(--chg-wash);stroke:var(--chg);stroke-width:2;pointer-events:none}
.tl .labnav .side .rowi .cdot{width:6px;height:6px;border-radius:50%;background:var(--chg);margin-left:auto;flex:none}
.tl .labnav .side .rowi .cdot+.tag{margin-left:8px}
.tl .labnav.navmin .side .rowi .cdot{display:none}
.tl .toast .tundo{margin-left:10px;padding:0;border:none;background:none;color:inherit;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
`;
