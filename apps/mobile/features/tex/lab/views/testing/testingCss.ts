/**
 * The Testing tab's own styles, in the Lab's simplified look (Dev2, 2026-11-16: "simplify this page, because right now
 * it looks horrendous"; approved mockup https://claude.ai/artifact/PUjJ7Vd6tX6BJj7vkEir1T): one sets column, the
 * chat with a 40px header, a details panel only while a step's cell is picked, 13/12/11px text and 28px controls.
 * Scoped to `.tst.tsx` so the shared text grid (`labCss4.ts`) that reuses `.tst` keeps its own look.
 */
export const TESTING_CSS = String.raw`
.tl .tst.tsx{padding:0;gap:0;height:100%;overflow:hidden;background:var(--page);font-size:13px;line-height:1.4}
.tl .tsx svg.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.tl .tsx .ib{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--text2)}
.tl .tsx .ib:hover{background:var(--s3)}
.tl .tsx .ib:disabled{opacity:.35;cursor:default;background:none}
.tl .tsx .sp{flex:1}
.tl .tsx .ts-body{display:grid;min-height:0;height:100%}
.tl .tsx .ts-sets{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--chrome)}
.tl .tsx .ts-sh{display:flex;align-items:center;gap:6px;height:40px;padding:0 8px 0 12px;flex:none}
.tl .tsx .ts-sh b{font-weight:600}
.tl .tsx .ts-ratio{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;border:none;background:none;padding:2px 4px;border-radius:6px;cursor:default}
.tl .tsx .ts-ratio .rb{display:inline-flex;width:44px;height:5px;border-radius:3px;overflow:hidden;background:var(--chip)}
.tl .tsx .ts-ratio .rb i{display:block;height:100%}
.tl .tsx .ts-ratio.off{color:var(--warn)}
.tl .tsx .ts-list{overflow:auto;flex:1;padding:0 6px 10px}
.tl .tsx .ts-set.drop{background:var(--accent-dim);border-radius:7px}
.tl .tsx .ts-grp{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 6px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-top:6px}
.tl .tsx .ts-grp .n{margin-left:auto;font-weight:500;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums}
.tl .tsx .ts-grp .ts-sw{width:7px;height:7px;border-radius:50%;flex:none}
.tl .tsx .ts-ci{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 8px;border:none;background:none;border-radius:7px;text-align:left;color:var(--text2)}
.tl .tsx .ts-ci[draggable=true]{cursor:grab}
.tl .tsx .ts-ci:hover{background:var(--s3)}
.tl .tsx .ts-ci[aria-current=true]{background:var(--s3);color:var(--text);font-weight:500}
.tl .tsx .ts-ci .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .tsx .ts-ci .st{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;font-weight:400}
.tl .tsx .ts-ci.locked{color:var(--dim)}
.tl .tsx .ts-showtest{margin:2px 8px;font-size:12px;color:var(--team);border:none;background:none;padding:2px 0}
.tl .tsx .ts-mid{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--page)}
.tl .tsx .ts-mh{display:flex;align-items:center;gap:6px;height:40px;padding:0 8px 0 12px;border-bottom:1px solid var(--line);min-width:0;flex:none;position:relative}
.tl .tsx .ts-ttl{font-weight:600;font-size:13px;border:1px solid transparent;border-radius:6px;padding:2px 4px;background:none;color:var(--text);min-width:40px;max-width:340px;field-sizing:content}
.tl .tsx .ts-ttl:hover{border-color:var(--line)}
.tl .tsx .ts-ttl:read-only{border-color:transparent}
.tl .tsx .ts-meta{color:var(--dim);font-size:12px;white-space:nowrap}
.tl .tsx .ts-meta.test{color:var(--team)}
.tl .tsx .ts-gw{overflow:auto;flex:1;min-height:0}
.tl .tsx table.chatgrid{width:100%;font-size:13px}
.tl .tsx table.chatgrid th,.tl .tsx table.chatgrid td{border-right:0;border-bottom:1px solid var(--line);padding:6px 8px}
.tl .tsx table.chatgrid thead th{background:var(--page);color:var(--muted);font-weight:500;font-size:12px;height:30px;padding:0 8px;vertical-align:middle;z-index:2}
.tl .tsx table.chatgrid th .x{border:0;background:none;color:var(--muted);cursor:pointer;margin-left:4px;opacity:0;padding:0 2px;font-size:12px}
.tl .tsx table.chatgrid th:hover .x,.tl .tsx table.chatgrid th .x:focus-visible{opacity:1}
.tl .tsx table.chatgrid th .ib,.tl .tsx table.chatgrid td.act .ib{width:24px;height:24px;border-color:transparent;background:none}
.tl .tsx table.chatgrid th .ib:hover,.tl .tsx table.chatgrid td.act .ib:hover{background:var(--s3)}
.tl .tsx table.chatgrid th.ts-addc{text-align:center;padding:0 2px}
.tl .tsx table.chatgrid td.num{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;text-align:right;padding-right:6px}
.tl .tsx table.chatgrid td.num .grip{display:none}
.tl .tsx table.chatgrid td.ts-who b{font-weight:600}
.tl .tsx tr.mr:hover td{background:var(--s2)}
.tl .tsx tr.mr.sel td{background:var(--accent-dim)}
.tl .tsx tr.mr.tex td{background:none}
.tl .tsx tr.mr.tex td.txt,.tl .tsx tr.mr.tex .texwho{color:var(--team)}
.tl .tsx table.chatgrid td.nc{color:var(--dim);text-align:center;cursor:pointer}
.tl .tsx table.chatgrid td.nc .cv{color:var(--text2);font-size:12px}
.tl .tsx table.chatgrid td.dc.on{box-shadow:inset 0 0 0 2px var(--accent)}
.tl .tsx table.chatgrid td.act{padding:4px 2px;text-align:center;white-space:nowrap}
.tl .tsx table.chatgrid td.act .ib{opacity:0}
.tl .tsx tr.mr:hover td.act .ib,.tl .tsx tr.mr.sel td.act .ib,.tl .tsx td.act .ib:focus-visible,.tl .tsx td.act .ib[aria-expanded=true]{opacity:1}
.tl .tsx .ts-addrow{border:none;background:none;color:var(--accent);padding:8px 12px;text-align:left}
.tl .tsx .compose{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);background:var(--page)}
.tl .tsx .compose select{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:0 6px;font-size:13px}
.tl .tsx .compose input{flex:1;height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--s2);padding:0 10px;min-width:0;color:var(--text);font:inherit}
.tl .tsx .compose .btn.p{height:28px;padding:0 11px;border-radius:7px}
.tl .tsx .ts-det{border-left:1px solid var(--line);background:var(--page);display:flex;flex-direction:column;min-height:0;min-width:0}
.tl .tsx .ts-dh{display:flex;align-items:center;gap:6px;height:40px;padding:0 8px 0 12px;border-bottom:1px solid var(--line);flex:none}
.tl .tsx .ts-dh b{font-weight:600;font-size:13px}
.tl .tsx .ts-db{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:0}
.tl .tsx .ts-db .quote{background:var(--s3);border-radius:8px;padding:8px 10px}
.tl .tsx .ts-db .quote small{color:var(--dim);font-size:12px}
.tl .tsx .ts-cap{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.tl .tsx .ts-row{display:grid;grid-template-columns:64px minmax(0,1fr);gap:6px;align-items:center}
.tl .tsx .ts-row>label{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}
.tl .tsx .ts-row input{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--page);padding:0 8px;min-width:0;color:var(--text);font:inherit}
.tl .tsx .seg2{display:flex;flex-wrap:wrap;gap:4px}
.tl .tsx .seg2 button{height:26px;border:1px solid var(--line);background:var(--page);border-radius:7px;padding:0 9px;font-size:12px;color:var(--text2)}
.tl .tsx .seg2 button[aria-pressed=true]{border-color:var(--accent);background:var(--accent-dim);color:var(--accent);font-weight:600}
.tl .tsx .ts-ghost{align-self:flex-start;height:28px;border:1px solid var(--line);border-radius:7px;background:var(--page);padding:0 10px}
.tl .tsx .ts-ghost.on{color:var(--star);border-color:var(--star)}
.tl .tsx .ts-db details summary{cursor:pointer;color:var(--muted);font-size:12px}
.tl .tsx .ts-db details .in{margin-top:6px;font-size:12px;color:var(--text2);display:flex;flex-direction:column;gap:4px}
.tl .tsx .ts-db details .in a{color:var(--accent);text-decoration:none}
.tl .tsx .ts-db .must input{height:28px;border-radius:7px}
.tl .ts-menu{position:fixed;z-index:60;max-height:70vh;overflow:auto;min-width:200px;max-width:280px;background:var(--page);border:1px solid var(--line2);border-radius:12px;box-shadow:var(--shadow);padding:6px;font-size:13px;color:var(--text)}
.tl .ts-menu .it{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;text-align:left;border:none;background:none;padding:4px 8px;border-radius:6px;font:inherit;color:inherit;cursor:pointer}
.tl .ts-menu .it:hover{background:var(--s3)}
.tl .ts-menu .it:disabled{opacity:.4;cursor:default;background:none}
.tl .ts-menu .it.bad{color:var(--bad)}
.tl .ts-menu .it .k{margin-left:auto;color:var(--dim);font-size:12px}
.tl .ts-menu .it .ck{width:14px;color:var(--accent)}
.tl .ts-menu hr{border:none;border-top:1px solid var(--line);margin:5px 4px}
.tl .ts-menu .h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:6px 8px 2px}
.tl .ts-menu .key{display:grid;grid-template-columns:20px 1fr;gap:4px 6px;padding:4px 8px;font-size:12px;color:var(--text2)}
.tl .ts-menu .key .ok{color:var(--ok)}.tl .ts-menu .key .must{color:var(--warn)}.tl .ts-menu .key .star{color:#C27C0E}
.tl .tsx .hist{top:36px}
.tl .tsx .ts-det>.panel{border:0;border-radius:0;height:100%;background:var(--page)}
.tl .tsx .ts-mid .empty{padding:24px;color:var(--muted)}
@media (max-width:820px){.tl .tsx .ts-body{grid-template-columns:minmax(0,1fr)!important}.tl .tsx .ts-sets{display:none}.tl .tsx .ts-det{position:fixed;inset:44px 0 0 auto;width:min(320px,100%);box-shadow:var(--shadow);z-index:40}}
`;
