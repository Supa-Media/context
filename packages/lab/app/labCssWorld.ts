/**
 * Made-up group chats in the Lab (Dev, 2026-11-24, approved artboards 01 to 05 of `group-chat-sim-artboards/`,
 * ported from its `kit/board.html`): the picker's Made-up chats tab in two columns, the setup in the dock (people
 * table, settings, footer), the people strip with "Tex can see" pinned over the chat, avatars by account (on Context
 * filled, not on Context dashed, invited by number purple), and the person and Add someone menus. Lab tokens only.
 * `labCss5.ts` appends it.
 */
export const LAB_CSS_WORLD = String.raw`
/* ---------- New: people strip under the dock head ---------- */
.tl .gstrip{display:flex;flex-direction:column;gap:5px;padding:6px 10px 7px;border-bottom:1px solid var(--line2);background:var(--page)}
.tl .gstrip .gr{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:nowrap}
.tl .gstrip .lbl{font-size:12px;color:var(--dim);margin-right:2px;white-space:nowrap}
.tl .pchip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px 0 4px;border-radius:999px;background:var(--chip);border:1px solid transparent;font-size:12px;color:var(--text);white-space:nowrap}
.tl .pchip:hover,.tl .pchip[aria-expanded=true]{border-color:var(--line2)}
.tl .pchip[aria-expanded=true]{background:var(--s3)}
.tl .pchip .pm{color:var(--dim);font-size:11px}
.tl .pchip .pm.in{color:var(--accent);font-weight:600}
.tl .pchip.new{box-shadow:0 0 0 1.5px var(--chg) inset;background:var(--chg-wash)}
.tl .pchip.new .pm{color:var(--chg);font-weight:600}
.tl .addp{height:28px;border-radius:999px;border:1px dashed var(--line2);background:none;color:var(--text2);font-size:12px;padding:0 10px;white-space:nowrap}
.tl .av{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;font-size:10px;font-weight:700;flex:none;position:relative}
.tl .av.on{background:var(--accent);color:var(--page)}
.tl .av.off{border:1.5px dashed var(--dim);color:var(--muted);background:var(--page)}
.tl .av.inv{border:1.5px solid var(--team);color:var(--team);background:var(--page)}
.tl .av.inv::after{content:"";position:absolute;right:-3px;bottom:-3px;width:8px;height:8px;border-radius:50%;background:var(--team);border:1.5px solid var(--page)}
.tl .gstrip .end{margin-left:auto;display:flex;align-items:center;gap:6px}
.tl .gstrip .chipbtn{height:26px;font-size:12px}
.tl .gstrip .chipbtn .k{color:var(--dim)}
/* Tex can see: one chip per shared workspace, then the chat's own notes */
.tl .wsr{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;font-size:12px;white-space:nowrap;border:1px solid var(--line2);color:var(--text)}
.tl .wsr .d{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.tl .wsr .s{color:var(--muted)}
.tl .wsr.ro .d{background:var(--ok);box-shadow:none}
.tl .wsr.out{border-style:dashed;color:var(--muted)}
.tl .wsr.out .d{background:none;border:1.5px solid var(--dim);width:5px;height:5px}
.tl .wsr.out .s b{font-weight:600;color:var(--text2)}
.tl .wsr.home{background:var(--ok-wash);border-color:transparent}
.tl .wsr.chg{border:1.5px solid var(--chg);background:var(--chg-wash);color:var(--text)}
.tl .wsr.chg .was{color:var(--chg);font-weight:600;margin-left:2px}
.tl .sbx .ph #sbChat{max-width:380px}
.tl .gstrip .bill{font-size:12px;color:var(--dim);white-space:nowrap}

/* ---------- New: the why line under each text ---------- */
.tl .tst.tgrid td.txt .why{display:flex;align-items:baseline;gap:6px;margin-top:2px;font-size:11.5px;line-height:1.35;color:var(--muted);font-style:normal}
.tl .tst.tgrid td.txt .why .v{font-weight:600;white-space:nowrap}
.tl .tst.tgrid td.txt .why.yes .v{color:var(--accent)}
.tl .tst.tgrid td.txt .why.no .v{color:var(--text2)}
.tl .tst.tgrid td.txt .why.no .v::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--dim);margin-right:5px;vertical-align:0}
.tl .tst.tgrid td.txt .why.yes .v::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:5px;vertical-align:0}
.tl .tst.tgrid td.txt .why .r{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .tst.tgrid td.txt .why .by{flex:none;margin-left:auto;font-size:10.5px;color:var(--dim);border:1px solid var(--line2);border-radius:5px;padding:0 5px;white-space:nowrap;font-weight:500}
.tl .tst.tgrid td.txt .chgl{display:block;margin-top:3px;font-style:normal;font-size:12px;color:var(--text);background:var(--chg-wash);border-left:3px solid var(--chg);border-radius:0 6px 6px 0;padding:3px 8px}
.tl .tst.tgrid td .gl{display:block;font-family:var(--mono);font-size:10.5px;color:var(--dim);font-weight:400;margin-top:1px}
.tl .tst.tgrid td[data-c=who] .av{margin-right:6px;vertical-align:-5px;width:18px;height:18px;font-size:9px}
.tl .tst.tgrid tr.mr.evr td{background:color-mix(in srgb,var(--chg-wash) 40%,var(--page))}
.tl .tst.tgrid tr.mr.evr td.txt{color:var(--text2)}
.tl .tst.tgrid td.o .muted{color:var(--dim)}
.tl .tst.tgrid td.o.qu{color:var(--muted)}
.tl .tst.tgrid td.o.an{color:var(--accent);font-weight:600}

/* ---------- New: setup view in the dock ---------- */
.tl .gset{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 440px;border-top:1px solid var(--line);overflow:hidden}
.tl .gset .gl{padding:12px 16px;overflow:auto;border-right:1px solid var(--line2)}
.tl .gset .gr2{padding:12px 16px;overflow:auto;background:var(--s2)}
.tl .gset h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--text);display:flex;align-items:baseline;gap:8px}
.tl .gset h4 span{font-weight:400;color:var(--dim);font-size:12px}
.tl .ptab{table-layout:fixed;width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
.tl .ptab th{font-size:11px;font-weight:500;color:var(--dim);text-align:left;padding:0 6px 6px;white-space:nowrap}
.tl .ptab td{padding:4px 6px;border-top:1px solid var(--line);vertical-align:middle;white-space:nowrap}
.tl .ptab td.nm{display:flex;align-items:center;gap:8px;min-height:36px}
.tl .ptab td.nm b{font-weight:600}
.tl .ptab td.nm .ph2{color:var(--dim);font-family:var(--mono);font-size:11px}
.tl .ptab select{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:0 6px;font-size:12px;color:var(--text);width:100%}
.tl .ptab select.none{color:var(--dim);border-style:dashed}
.tl .ptab .xb{border:none;background:none;color:var(--dim);font-size:13px;width:24px;height:24px;border-radius:6px}
.tl .ptab tr.sel td{background:var(--accent-dim)}
.tl .ptab .bt{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);background:var(--accent-dim);border-radius:5px;padding:1px 5px}
.tl .gset .seeline{margin-top:12px;padding:10px 12px;border:1px solid var(--line2);border-radius:10px;background:var(--page)}
.tl .gset .seeline .lbl{font-size:12px;color:var(--dim);margin-bottom:6px;display:block}
.tl .gset .seeline .chips{display:flex;flex-wrap:wrap;gap:6px}
.tl .gset .seeline .rule{font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.45}
.tl .gset .addrow{margin-top:8px}
.tl .fset{display:grid;grid-template-columns:84px minmax(0,1fr);gap:12px 12px;align-items:start;font-size:12.5px}
.tl .fset>label{color:var(--text2);padding-top:5px}
.tl .fset select,.tl .fset input{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:0 8px;font-size:12.5px;color:var(--text);width:100%}
.tl .fset .tip{display:block;font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.4}
.tl .tst .fset .seg{display:flex;background:var(--chip);padding:2px;border-radius:8px;gap:2px;flex-wrap:nowrap}
.tl .tst .fset .seg button{flex:1 1 auto;min-width:0;border:none;background:none;padding:5px 6px;font-size:11.5px;border-radius:6px;white-space:nowrap;color:var(--muted)}
.tl .tst .fset .seg button[aria-pressed=true]{background:var(--page);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.tl .gfoot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--line2);background:var(--page)}
.tl .gfoot .from{font-size:12px;color:var(--muted)}
.tl .gfoot .from b{color:var(--text);font-weight:600}
.tl .gfoot .primary{color:var(--page)}
.tl .gfoot .sp{flex:1}
.tl .gfoot .fnote{font-size:12px;color:var(--dim)}

/* ---------- New: made-up chats tab of the picker ---------- */
.tl .popm.wide{width:420px;max-width:420px;max-height:none}
.tl .vmenu .mi.two{align-items:flex-start;padding:5px 8px;min-height:40px}
.tl .vmenu .mi.two .tx{flex:1;min-width:0;display:flex;flex-direction:column}
.tl .vmenu .mi.two .nm{flex:none}
.tl .vmenu .mi.two .ds{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl .vmenu .mi.two .meta{padding-top:1px}
.tl .vmenu .mi .avs{display:inline-flex;margin-top:1px;flex:none}
.tl .vmenu .mi .avs .av{width:16px;height:16px;font-size:8px;margin-left:-5px;box-shadow:0 0 0 1.5px var(--page)}
.tl .vmenu .mi .avs .av:first-child{margin-left:0}
.tl .vmenu .mi.newg{color:var(--accent);font-weight:600}
.tl .vmenu .mi.newg .plus{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:var(--accent-dim);font-size:14px;font-weight:600}
.tl .vmenu .mi.newg .meta{font-weight:400}
/* the person menu */
.tl .vmenu .phead{display:flex;align-items:center;gap:8px;padding:6px 8px 4px}
.tl .vmenu .phead b{font-size:13px}
.tl .vmenu .phead .meta{margin-left:auto;color:var(--dim);font-size:12px}
.tl .vmenu .mi .rl{margin-left:auto;font-size:12px;color:var(--text2)}
.tl .vmenu .mi .rl.no{color:var(--dim)}
.tl .vmenu .mi.danger{color:var(--bad)}
.tl .vmenu .addf{display:grid;grid-template-columns:88px minmax(0,1fr);gap:6px 8px;align-items:center;padding:4px 8px;font-size:12.5px}
.tl .vmenu .addf label{color:var(--text2)}
.tl .vmenu .addf input,.tl .vmenu .addf select{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--s2);padding:0 8px;font-size:12.5px;color:var(--text);width:100%}
.tl .vmenu .addft{display:flex;justify-content:flex-end;gap:6px;padding:6px 8px 4px}
.tl .vmenu .prev{margin:4px 8px;padding:7px 9px;border-radius:8px;background:var(--chg-wash);font-size:12px;line-height:1.45;color:var(--text)}
.tl .vmenu .prev b{font-weight:600}

/* picker, two columns */
.tl .popm:has(> .chatpick.wide){width:660px;max-width:min(660px,calc(100vw - 16px));max-height:none;padding:8px}
.tl .vmenu.chatpick{width:auto}
.tl .vmenu.chatpick .seg button{white-space:nowrap}
.tl .vmenu .ptop{display:contents}
.tl .vmenu.wide .ptop{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;padding:2px 0}
.tl .vmenu .ptop input[type=search]{margin:0}
.tl .vmenu .ptop .mi .vren{width:auto;flex:1}
.tl .vmenu .mh.hx{white-space:nowrap;display:flex;align-items:baseline;gap:10px}
.tl .vmenu .mh.hx span{text-transform:none;letter-spacing:0;font-size:12px;color:var(--muted)}
.tl .vmenu .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:2px 6px}
.tl .vmenu .mi.two .side2{display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-left:auto;flex:none}
.tl .dts{display:inline-flex;gap:3px}
.tl .dt{display:inline-block;width:9px;height:9px;border-radius:50%;box-sizing:border-box}
.tl .dt.on{background:var(--accent)}
.tl .dt.off{border:1.5px dashed var(--dim)}
.tl .dt.inv{border:2px solid var(--team)}
.tl .vmenu .legend{display:flex;gap:14px;padding:6px 10px 2px;font-size:11.5px;color:var(--dim)}
.tl .vmenu .legend span{display:inline-flex;align-items:center;gap:5px}
/* the Lab's own */
.tl .pchip{cursor:pointer;font-family:inherit}
.tl .gstrip .gr.see{flex-wrap:wrap;row-gap:4px}
.tl .gstrip .wait{font-size:12px;color:var(--dim)}
.tl .gstrip .then{font-size:12px;color:var(--accent);border:none;background:none;cursor:pointer}
.tl .gset .gl{min-width:0}
.tl .ptab td.nm input{border:1px solid transparent;background:none;font-weight:600;font-size:12.5px;color:var(--text);padding:2px 4px;border-radius:6px;min-width:0;width:100%;font-family:inherit}
.tl .ptab td.nm input:hover,.tl .ptab td.nm input:focus{border-color:var(--line2);background:var(--page)}
.tl .ptab select:disabled{opacity:1;color:var(--dim);border-style:dashed}
.tl .fset textarea{width:100%;min-height:90px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:6px 8px;font:12px/1.45 var(--mono);color:var(--text);margin-top:6px}
.tl .gfoot .bad{color:var(--bad);font-size:12px}
.tl .gfoot a{cursor:pointer}
.tl .gfoot a[aria-disabled=true]{color:var(--dim);cursor:default}
.tl .vmenu .addf .ws3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
.tl .vmenu .addf .ws3 select{padding:0 4px;font-size:11.5px}
.tl .vmenu .mnote .pick{border:none;background:none;color:var(--accent);padding:0;font:inherit;cursor:pointer}
.tl .vmenu .mi.two{height:auto}
.tl .vmenu.chatpick .mnote.code{color:var(--warn)}
`;
