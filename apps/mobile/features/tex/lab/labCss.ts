/**
 * The Tex Architecture Lab artifact's stylesheet (tex.lc/lab), ported
 * verbatim from the artifact's <style> block and scoped under `.tl`, the root
 * element the Lab mounts in. The only changes from the artifact: `:root` and
 * the bare `html,body` selector are now `.tl`, and the first rule makes the
 * root fill its host the way the full-page document did.
 */
export const LAB_CSS = String.raw`.tl{position:fixed;inset:0;overflow:hidden}
/* Layout: the Context app frame. Title bar on top; a tree-like sidebar on the left (views, steps, versions); the work in the middle (a canvas with a floating toolbar, or a page); properties of whatever is selected on the right. Tokens are the app's own (features/design/tokens/colors.ts). */
.tl{
  --chrome:#F4F1EA; --page:#FFFDF9; --s2:#F7F4ED; --s3:#F0ECE3; --chip:rgba(26,23,20,0.05); --row:#E6E1D6;
  --line:rgba(26,23,20,0.09); --line2:rgba(26,23,20,0.18);
  --text:#1A1714; --text2:#4A443C; --muted:#635C52; --dim:#7A7264;
  --accent:#2A45CF; --accent-dim:rgba(42,69,207,0.10); --team:#6A46B8;
  --ok:#3E7A4E; --ok-wash:rgba(62,122,78,0.10); --warn:#96600A; --warn-wash:rgba(150,96,10,0.12); --bad:#B23A32; --bad-wash:rgba(178,58,50,0.10);
  --m-haiku:#2F8F83; --m-sonnet:#B4527F; --m-opus:#6A46B8; --m-api:#96600A; --m-code:#7A7264;
  --grid:rgba(26,23,20,0.10); --shadow:0 1px 2px rgba(26,23,20,.06),0 8px 24px rgba(26,23,20,.08);
  --f:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,sans-serif; --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme: dark){.tl:not([data-theme="light"]){
  --chrome:#191715; --page:#201E1B; --s2:#201E1B; --s3:#2B2825; --chip:rgba(237,232,224,0.05); --row:#2B2825;
  --line:rgba(237,232,224,0.07); --line2:rgba(237,232,224,0.14);
  --text:#EDE8E0; --text2:#C3BCB2; --muted:#A79F95; --dim:#8D857B;
  --accent:#8A9BF2; --accent-dim:rgba(138,155,242,0.13); --team:#B9A3F2;
  --ok:#82C98E; --ok-wash:rgba(130,201,142,0.10); --warn:#DFAC52; --warn-wash:rgba(223,172,82,0.10); --bad:#E5847D; --bad-wash:rgba(229,132,125,0.12);
  --m-haiku:#5CC7B8; --m-sonnet:#E58AB4; --m-opus:#B9A3F2; --m-api:#DFAC52; --m-code:#A79F95;
  --grid:rgba(237,232,224,0.09); --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35); color-scheme:dark}}
.tl[data-theme="dark"]{
  --chrome:#191715; --page:#201E1B; --s2:#201E1B; --s3:#2B2825; --chip:rgba(237,232,224,0.05); --row:#2B2825;
  --line:rgba(237,232,224,0.07); --line2:rgba(237,232,224,0.14);
  --text:#EDE8E0; --text2:#C3BCB2; --muted:#A79F95; --dim:#8D857B;
  --accent:#8A9BF2; --accent-dim:rgba(138,155,242,0.13); --team:#B9A3F2;
  --ok:#82C98E; --ok-wash:rgba(130,201,142,0.10); --warn:#DFAC52; --warn-wash:rgba(223,172,82,0.10); --bad:#E5847D; --bad-wash:rgba(229,132,125,0.12);
  --m-haiku:#5CC7B8; --m-sonnet:#E58AB4; --m-opus:#B9A3F2; --m-api:#DFAC52; --m-code:#A79F95;
  --grid:rgba(237,232,224,0.09); --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35); color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
.tl{height:100%;margin:0;background:var(--chrome);color:var(--text);font-family:var(--f);font-size:14px;line-height:1.4}
button,select,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}

.app{height:100%;display:grid;grid-template-rows:56px minmax(0,1fr);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.bar{display:flex;align-items:center;gap:8px;padding:0 12px;min-width:0}
.ib{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:9px;border:1px solid var(--line);background:var(--page);color:var(--text2)}
.ib:hover{background:var(--s3)}
.ib[aria-pressed=true]{background:var(--accent-dim);color:var(--accent);border-color:transparent}
.chipbtn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:9px;background:var(--chip);border:1px solid transparent;color:var(--text);max-width:280px}
.chipbtn:hover{border-color:var(--line2)}
.chipbtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.primary{height:36px;padding:0 14px;border-radius:9px;border:none;background:var(--accent);color:var(--page);font-weight:600}
.primary:disabled{opacity:.45;cursor:default}
.ghost{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--page);color:var(--text2)}
.ghost:hover{background:var(--s3)}
.spacer{flex:1}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
.sync{font-size:12.5px;color:var(--dim);white-space:nowrap}
.thm{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--chip)}.thm button{display:grid;place-items:center;width:26px;height:24px;padding:0;border:none;border-radius:6px;background:none;color:var(--dim)}.thm button:hover{color:var(--text)}.thm button[aria-checked="true"]{background:var(--page);color:var(--text);box-shadow:var(--shadow)}

.body{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:0}
.body.props{grid-template-columns:260px minmax(0,1fr) 320px}
.side{overflow:auto;padding:8px 8px 16px;min-height:0}
.sec{font-size:12px;color:var(--dim);padding:14px 10px 6px;display:flex;align-items:center;justify-content:space-between}
.sec button{border:none;background:none;color:var(--dim);padding:2px;border-radius:6px;display:inline-grid}
.sec button:hover{color:var(--text)}
.rowi{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border-radius:9px;border:none;background:none;color:var(--text);text-align:left;font-size:14.5px;min-width:0}
.rowi:hover{background:var(--chip)}
.rowi.sub{padding-left:30px;font-size:13.5px}
.mform{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--page)}
.mform .num input{width:100%}
.cdot{width:12px;height:12px;border-radius:4px;border:1.5px solid var(--accent);background:var(--accent-dim);padding:0;flex:none;cursor:pointer}
.blk2.vol .cdot{border-color:var(--warn);background:var(--warn-wash)}
.tlay{display:grid;grid-template-columns:230px minmax(0,1fr);gap:18px;align-items:start}
.anav{display:grid;gap:2px;position:sticky;top:0}
.anav button{display:flex;align-items:center;gap:9px;border:none;background:none;border-radius:9px;padding:8px 9px;text-align:left;color:var(--text);font-size:13.5px}
.anav button:hover{background:var(--chip)}.anav button[aria-current=true]{background:var(--row)}
.anav .an{flex:1;min-width:0;display:grid}.anav small{color:var(--dim);font-size:11.5px}
.anav .ac{font-family:var(--mono);font-size:11px;color:var(--dim)}
.who{display:flex;flex-wrap:wrap;gap:14px 28px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--page);margin-bottom:12px}
.wp{display:flex;gap:10px;align-items:center;min-width:180px}
.av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--accent-dim);color:var(--accent);font-weight:600}
.wcol{display:grid;gap:6px;min-width:0}.wh{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
.wr2{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px}.wn{font-weight:600}
.tbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.tbar .search{flex:1 1 160px;min-width:140px;max-width:280px}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.tc{border:1px solid var(--line);border-radius:12px;background:var(--page);padding:10px 12px 12px;display:grid;gap:10px;min-width:0;align-content:start}
.tc.off{opacity:.55}
.tch{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.cid{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
.inrun input{width:16px;height:16px;accent-color:var(--accent);margin:0;display:block}
.ib.sm{width:28px;height:28px}
.thr{display:grid;gap:6px}
.bb{max-width:88%;justify-self:start;background:var(--s3);border-radius:14px 14px 14px 4px;padding:7px 10px;font-size:13.5px;line-height:1.4;overflow-wrap:anywhere}
.bb .bw{display:block;font-size:11px;color:var(--dim);margin-bottom:1px}
.bb.new{box-shadow:inset 0 0 0 1.5px var(--line2)}
.bb.tex{justify-self:end;background:var(--accent-dim);border-radius:14px 14px 4px 14px}
.ctxl{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);font-style:italic}
.used{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dim);font-family:var(--mono)}
.want{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;border-top:1px solid var(--line);padding-top:9px;font-size:13px}
.wl{font-size:11.5px;color:var(--dim);padding-top:3px;white-space:nowrap}
.mi{padding-left:18px;position:relative;margin:1px 0}.mi:before{position:absolute;left:0;top:0;font-weight:700}
.mi.ok:before{content:"✓";color:var(--ok)}.mi.no:before{content:"✕";color:var(--bad)}
.tc .ed{display:grid;gap:6px}
.anh{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:10px 9px 4px;display:flex;gap:6px;align-items:baseline}.anh small{text-transform:none;letter-spacing:0;font-size:11.5px}
.anh:first-child{padding-top:0}
.ipath{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.arr{color:var(--dim);font-size:12px}
.iop select{font:13px var(--f);border:1px solid var(--line);border-radius:7px;padding:4px 7px;background:var(--page);color:var(--text)}
.iop{display:grid;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--page);margin-bottom:12px}
.ior{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.iol{width:52px;font-size:11.5px;color:var(--dim)}
.ioc{display:inline-flex;align-items:center;gap:5px;border-radius:6px;padding:2px 7px;font-size:12px;border:1px solid var(--line);background:var(--page)}
.ioc.g{background:var(--accent-dim);border-color:transparent;color:var(--accent)}.ioc.f{background:var(--ok-wash);border-color:transparent;color:var(--ok)}
.ioc.d{color:var(--dim)}.ioc.x{background:var(--bad-wash);border-color:transparent;color:var(--bad);text-decoration:line-through}
.ioc.o{font-family:var(--mono);font-size:11.5px;background:var(--s3);border-color:transparent}.ioc.s{font-weight:600}
.iok{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px}.iok span{display:inline-flex;align-items:center;gap:5px}.iok i.ioc{width:10px;height:10px;padding:0}
.fitw{background:var(--warn-wash);color:var(--warn);border-radius:8px;padding:6px 9px;font-size:12.5px;display:grid;gap:2px}
@media(max-width:820px){.tlay{grid-template-columns:1fr}.anav{position:static;display:flex;overflow-x:auto;gap:4px}.anav button{flex:none}.anav small,.anav .ac{display:none}.mform{grid-template-columns:1fr 1fr}}
.mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.mcard{border:1px solid var(--line);border-radius:12px;background:var(--page);padding:12px;display:grid;gap:10px;min-width:0}
.mcard.focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.mcard .mh{display:flex;align-items:center;gap:8px}
.mcard .mh input{flex:1;min-width:0;font:600 15px var(--f);border:1px solid transparent;background:none;color:var(--text);border-radius:6px;padding:3px 5px}
.mcard .mh input:hover,.mcard .mh input:focus{border-color:var(--line)}
.viewer{position:fixed;inset:0;background:rgba(26,23,20,.32);display:grid;place-items:center;z-index:50;padding:16px}
.viewer[hidden]{display:none!important}
.wsb{display:inline-flex;align-items:center;gap:6px;border:none;background:none;padding:2px 4px;margin-left:-4px;border-radius:6px;color:var(--accent);cursor:pointer}.wsb:hover{background:var(--accent-dim)}
.wsbox{grid-template-rows:auto 1fr}.wsg{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:0}
.wst{overflow:auto;border-right:1px solid var(--line);padding:8px 6px}.wst button{display:block;width:100%;text-align:left;border:none;background:none;border-radius:6px;padding:4px 8px;font:12.5px var(--f);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wst button:hover{background:var(--chip)}.wst button[aria-current=true]{background:var(--row)}.wsd{font:11.5px var(--mono);color:var(--dim);padding:8px 8px 2px}
.wsn{margin:0;overflow:auto;padding:14px 16px;font:12.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:820px){.wsg{grid-template-columns:1fr;grid-template-rows:180px 1fr}.wst{border-right:none;border-bottom:1px solid var(--line)}}
.wdv{overflow:auto;padding:14px 16px;font:12.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.wdv ins{background:var(--ok-wash);color:var(--ok);text-decoration:none;border-radius:3px}.wdv del{background:var(--bad-wash);color:var(--bad);border-radius:3px}
.vbox{width:min(860px,100%);height:min(86vh,900px);background:var(--page);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden}
.vh{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.vbox textarea{border:none;resize:none;padding:14px 16px;font:12.5px/1.55 var(--mono);background:var(--page);color:var(--text);outline:none;width:100%;height:100%}
.vf{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--line)}
.blk2[data-openmod]{cursor:pointer}
.ksec{margin-bottom:22px}.kh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:14.5px}.kh .hint{font-size:12.5px}
.mpath{font-family:var(--mono);font-size:11.5px;color:var(--dim);overflow-wrap:anywhere;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--page);width:100%}.mpath.ro{border:none;padding:0;background:none}
.mcard select{font:13px var(--f);border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--page);color:var(--text)}
.mcard .mrow{display:flex;gap:10px;align-items:end}.mcard .mrow .num{width:96px}
.mcard textarea.mono{font-family:var(--mono);font-size:12px}
.lnk{border:none;background:none;color:var(--accent);font-size:12.5px;padding:0;text-align:left}
.danger.sm{padding:5px 10px;font-size:12.5px;width:auto}
.fields{display:grid;gap:8px;margin-top:10px}
.fld{display:grid;grid-template-columns:minmax(0,1fr) 108px 26px;gap:6px;align-items:center}
.fld input,.fld select{min-width:0;font:13px var(--mono);border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--page);color:var(--text)}
.fld select{font-family:var(--f)}
.fld .fo{grid-column:1/-1;font-family:var(--f);font-size:12.5px;color:var(--text2)}
.fld .x{border:none;background:none;color:var(--dim);display:grid;place-items:center;height:26px;border-radius:6px}.fld .x:hover{background:var(--chip);color:var(--text)}
.rowi[aria-current=true]{background:var(--row)}
.rowi .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rowi .tag{font-size:12.5px;color:var(--team)}
.rowi .meta{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.rowi .ic{color:var(--accent)}
.rowi.off{color:var(--dim)}

.main{background:var(--page);border-top-left-radius:12px;min-width:0;min-height:0;position:relative;overflow:hidden;border-left:1px solid var(--line);border-top:1px solid var(--line)}
.body.props .main{border-top-right-radius:12px;border-right:1px solid var(--line)}

#stage{position:absolute;inset:0;touch-action:none;background-color:var(--page);background-image:radial-gradient(var(--grid) 1px,transparent 1.2px);background-size:22px 22px}
#stage.pan{cursor:grab}
#stage.connect{cursor:crosshair}
#stage svg{width:100%;height:100%;display:block}
.nd{cursor:pointer}
.nd .card{fill:var(--page);stroke:var(--line2);stroke-width:1}
.nd:hover .card{stroke:var(--text2)}
.nd.sel .card{stroke:var(--accent);stroke-width:2}
.nd.dim{opacity:.32}
.nd.off .card{stroke-dasharray:4 4}
.nd.lit .card{stroke:var(--accent);stroke-width:3}
.nd .ttl{font-size:13.5px;font-weight:600;fill:var(--text)}
.nd .sub{font-size:11.5px;fill:var(--muted)}
.stats .real{font-size:11px;font-weight:600;color:var(--ok);background:var(--ok-wash);border-radius:6px;padding:1px 6px;margin-left:2px}
.nd .tm{font-size:11.5px;font-weight:600;fill:var(--text2);font-variant-numeric:tabular-nums}
.port{fill:var(--page);stroke:var(--accent);stroke-width:1.5;opacity:0;cursor:crosshair}
.nd:hover .port,.connect .port,.nd.sel .port{opacity:1}
.wire{fill:none;stroke-width:1.6;pointer-events:none}
#ghost,.wlabel,.tm{pointer-events:none}
.wire.dim{opacity:.18}
.wire.sel{stroke-width:3}
.hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
.wlabel{font-size:11px;fill:var(--dim);paint-order:stroke;stroke:var(--page);stroke-width:4px}
.float{position:absolute;display:flex;gap:6px;align-items:center;background:var(--page);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:5px}
.tools{left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px))}
.tools .ib{border:none;background:none}
.tools .ib:hover{background:var(--chip)}
.tools .ib[aria-pressed=true]{background:var(--accent-dim)}
.tools .sep{width:1px;height:22px;background:var(--line)}
.tuser{display:flex;gap:10px;align-items:center;padding:4px 10px 6px}.tuser .av{width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px;flex:none}.tuser .hint{font-size:11.5px}
.side .sub{font-size:11px;color:var(--dim);padding:6px 10px 2px}
#props{position:relative}.pclose{position:absolute;top:10px;right:10px}
.cvsvg{width:100%;height:auto;display:block}.cvb{fill:var(--page);stroke:var(--line);stroke-width:1.2}.cvb.core{fill:var(--chip);stroke:var(--accent);stroke-width:1.6}.cvb.idx{stroke-dasharray:4 3}.cvb.tmp{stroke-dasharray:2 3;fill:none}.cvb.view{fill:var(--chrome)}
.cvt{font-size:13px;font-weight:600;fill:var(--text)}.cvs{font-size:11px;fill:var(--muted)}.cva{fill:none;stroke:var(--muted);stroke-width:1.3}.cva.dash{stroke-dasharray:4 3}
.cvgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 24px}.cvtools{display:grid;gap:6px}
.cvtool{display:flex;align-items:center;gap:10px;border:1px solid var(--line);background:var(--page);border-radius:10px;padding:8px 10px;text-align:left}.cvtool[aria-pressed="false"]{opacity:.55}.cvtool[aria-pressed="true"]{border-color:var(--accent)}.cvtool .nm{flex:1}.cvtool code{font-size:11px;color:var(--dim)}
.cvk{font-size:10.5px;font-weight:600;border-radius:6px;padding:2px 6px;background:var(--chip);color:var(--muted)}.cvk.change{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
label.num.chg{outline:2px solid var(--accent);border-radius:10px}
.fhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}.fhead h1{font-size:22px;margin:0}
.fflow{display:grid;grid-template-columns:minmax(0,1.3fr) 24px minmax(160px,.7fr) 24px minmax(0,1fr);gap:10px;align-items:start}
.fcol{border:1px solid var(--line);border-radius:12px;background:var(--page);padding:12px}.fcol h4{margin:0 0 8px;font-size:12px;color:var(--muted);font-weight:600}
.farrow{align-self:center;text-align:center;color:var(--dim);font-size:20px}
.fstep{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;padding:20px 12px;border-color:var(--accent)}.fbig{width:56px;height:56px;border-radius:14px;background:var(--s3);display:grid;place-items:center;margin-bottom:4px}
.fw{display:flex;align-items:center;gap:8px;margin:4px 0}.fnode{display:flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--chrome);border-radius:8px;padding:5px 9px;font-size:13px}.fnode:hover{border-color:var(--accent)}
.fmods{display:grid;gap:4px}.fmod{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-left:4px solid var(--dim);background:var(--chrome);border-radius:8px;padding:6px 9px;text-align:left;font-size:13px}.fmod.st{border-left-color:var(--accent)}.fmod.out{border-left-color:var(--m-api)}.fmod:hover{border-color:var(--accent)}
.fmod .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmod .src{font-size:11px;color:var(--dim)}.fmod .tk{font-family:var(--mono,monospace);font-size:11.5px;color:var(--muted)}
.fout{display:flex;gap:8px;align-items:baseline;margin:3px 0}.fout code{font-size:12.5px}
#fcTests .tmain{margin:0}
@media(max-width:820px){.fflow{grid-template-columns:1fr}.farrow{transform:rotate(90deg)}}
.body.props.wide{grid-template-columns:260px minmax(0,1fr) 420px}
.fbar{left:12px;top:60px;padding:5px 6px 5px 12px;gap:8px;font-size:13px}.fbar b{font-weight:600}
.fblk rect{fill:var(--chrome);stroke:var(--line)}.fblk.st rect{stroke:var(--accent)}.fblk.out rect{stroke:var(--m-api)}.fblk.fld rect{fill:var(--s3);stroke:none}.fblk text{font-size:12.5px;fill:var(--text)}.fblk .tk{fill:var(--muted);font-size:11px}.fblk[data-fmod]{cursor:pointer}.fblk[data-fmod]:hover rect{stroke:var(--accent)}
.fcap{font-size:11px;fill:var(--muted);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.fgoal{font-size:12.5px;line-height:1.4;color:var(--text2);background:var(--chrome);border:1px solid var(--line);border-radius:10px;padding:8px 10px}.fgoal .lg{display:block;margin-top:6px;font-size:11.5px}
.tn{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.lgok{color:var(--ok)}.lgno{color:var(--bad)}
.ttbl td{vertical-align:top}.tacts{display:flex;flex-wrap:wrap;gap:4px}.tact{font-family:var(--mono,monospace);font-size:11px;padding:1px 6px;border-radius:6px;background:var(--chip);color:var(--text2)}.tact b{color:var(--text);margin-left:4px}.tact.err{box-shadow:inset 0 0 0 1px var(--bad)}
.vren{border:1px solid transparent;background:none;font:inherit;font-weight:600;padding:4px 6px;border-radius:8px;width:170px;color:var(--text)}.vren:hover,.vren:focus{border-color:var(--line);background:var(--page)}
.moment{left:12px;top:12px;padding:5px 5px 5px 12px}
.ctop{position:absolute;left:12px;right:12px;top:12px;z-index:3;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;pointer-events:none}.ctop>*{pointer-events:auto}.ctop>.float{position:static;min-width:0;max-width:100%}.ctop>.stats{margin-left:auto}.cbreak{flex-basis:100%;height:0}.ctop.replay>.keybtn,.ctop.replay>.keyw{order:-1}
.moment .scnbtn{min-width:0}
.playbar{left:50%;transform:translateX(-50%);bottom:calc(64px + env(safe-area-inset-bottom,0px));width:min(620px,calc(100% - 24px));padding:5px 12px;gap:10px}
.playbar #playScrub{flex:1;min-width:0;accent-color:var(--accent)}
.playbar .pace{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap}.playbar .pace input{width:72px;accent-color:var(--accent)}.playbar .clock{font-size:12.5px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}
.nd .ring{fill:none;stroke:var(--ok);stroke-width:3.5;stroke-linecap:round;pointer-events:none;transition:stroke .15s}.nd .ring.wait{stroke:var(--accent)}.nd .ring.seg{stroke-linecap:butt}.nd.run .card{stroke:var(--ok-wash);stroke-width:3}
.scnbtn{display:flex;align-items:center;gap:6px;border:none;background:none;font-weight:500;padding:4px 2px;max-width:320px}.scnbtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scnpop{position:absolute;left:12px;top:58px;z-index:6;width:min(420px,calc(100% - 24px));max-height:min(70vh,560px);display:flex;flex-direction:column;gap:6px;background:var(--page);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:8px}
.scnpop .search{width:100%;max-width:none}.scnl{overflow:auto;min-height:0;flex:1}
.scng{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:8px 8px 3px}
.scnl button{display:flex;flex-direction:column;align-items:flex-start;width:100%;border:none;background:none;text-align:left;padding:6px 8px;border-radius:8px;gap:1px}
.scnl button:hover,.scnl button[aria-current="true"]{background:var(--chip)}.scnl .nm{font-size:13px;line-height:1.3}.scnl small{color:var(--dim);font-size:11px}.scne{color:var(--dim);font-size:12px;padding:6px 8px}
.scnown{display:flex;gap:6px;align-items:flex-end;padding:0 4px 2px}.scnown textarea{flex:1;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--chrome);color:var(--text);resize:vertical}
.stats{right:12px;top:12px;padding:6px 12px;gap:14px;font-size:12.5px;color:var(--muted)}
.stats b{color:var(--text);font-variant-numeric:tabular-nums;font-weight:600}
.zoom{right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}
/* Replay: the zoom sits up top, off the timeline (Dev2, 2026-11-14: "You see this overlap? super annoying"). */
.keybtn{display:flex;align-items:center;gap:6px;padding:5px 10px;font:inherit;font-size:12px;color:var(--muted);cursor:pointer}.keybtn[aria-expanded=true]{color:var(--text)}
.zoom .ib{width:30px;height:30px;border:none;background:none}
.keyw{left:12px;top:60px;flex-wrap:wrap;gap:12px;padding:6px 12px;font-size:12px;color:var(--muted)}
.keyw svg{width:30px;height:10px}
.menu{position:absolute;bottom:64px;left:50%;transform:translateX(-50%);background:var(--page);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:6px;min-width:250px;display:flex;flex-direction:column;z-index:5}
.menu button{display:flex;gap:10px;align-items:center;border:none;background:none;padding:8px 10px;border-radius:8px;text-align:left}
.menu button:hover{background:var(--chip)}

.props-pane{overflow:auto;min-height:0;padding:14px 14px 30px;background:var(--chrome);position:relative}.pcollapse{position:absolute;top:10px;right:10px;z-index:2;width:28px;height:28px;color:var(--muted)}.rexpand.right{left:auto;right:0;border-radius:10px 0 0 10px}
.pclose{display:none}
@media (max-width:820px){.pclose{display:inline-grid}.pfocus{margin-right:36px}}
.ph{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.ph .badge{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--s3);color:var(--accent);flex:none}
.ph button.badge{border:1px solid transparent;padding:0}.ph button.badge:hover,.ph button.badge[aria-expanded="true"]{border-color:var(--line2)}
a.rowi{text-decoration:none;cursor:pointer}
.modes{display:inline-flex;background:var(--s3);border-radius:10px;padding:3px;gap:2px}.modes button{border:none;background:none;font-weight:600;font-size:13px;color:var(--muted);padding:5px 12px;border-radius:8px}.modes button[aria-pressed=true]{background:var(--page);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.rside{display:flex;flex-direction:column;min-height:0;height:100%;gap:8px}
.rsideh{display:flex;gap:6px;align-items:center}.rsideh .ib{width:34px;height:34px;flex:none}
.rexpand{position:absolute;left:0;top:50%;transform:translateY(-50%);z-index:5;width:26px;height:56px;padding:0;display:grid;place-items:center;border-radius:0 10px 10px 0;cursor:pointer;color:var(--muted)}.rexpand .i{width:16px;height:16px}
.rchat{flex:1;min-width:0;width:100%;font:inherit;font-size:14px;font-weight:600;border:1px solid var(--line2);border-radius:9px;background:var(--page);color:var(--text);padding:8px 34px 8px 12px}
/* One drawn chevron, centred, instead of each browser's own arrow (Dev2, 2026-11-14: "how wonky this carat looks"). */
.rchat,.rtlh select{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a857c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 10l5 5 5-5'/%3E%3C/svg%3E")!important;background-repeat:no-repeat!important;background-position:right 10px center!important;background-size:16px 16px!important}.rtlh select{padding:3px 28px 3px 10px!important;background-position:right 8px center!important;background-size:14px 14px!important}
.rmoments{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:2px 0 8px}
.rmw{display:flex;flex-direction:column}
.rtl{left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));flex-direction:column;align-items:stretch;gap:6px;padding:8px 12px;max-width:none}
.rtlh{display:flex;align-items:center;gap:10px}.rtlh .ib{width:30px;height:30px}.rtlh .clock{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}.rtlh select{font:inherit;font-size:12px;border:1px solid var(--line);border-radius:7px;background:var(--page);color:var(--text);padding:2px 6px}
.rlanes{display:grid;gap:4px}.rrow{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;gap:8px}.rln{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rrow.helper .rln{padding-left:12px;position:relative}.rrow.helper .rln::before{content:"";position:absolute;left:3px;top:1px;width:6px;height:7px;border-left:1px solid var(--line2);border-bottom:1px solid var(--line2);border-bottom-left-radius:3px}.rrow.helper .rbar.turn{background:var(--accent);border-color:var(--accent);color:#fff}
.rlanes.compact{position:relative;gap:3px}.rrow.compact{grid-template-columns:minmax(0,1fr)}.cdq{font-style:italic;color:var(--muted)}.rtip{position:absolute;transform:translate(-50%,calc(-100% - 6px));background:var(--text);color:var(--page);font-size:11px;line-height:1.35;padding:4px 8px;border-radius:6px;white-space:nowrap;max-width:min(420px,90%);overflow:hidden;text-overflow:ellipsis;pointer-events:none;z-index:5}.rtlh .rmode{font:inherit;font-size:12px;line-height:18px;border:1px solid var(--line);border-radius:7px;background:var(--page);color:var(--text);padding:3px 10px;cursor:pointer}.rtlh .rmode:hover{background:var(--s3)}.rtlh .rmode:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.rtrack{position:relative;height:20px;background:var(--s3);border-radius:6px;cursor:ew-resize}.rlanes{touch-action:none;user-select:none}
.rbar{position:absolute;top:2px;height:16px;border-radius:5px;border:1px solid transparent;padding:0 5px;font-size:10.5px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);text-align:left}
.rbar.text{background:var(--accent);color:#fff}.rbar.judge{background:var(--warn-wash);border-color:var(--warn)}.rbar.turn{background:var(--accent-dim);border-color:var(--accent)}.rbar.sent{background:var(--ok-wash);border-color:var(--ok)}.rbar.wait{background:repeating-linear-gradient(135deg,var(--line2) 0 4px,transparent 4px 8px);border:1px dashed var(--line2)}
.rhead{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--text);border-radius:2px;pointer-events:none}
#rScrub{width:100%;accent-color:var(--accent)}
.rturn{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;margin-top:6px}.rturnh{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;color:var(--muted)}.rturnh b{color:var(--text);font-weight:600}.rturnt{font-size:13.5px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}
.rjrow{display:flex;align-items:baseline;gap:8px;font-size:13px;padding:4px 0}.rjrow b{font-weight:600}.rjat{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;min-width:40px}.rjwhy{color:var(--muted);font-size:12px}
.rpanel{display:flex;flex-direction:column;gap:8px}.rpanel h3{margin:0;font-size:17px;font-weight:600}.rpanel .ph{padding-right:36px}.rset{display:flex;flex-wrap:wrap;gap:6px}.cdd{align-self:center;font-size:11.5px;color:var(--dim);margin:8px 0 4px}.cdo{align-self:center;font-size:12.5px}
.cdb{max-width:86%;display:flex;flex-direction:column;gap:2px;text-align:left;font:inherit;font-size:13.5px;line-height:1.38;padding:7px 10px;border-radius:14px;border:1.5px solid transparent;color:var(--text);overflow-wrap:anywhere;white-space:pre-wrap}
.cdb.me{align-self:flex-end;background:var(--accent);color:#fff;border-radius:14px 14px 4px 14px}.cdb.them{align-self:flex-start;background:var(--s3);border-radius:14px 14px 14px 4px}.cdb.tex{align-self:flex-start;background:var(--warn-wash);border-radius:14px 14px 14px 4px}
.cdb.can{cursor:pointer}.cdb.can:hover{border-color:var(--line2)}.cdb.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-dim)}.cdb.me.on{border-color:var(--text)}
.cdw{font-size:11px;font-weight:600;color:var(--muted)}.cds{color:var(--accent)}.cdb.tex.can .cdm{color:var(--muted)}
#rIO .io{margin:8px 0 0}#rIO .io b{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:3px}#rIO pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 var(--mono);color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.iofold summary{cursor:pointer;font-size:12px;color:var(--accent);margin-top:2px}.io pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:none}.cdm{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums}.cdb.me .cdm{color:#fff}
.icpick{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;margin:8px 0 2px;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--page)}.icpick button{display:grid;place-items:center;height:30px;border:none;border-radius:7px;background:none;color:var(--text2)}.icpick button:hover{background:var(--chip)}.icpick button[aria-selected="true"]{background:var(--accent-dim);color:var(--accent)}
#nIO .io{margin:6px 0 0}#nIO .io b{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-bottom:2px}#nIO pre{margin:0;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.45 var(--mono);color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
.ph input{flex:1;min-width:0;border:1px solid transparent;background:none;font-size:17px;font-weight:600;padding:4px 6px;border-radius:7px}
.ph input:hover{border-color:var(--line)}
.ph input:focus{border-color:var(--accent);background:var(--page)}
.file{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin:0 0 6px 52px;word-break:break-all}
.grp{border-top:1px solid var(--line);padding:12px 0}
.grp h4{margin:0 0 8px;font-size:12px;font-weight:500;color:var(--dim)}
.seg{display:flex;flex-wrap:wrap;gap:3px;background:var(--chip);border-radius:9px;padding:3px}
.seg button{flex:1 0 auto;border:none;background:none;border-radius:7px;padding:6px 8px;font-size:12.5px;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;gap:6px}
.seg button[aria-pressed=true]{background:var(--page);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.mdot{width:8px;height:8px;border-radius:50%;flex:none}
.nums{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.num{display:flex;flex-direction:column;gap:3px;background:var(--page);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
.num span{font-size:11px;color:var(--dim)}
.num input{border:none;background:none;padding:0;width:100%;font-variant-numeric:tabular-nums;font-weight:500}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.cx{display:inline-flex;align-items:center;gap:6px;background:var(--page);border:1px solid var(--line);border-radius:999px;padding:3px 4px 3px 10px;font-size:12.5px}
.cx .k{font-family:var(--mono);font-size:11px;color:var(--dim)}
.cx button{border:none;background:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:var(--dim)}
.cx button:hover{background:var(--chip);color:var(--bad)}
.tg{border:1px solid var(--line);background:var(--page);border-radius:999px;padding:4px 10px;font-size:12.5px;color:var(--muted)}
.tg[aria-pressed=true]{background:var(--accent-dim);color:var(--accent);border-color:transparent}
.add{display:inline-flex;align-items:center;gap:6px;border:1px dashed var(--line2);background:none;border-radius:999px;padding:4px 10px;font-size:12.5px;color:var(--accent)}
.pick{margin-top:8px;background:var(--page);border:1px solid var(--line);border-radius:10px;max-height:260px;overflow:auto;padding:4px}
.pick button{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;border:none;background:none;padding:6px 8px;border-radius:7px;text-align:left;font-size:13px}
.pick button:hover{background:var(--chip)}
.pick .h{font-size:11.5px;color:var(--dim);padding:6px 8px 2px}
.wr{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;width:100%;border:none;background:none;text-align:left;font-size:13px}
.wr:hover{background:var(--chip)}
.wr svg.w{width:28px;height:10px;flex:none}
.danger{display:inline-flex;align-items:center;gap:8px;border:none;background:none;color:var(--bad);padding:6px 4px;font-weight:500}
.est{background:var(--page);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px}
.est .big{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.est .row{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12.5px;padding:2px 0}
.hint{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:500;background:var(--chip);color:var(--muted)}
.pill.ok{background:var(--ok-wash);color:var(--ok)} .pill.warn{background:var(--warn-wash);color:var(--warn)} .pill.bad{background:var(--bad-wash);color:var(--bad)} .pill.acc{background:var(--accent-dim);color:var(--accent)}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sw{width:38px;height:22px;border-radius:999px;border:none;background:var(--line2);position:relative;padding:0}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--page);transition:left .15s}
.sw[aria-checked=true]{background:var(--accent)}
.sw[aria-checked=true]::after{left:19px}
textarea.note{width:100%;border:1px solid var(--line);background:var(--page);border-radius:8px;padding:8px;font-size:13px;resize:vertical}
.stack{display:flex;flex-direction:column;gap:3px}
.blk2{display:flex;align-items:center;gap:8px;border-radius:8px;padding:0 6px 0 4px;border:1px solid var(--line);font-size:12.5px;cursor:grab;min-height:26px}
.blk2.st{background:var(--accent-dim)}
.blk2.vol{background:var(--warn-wash)}
.blk2.drag{opacity:.4}
.blk2.over{box-shadow:0 -2px 0 var(--accent)}
.blk2 .grip{color:var(--dim);display:inline-grid}
.blk2 .bn{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blk2 .k{font-family:var(--mono);font-size:11px;color:var(--dim)}
.blk2 .mv{display:flex;gap:1px}
.blk2 .mv button{border:none;background:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--dim)}
.blk2 .mv button:hover{background:var(--chip);color:var(--text)}
.blk2 .mv button:disabled{opacity:.3;cursor:default}
.cutline{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--warn);margin:2px 0}
.cutline::before,.cutline::after{content:"";flex:1;border-top:1.5px dashed var(--warn)}
.sw2{width:12px;height:12px;border-radius:3px;border:1px solid var(--line)}
.sw2.st{background:var(--accent-dim)}.sw2.vol{background:var(--warn-wash)}
.wk{display:flex;flex-direction:column;gap:4px}
.wk button{display:flex;align-items:center;gap:10px;border:1px solid var(--line);background:var(--page);border-radius:9px;padding:7px 10px;text-align:left}
.wk button[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.wk b{font-weight:500}
.wk small{display:block;color:var(--muted);font-size:11.5px}

.pg{position:absolute;inset:0;overflow:auto}
.pgin{max-width:980px;margin:0 auto;padding:36px 16px 60px}
.pgh{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.pgh .badge{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:var(--s3);color:var(--accent)}
.pgh h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em}
.lede{color:var(--muted);font-size:15px;margin:0 0 22px;max-width:68ch}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:22px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--page)}
.kpi .l{font-size:12.5px;color:var(--muted)} .kpi .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;margin:2px 0} .kpi .d{font-size:12.5px;font-variant-numeric:tabular-nums}
.blk{border-top:1px solid var(--line);padding:18px 0}
.blk h2{font-size:16px;margin:0 0 10px;font-weight:600}
.wf{display:flex;flex-direction:column;gap:4px}
.wf .r{display:grid;grid-template-columns:minmax(110px,190px) minmax(0,1fr) 56px;gap:10px;align-items:center;font-size:13px}
.wf .tr{position:relative;height:14px;background:var(--chip);border-radius:4px}
.wf .bb{position:absolute;top:0;height:14px;border-radius:4px}
.wf .t{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.wf .lane{font-size:12px;color:var(--dim);margin-top:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13.5px}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--dim);font-weight:500}
.tbl{overflow-x:auto}
td input[type=number]{width:70px;border:1px solid var(--line);background:var(--page);border-radius:7px;padding:4px 6px}
textarea.code{width:100%;border:1px solid var(--line);background:var(--page);border-radius:10px;padding:10px;font-family:var(--mono);font-size:12px;resize:vertical}
.tabsrow{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabsrow button{border:1px solid var(--line);background:var(--page);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--muted)}
.tabsrow button[aria-pressed=true]{background:var(--text);color:var(--page);border-color:var(--text)}
.case{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:10px 0;border-bottom:1px solid var(--line)}
.case .ask{font-weight:500}
.case .exp{color:var(--muted);font-size:13px}
.case input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);margin-top:2px}
.case .ed{display:grid;gap:6px;margin-top:8px}
.search{border:1px solid var(--line);background:var(--page);border-radius:9px;padding:7px 10px;min-width:0;flex:1;max-width:320px}
.flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.callout{border-radius:10px;padding:10px 12px;font-size:13.5px;background:var(--warn-wash);color:var(--text)}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom,0px));background:var(--text);color:var(--page);padding:8px 14px;border-radius:9px;font-size:13px;z-index:20;max-width:90vw}
.scrim{display:none}

@media (max-width:1100px){.body.props{grid-template-columns:220px minmax(0,1fr) 290px}.body.props.wide{grid-template-columns:220px minmax(0,1fr) 380px}.body{grid-template-columns:220px minmax(0,1fr)}}
@media (max-width:820px){
  .body,.body.props,.body.props.wide{grid-template-columns:minmax(0,1fr)}
  .side{position:fixed;z-index:15;left:0;top:56px;bottom:0;width:min(280px,85vw);background:var(--chrome);box-shadow:var(--shadow);transform:translateX(-105%);transition:transform .2s;padding-left:max(8px,env(safe-area-inset-left,0px))}
  .app.sideopen .side{transform:none}
  .app.sideopen .scrim{display:block;position:fixed;inset:56px 0 0 0;z-index:14;background:rgba(0,0,0,.2)}
  .main{border-radius:0;border-left:none}
  .props-pane{position:fixed;z-index:12;left:0;right:0;bottom:0;max-height:58%;border-top:1px solid var(--line);border-radius:14px 14px 0 0;box-shadow:var(--shadow);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))}
  .rtl{bottom:calc(14px + env(safe-area-inset-bottom,0px))}
  .stats,.keyw,.keybtn,.sync{display:none}
  .playbar .pace span{display:none}.playbar .pace input{width:52px}
  .zoom{bottom:calc(114px + env(safe-area-inset-bottom,0px))}
  .chipbtn{max-width:150px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
