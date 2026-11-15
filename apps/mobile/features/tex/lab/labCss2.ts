/**
 * The Lab's styles for every step's test cases and a draft's change marks (Dev2, 2026-11-15; design
 * https://claude.ai/artifact/VnAnSNDprEUJ4fFDEmXqhp), kept apart from the artifact's own stylesheet (`labCss.ts`),
 * which appends it. Scoped under `.tl` like the rest.
 */
import { LAB_CSS_3 } from "./labCss3";

export const LAB_CSS_2 = String.raw`
.tl .tlay{grid-template-columns:300px minmax(0,1fr)}
.tl .meter{display:inline-block;height:4px;border-radius:2px;background:var(--s3);overflow:hidden;flex:none}
.tl .meter i{display:block;height:100%;background:var(--accent)}
.tl .anav{min-width:0}.tl .anav button{min-width:0}
.tl .anav .an{flex:1;min-width:0;display:grid}
.tl .anav .an,.tl .anav .an small,.tl .erow .an,.tl .erow small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .anav .ac{min-width:0;flex:none;text-align:right}.tl .anav .pill{flex:none;padding:1px 6px}
.tl .anh.every{font-weight:600;color:var(--text2)}
.tl .anh2{font-size:12px;color:var(--dim);padding:8px 9px 2px}
.tl .anh.nocase{border-top:1px solid var(--line);margin-top:8px;padding-top:12px;text-transform:none;letter-spacing:0}
.tl .anh.nocase b{font-weight:600;color:var(--warn);font-size:12px}
.tl .erow{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;font-size:13.5px}
.tl .erow[aria-current=true]{background:var(--row)}
.tl .erow .an{flex:1;min-width:0;display:grid}.tl .erow small{color:var(--dim);font-size:11.5px}
.tl .addc{flex:none;border:1px dashed var(--line2);background:var(--page);color:var(--accent);border-radius:8px;font-size:12px;font-weight:600;padding:4px 10px;white-space:nowrap}
.tl .addc:hover{background:var(--accent-dim)}.tl .addc[disabled]{opacity:.5}
.tl .addc.wide{width:100%;padding:10px;font-size:13px;border-radius:10px}
.tl .anav .more{color:var(--accent);font-size:12px;font-weight:600;padding:6px 9px;justify-content:flex-start}
.tl .sth{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.tl .sth h2{margin:0;font-size:20px;font-weight:700}
.tl .stc{font-family:var(--mono);font-size:12.5px;color:var(--text2)}
.tl .capb{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:var(--accent-dim);color:var(--accent);font-size:13px;margin-bottom:12px}
.tl .cov{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
.tl .ghost.sm{height:28px;padding:0 9px;font-size:12.5px}
.tl .tc.going{opacity:.55}
.tl .tc.swapin{border-color:var(--warn);background:var(--warn-wash)}
.tl .cid.gone{color:var(--warn);text-decoration:line-through}
.tl .ncases{display:grid;gap:12px}
.tl .nch{display:flex;align-items:center;gap:8px}
.tl .nch .cnt{font-family:var(--mono);font-size:12px;color:var(--dim)}
.tl .nlbl{font-size:12px;font-weight:600;color:var(--text2)}
.tl .ncf{border:1px solid var(--accent);border-radius:12px;padding:14px;display:grid;gap:12px;background:var(--page)}
.tl .ncfh{display:flex;align-items:center;gap:8px}
.tl .ngrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.tl .nfld{display:grid;gap:4px;min-width:0}
.tl .nfld>span{font-family:var(--mono);font-size:12px;color:var(--text2)}.tl .nfld small{font-family:var(--f);color:var(--dim)}
.tl .nfld:has(textarea){grid-column:1/-1}
.tl .nfld input,.tl .nfld textarea,.tl .wrow input{min-width:0;width:100%;box-sizing:border-box}
.tl .wgrid{display:grid;gap:8px}
.tl .wrow{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;align-items:center}
.tl .wn{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.tl .seg{display:flex;background:var(--s3);border-radius:8px;padding:3px;gap:2px;flex-wrap:wrap}
.tl .seg button{flex:1;border:none;background:none;border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text2)}
.tl .seg button[aria-pressed=true]{background:var(--page);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.tl .judge{display:grid;gap:3px}.tl .judge small{color:var(--dim);font-size:11.5px}
.tl .hint.small{font-size:12px}
.tl .tcc rect,.tl .ckc rect{fill:var(--accent-dim);stroke:var(--accent);stroke-width:1}
.tl .tcc text,.tl .ckc text{font:500 10.5px var(--mono);fill:var(--accent)}
.tl .tcc.z rect,.tl .ckc.z rect{fill:var(--page);stroke:var(--warn);stroke-dasharray:3 2}
.tl .tcc.z text,.tl .ckc.z text{fill:var(--warn);font-size:13px;font-weight:600}
.tl .tcc.z{cursor:pointer}.tl .tcc.z:hover rect{fill:var(--warn-wash)}
.tl .nd.chg-same{opacity:.45}
.tl .nd.chg-changed .card{stroke:var(--warn);stroke-width:2.5}
.tl .nd.chg-new .card{stroke:var(--ok);stroke-width:2.5}
.tl .mk circle{stroke:var(--page);stroke-width:2}.tl .mk text{font:700 13px var(--f);fill:var(--page)}
.tl .mk-changed circle{fill:var(--warn)}.tl .mk-new circle{fill:var(--ok)}.tl .mk-removed circle{fill:var(--bad)}
.tl .mtag text{font:600 10.5px var(--f)}
.tl .mtag-changed rect{fill:var(--page);stroke:var(--warn)}.tl .mtag-changed text{fill:var(--warn)}
.tl .mtag-new rect{fill:var(--page);stroke:var(--ok)}.tl .mtag-new text{fill:var(--ok)}
.tl .was{font:11px var(--f);fill:var(--muted)}
.tl .rmv .card{fill:var(--bad-wash);stroke:var(--bad);stroke-width:2;stroke-dasharray:6 5}
.tl .rmv .ttl{font-size:13.5px;font-weight:600;fill:var(--bad);text-decoration:line-through}.tl .rmv .sub{font-size:11.5px;fill:var(--bad)}
.tl .rmv.ghost{opacity:.6}.tl .rmv.ghost .card{stroke-width:1.5}
.tl .ghostn .card{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:5 5}
.tl .ghostn .ttl{font-size:13.5px;font-weight:600;fill:var(--muted)}.tl .ghostn .sub{font-size:11.5px;fill:var(--muted)}
.tl .ghostn,.tl .rmv{pointer-events:visiblePainted}
.tl .wire.wnew{stroke:var(--ok);stroke-width:2.6;opacity:1}
.tl .wire.wsame{opacity:.3}
.tl .wire.wgone{stroke:var(--bad);stroke-width:1.8;stroke-dasharray:6 5;opacity:.85}
.tl .chgbar{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
.tl .segs{display:flex;background:var(--s3);border-radius:9px;padding:3px;gap:2px}
.tl .segs button{border:none;background:none;border-radius:7px;padding:4px 10px;font-size:12px;color:var(--text2)}
.tl .segs button[aria-pressed=true]{background:var(--page);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.tl .chglegend{display:flex;gap:12px;align-items:center;font-size:12px;color:var(--text2)}
.tl .chglegend i{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:-1px}
.tl .chgtip{position:fixed;z-index:30;width:400px;max-width:calc(100% - 24px);background:var(--page);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(20,20,19,.14);padding:12px 14px;display:grid;gap:9px;font-size:12.5px}
.tl .chgtip .tr{display:grid;grid-template-columns:70px minmax(0,1fr);gap:4px 10px;line-height:1.45}
.tl .chgtip .k,.tl .cfield .k{color:var(--dim)}
.tl .cfield .tr{display:grid;grid-template-columns:70px minmax(0,1fr);gap:6px 10px;line-height:1.45}
.tl .cfield .vold,.tl .cfield .vnew{display:block;width:fit-content;max-width:100%}
.tl .vold{background:var(--bad-wash);color:var(--bad);text-decoration:line-through;overflow-wrap:anywhere}
.tl .vnew{background:var(--ok-wash);color:var(--ok);overflow-wrap:anywhere}
.tl .chgsum{display:flex;gap:5px;align-items:center}
.tl .chgsum .pill{font-size:11px;padding:1px 7px}
.tl #changes .row .sym{font-weight:700;margin-right:3px}
.tl #changes .row.on{outline:1.5px solid var(--warn)}
.tl .cfield{display:grid;gap:4px}.tl .cfield .box{border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:12.5px;line-height:1.45;display:grid;gap:3px}
@media(max-width:820px){.tl .tlay{grid-template-columns:1fr}.tl .anav .meter{display:none}.tl .erow{flex:none}.tl .ngrid{grid-template-columns:1fr}.tl .wrow{grid-template-columns:1fr}}
` + LAB_CSS_3;
