/**
 * The test chat dock of the Lab live sandbox (mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5, approved by
 * Dev2 2026-11-16): the grip on its top edge, the Grid | Timeline switch, the Timeline (`views/canvas/
 * SandboxTimeline.web.tsx`) at its three densities, and the canvas's run pill. The Lab's compact scale: 13px text, 12px
 * meta, 28px controls. Names are `sb`-prefixed: the Lab's root is `.tl` and its top bar `.bar`. `labCss5.ts` appends it.
 */
export const LAB_CSS_DOCK = String.raw`
.tl .sbx{position:relative;height:340px;max-height:calc(100% - 120px)}
.tl .sbx.drag{transition:none}
.tl .sbgrip{position:absolute;top:-5px;left:0;right:0;height:10px;cursor:ns-resize;z-index:6;display:grid;place-items:center;touch-action:none}
.tl .sbgrip::after{content:"";width:40px;height:4px;border-radius:2px;background:var(--line2)}
.tl .sbgrip:hover::after,.tl .sbx.drag .sbgrip::after{background:var(--accent)}
.tl .sbx.min .sbgrip{display:none}
.tl .dockseg{display:flex;background:var(--chip);border-radius:7px;padding:2px}
.tl .dockseg button{border:none;background:none;padding:2px 9px;border-radius:5px;font-size:12px;color:var(--muted);font-weight:500;height:24px}
.tl .dockseg button[aria-pressed=true]{background:var(--page);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.tl .sbx .tst.tgrid .sbtl{flex:1;min-height:0}
.tl .sbtl{background:var(--page);display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tl .sbtlh{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted);flex-wrap:wrap}
.tl .sbtlh .ib{border:none;background:none}
.tl .sbtlh .ib:hover{background:var(--s3)}
.tl .sbtlh select{height:26px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:0 6px;font-size:12px;max-width:280px;font-weight:600;color:var(--text)}
.tl .sbtlh .k.of{color:var(--accent)}
.tl .sbtlh .k.prod{color:var(--warn)}
.tl .sbtlh input[type=range]{flex:1;min-width:120px}
.tl .sbtlh .t{font-family:var(--mono);font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}
.tl .sbtracks{overflow-y:auto;overflow-x:hidden;position:relative;padding:4px 16px 8px 12px;min-width:0;min-height:0}
.tl .sbtin{position:relative}
.tl .sbtrk{display:grid;grid-template-columns:118px minmax(0,1fr);align-items:center;height:20px;gap:8px;cursor:pointer}
.tl .sbtrk[hidden]{display:none}
.tl .sbtrk .nm{font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl .sbtrk.dlv .nm{color:var(--ok)}
.tl .sbtrk.sel .nm{color:var(--accent);font-weight:600}
.tl .sblane{position:relative;height:14px}
.tl .sbtb{position:absolute;top:2px;height:10px;border-radius:3px;background:color-mix(in srgb,var(--accent) 55%,transparent);min-width:3px;cursor:pointer}
.tl .sbtb.bad{background:color-mix(in srgb,var(--bad) 55%,transparent)}
.tl .sbtb.msg{background:var(--ok);width:3px;height:14px;top:0}
.tl .sbtb.selb{outline:1.5px solid var(--text);outline-offset:0}
.tl .sbtracks.compact .sbtrk{height:12px}
.tl .sbtracks.compact .sbtrk .nm{font-size:10px;line-height:12px}
.tl .sbtracks.compact .sblane{height:8px}
.tl .sbtracks.compact .sbtb{top:1px;height:6px}
.tl .sbtracks.compact .sbtb.msg{top:0;height:8px}
.tl .sbtracks.packed{padding-top:2px}
.tl .sbtracks.packed .sbtrk{grid-template-columns:minmax(0,1fr);height:15px;gap:0}
.tl .sbtracks.packed .sblane{height:13px}
.tl .sbtracks.packed .sbtb{top:0;height:13px;font-size:10px;line-height:13px;color:var(--text);padding:0 3px;overflow:hidden;white-space:nowrap;text-overflow:clip;box-sizing:border-box}
.tl .sbtracks.packed .sbtb.msg{height:13px;padding:0}
.tl .sbhead{position:absolute;top:0;bottom:0;width:2px;background:var(--bad);pointer-events:none}
.tl .sbtracks .scne{padding:16px 4px;color:var(--muted);font-size:12px}
.tl .archcv .runpill{bottom:12px;left:12px;padding:3px 10px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;max-width:calc(50% - 185px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:4}
.tl .archcv .runpill b{color:var(--text);font-weight:600}
.tl .archcv .runpill .rp{color:var(--warn);font-weight:600}
.tl .vmenu .mi .aib{font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--accent);background:var(--accent-dim);border-radius:5px;padding:1px 5px}
.tl td.ac .play[data-play-tex]{color:var(--accent)}
.tl td.ac .play[data-play-prod]{color:var(--warn)}
.tl .archcv .runnote{top:12px;left:50%;transform:translateX(-50%);padding:4px 10px;font-size:12px;color:var(--warn);max-width:calc(100% - 24px);z-index:4}
.tl .proddet{border-top:1px solid var(--line);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:8px}
@media (max-width:760px){.tl .archcv .runpill{display:none}}
`;
