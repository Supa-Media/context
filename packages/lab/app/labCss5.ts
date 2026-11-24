/**
 * The decluttered Lab's styles (mockup https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2
 * 2026-11-16): the top bar's menus (`views/bar/`), the slim sidebar that folds to icons, the canvas's key popover, and
 * the test chat docked under the canvas (`views/canvas/SandboxChat.web.tsx`). Sizes are the app's: 13px text, 12px
 * meta, 11px labels, 28px controls, 30px nav rows. `labCss4.ts` appends it.
 */
import { LAB_CSS_6 } from "./labCss6";
import { LAB_CSS_DOCK } from "./labCssDock";
import { LAB_CSS_CARD } from "./labCssCard";
import { LAB_CSS_WORLD } from "./labCssWorld";
import { LAB_CSS_CHAT } from "./labCssChat";

export const LAB_CSS_5 = String.raw`
.tl .popw{position:relative;display:inline-flex}
.tl .popm{position:fixed;z-index:60;min-width:240px;max-width:min(360px,calc(100vw - 16px));max-height:min(440px,calc(100vh - 60px));overflow:auto;background:var(--page);border:1px solid var(--line2);border-radius:12px;box-shadow:var(--shadow);padding:6px;font-size:13px;color:var(--text);text-align:left;font-style:normal;font-weight:400;white-space:normal}
.tl .vmenu{display:flex;flex-direction:column}
.tl .vmenu .mh{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:8px 10px 4px}
.tl .vmenu .mi{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;margin:0;text-align:left;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;color:var(--text);text-decoration:none}
.tl .vmenu .mi:before{content:none}
.tl .vmenu .mi:hover,.tl .vmenu .mi[aria-current=true]{background:var(--s3)}
.tl .vmenu .mi:disabled{opacity:.45;cursor:default}
.tl .vmenu .mi .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .vmenu .mi .meta{margin-left:auto;color:var(--dim);font-size:12px;white-space:nowrap}
.tl .vmenu .mi .tag{margin-left:auto;font-size:11px;color:var(--accent);font-weight:600}
.tl .vmenu hr{border:none;border-top:1px solid var(--line);margin:5px 4px;width:auto}
.tl .vmenu .mnote{font-size:12px;color:var(--muted);padding:4px 10px 8px}
.tl .vmenu .mrow{display:flex;align-items:center;gap:8px;padding:4px 8px}
.tl .vmenu .vren,.tl .vmenu input[type=search]{flex:1;min-width:0;width:100%;height:28px;border:1px solid var(--line2);border-radius:8px;background:var(--s2);padding:0 10px;font-size:13px;color:var(--text)}
.tl .vmenu input[type=search]{flex:none;margin:2px 0 4px}
.tl .vmenu .mchanges{max-height:220px;overflow:auto}
.tl .vmenu .clashes{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto}
.tl .vmenu .clash{padding:2px 4px}
.tl .vmenu .clash .cw{font-size:12px;color:var(--text2);padding:2px 6px 0;overflow-wrap:anywhere}
.tl .vmenu .clash .seg button{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 6px}
.tl .vmenu .seg{background:none;gap:4px;padding:4px 6px;flex-wrap:nowrap}
.tl .vmenu .seg button{flex:1;border:1px solid var(--line);background:none;border-radius:7px;padding:6px 0;color:var(--text2);font-size:12px;box-shadow:none}
.tl .vmenu .seg button[aria-checked=true],.tl .vmenu .seg button[aria-selected=true],.tl .vmenu .seg button[aria-pressed=true]{background:var(--accent-dim);color:var(--accent);border-color:transparent}
.tl .chipbtn .car{color:var(--dim);font-size:11px}
.tl .chipbtn .cwho{color:var(--muted);font-size:12px}
.tl .score{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:7px;border:none;background:var(--ok-wash);color:var(--ok);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.tl .score small{font-weight:500;color:var(--muted);font-size:12px}
.tl .labrun{display:inline-flex;align-items:center;gap:8px}
.tl .split{display:inline-flex}
.tl .split .primary{border-radius:7px 0 0 7px;white-space:nowrap}
.tl .split .popw .primary.more{border-radius:0 7px 7px 0;border-left:1px solid color-mix(in srgb,var(--page) 30%,transparent);padding:0 9px}
.tl .bar .dot{background:var(--warn)}

/* The slim sidebar: five pages, folding to icons. */
.tl .body.labnav{grid-template-columns:200px minmax(0,1fr)}
.tl .body.labnav.props{grid-template-columns:200px minmax(0,1fr) 320px}
.tl .body.labnav.props.wide{grid-template-columns:200px minmax(0,1fr) 420px}
.tl .body.labnav.navmin{grid-template-columns:48px minmax(0,1fr)}
.tl .body.labnav.navmin.props{grid-template-columns:48px minmax(0,1fr) 320px}
.tl .body.labnav.navmin.props.wide{grid-template-columns:48px minmax(0,1fr) 420px}
.tl .labnav .side{display:flex;flex-direction:column;gap:2px;padding:10px 8px;overflow-x:hidden}
.tl .labnav .side .rowi{height:30px;min-height:30px;padding:0 8px;white-space:nowrap;overflow:hidden;color:var(--text2)}
.tl .labnav .side .rowi[aria-current=true]{background:var(--page);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.06);font-weight:500}
.tl .labnav .side .rowi .tag{margin-left:auto;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.tl .labnav.navmin .side .rowi .nm,.tl .labnav.navmin .side .rowi .tag{display:none}
.tl .labnav.navmin .side{padding:10px 6px}
.tl .labnav .sidefoot{margin-top:auto}
/* The architectures under Architecture (Texting, Nightly, Search): indented rows with their own icon; folded, icons only. */
.tl .labnav .archpages{display:flex;flex-direction:column;gap:2px}
.tl .labnav .side .rowi.archpage{padding-left:30px}
.tl .labnav .side .rowi.archpage .i{width:15px;height:15px}
.tl .labnav.navmin .side .rowi.archpage{padding-left:8px}
.tl .pageempty{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:340px;text-align:center;font-size:13px;color:var(--dim);pointer-events:none}

/* The canvas key, opened from the toolbar's ?. */
.tl .keyw.keypop{flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:2px;position:absolute;top:auto;left:50%;bottom:calc(64px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:30;width:min(420px,calc(100% - 24px));padding:8px 10px}
.tl .keyw.keypop>span{padding:3px 0}
.tl .keyw.keypop svg{width:44px}

/* The test chat docked under the canvas. */
.tl .sbx{height:300px;transition:height .2s}
.tl .sbx.min{height:auto}
.tl .sbx .tst.tgrid .ph{flex-wrap:wrap;align-items:center}
.tl .sbx .dtitle{font-size:13px}
.tl .sbx .ph .ib{border:none;background:none}
.tl .sbx .ph .ib:hover{background:var(--s3)}
.tl .sbx .ph .chipbtn{height:28px}
.tl .sbx .ph .ghost{height:26px}
.tl .tst.tgrid td.ac{width:1%;padding:4px}
.tl .tst.tgrid td.ac button{border:none;background:none;color:var(--muted);padding:2px 5px;border-radius:5px;font-size:12px;opacity:.45;margin:0}
.tl .tst.tgrid tr:hover td.ac button,.tl .tst.tgrid td.ac button.play{opacity:1}
.tl .tst.tgrid td.ac button:hover{background:var(--s3);color:var(--text)}
.tl .tst.tgrid td.ac button:disabled{opacity:.3;cursor:default}
.tl .tst.tgrid td.ac .play{color:var(--accent);position:relative;min-width:22px;font-variant-numeric:tabular-nums}
.tl .tst.tgrid td.ac .play.stale::after{content:"";position:absolute;top:1px;right:0;width:6px;height:6px;border-radius:50%;background:var(--warn)}
.tl .tst.tgrid td.txt .q{display:block;font-size:12px;color:var(--muted);border-left:2px solid var(--line2);padding-left:6px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:380px}
.tl .tst.tgrid td.txt .pics{display:flex;gap:4px;margin-top:3px}
.tl .tst.tgrid td.txt img,.tl .sbx .pend img{height:40px;width:40px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
.tl .tst.tgrid td.txt .rx{display:inline-flex;gap:3px;margin-left:6px;font-size:12px}
.tl .tst.tgrid td.txt .rx span{background:var(--s3);border-radius:9px;padding:0 5px}
.tl .tst.tgrid td.txt .ed{font-size:11px;color:var(--dim);margin-left:4px}
.tl .tst.tgrid td.txt.evt{color:var(--muted);font-style:italic}
.tl .tst.tgrid td.txt .medit{width:100%;height:26px;border:1px solid var(--accent);border-radius:6px;background:var(--page);padding:0 6px;font-size:13px}
.tl .tst.tgrid td.txt .popw{vertical-align:1px}
.tl .mopt{border:1px solid var(--line);background:var(--page);color:var(--muted);border-radius:6px;padding:0 6px;margin-left:6px;font-size:12px;line-height:18px;opacity:0}
.tl tr:hover .mopt,.tl .mopt:focus-visible,.tl .mopt[aria-expanded=true]{opacity:1}
.tl .mopt:hover{color:var(--text);border-color:var(--line2)}
.tl .taps{display:flex;gap:2px;padding:4px}
.tl .taps button{border:none;background:none;font-size:19px;padding:4px 6px;border-radius:6px;line-height:1}
.tl .taps button:hover{background:var(--s3)}
.tl .taps button:disabled{opacity:.4;cursor:default}
.tl .sbx .pend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 12px 0}
.tl .sbx .pend .chip{display:inline-flex;align-items:center;gap:6px;background:var(--accent-dim);color:var(--accent);border-radius:7px;padding:3px 8px;font-size:12px;max-width:360px}
.tl .sbx .pend .chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .sbx .pend .chip button,.tl .sbx .pend .th button{border:none;background:none;color:inherit;padding:0 2px}
.tl .sbx .pend .th{position:relative;display:inline-flex;align-items:center;gap:2px}
.tl .sbc{gap:8px;padding:8px 12px;align-items:center;border-top:none}
.tl .sbc .lbl{font-size:12px;color:var(--muted)}
.tl .sbc select{height:30px;padding:0 8px;max-width:150px;border-radius:7px;font-size:13px}
.tl .sbc input{height:30px;padding:0 12px;border-radius:7px}
.tl .sbc .ib{border:none;background:none}
.tl .sbc .ib:hover{background:var(--s3)}
.tl .sbc .primary{height:30px}
.tl .vmenu.chatpick{width:320px;max-width:100%}
.tl .vmenu.sbwrites .wr{display:flex;gap:8px;font-size:12px;padding:5px 10px}
.tl .vmenu.sbwrites .wr .k{color:var(--warn);font-weight:600}
@media (max-width:820px){
  .tl .body.labnav,.tl .body.labnav.props,.tl .body.labnav.props.wide,.tl .body.labnav.navmin,.tl .body.labnav.navmin.props,.tl .body.labnav.navmin.props.wide{grid-template-columns:minmax(0,1fr)}
  .tl .labnav.navmin .side .rowi .nm,.tl .labnav.navmin .side .rowi .tag{display:revert}
  .tl .hide-s{display:none}
  .tl .bar{gap:6px;padding:0 8px}
  .tl .bar .modes button{padding:3px 7px}
  .tl .bar #verBtn{max-width:96px}
  .tl .bar #verBtn .car{display:none}
  .tl .sbx .ph .sbxtag{display:none}
  .tl .keyw.keypop{display:flex}
  .tl .score small{display:none}
}
@media (max-width:420px){.tl .hide-xs{display:none}.tl .bar .modes button{padding:3px 6px}}
` + LAB_CSS_6 + LAB_CSS_DOCK + LAB_CSS_CARD + LAB_CSS_WORLD + LAB_CSS_CHAT;
