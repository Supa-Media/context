/**
 * The Chat view of the test chat, iMessage style (Dev, 2026-11-24, approved artboards 03 to 09 of
 * `group-chat-sim-artboards/`, ported from its `kit/imsg.js`): bubbles in runs with tails, names and avatars, tapbacks,
 * inline replies, edits, media cards, Tex typing, the why line under each text and its detail, the hover tools, and
 * the composer (Texting as, the + menu, a staged photo, @mention). Every chat rule is scoped to `.imsg`, the Lab's
 * other `.r`/`.b` rules untouched; `--bin`/`--bout` are its two bubble colors. `labCss5.ts` appends it.
 */
export const LAB_CSS_CHAT = String.raw`
.tl{--bin:color-mix(in srgb,var(--text) 8%,var(--page));--bout:var(--accent);--bout-t:#fff}
.tl[data-theme="dark"]{--bin:color-mix(in srgb,var(--text) 14%,var(--page));--bout:#4A63E3;--bout-t:#fff}
@media (prefers-color-scheme: dark){.tl:not([data-theme="light"]){--bin:color-mix(in srgb,var(--text) 14%,var(--page));--bout:#4A63E3;--bout-t:#fff}}
.tl .imsg{flex:1;min-height:0;overflow:auto;background:var(--page);border-top:1px solid var(--line)}
.tl .imw{max-width:880px;margin:0 auto;padding:14px 28px 10px;display:flex;flex-direction:column}
.tl .imsg .tm2,.tl .imsg .ev{text-align:center;font-size:11.5px;color:var(--muted);margin:12px 0 6px;line-height:1.4}
.tl .imsg .tm2 b{font-weight:600;color:var(--text2)}
.tl .imsg .ev{margin:12px 0 6px}
.tl .imsg .r{display:flex;align-items:flex-end;gap:8px;margin-top:2px;position:relative}
.tl .imsg .r.first{margin-top:12px}
.tl .imsg .r.out{flex-direction:row-reverse}
.tl .imsg .r .avc{width:28px;flex:none;align-self:flex-end;position:relative;z-index:5}
.tl .imsg .r .avc .av{width:28px;height:28px;font-size:12px}
.tl .imsg .r.out .avc{display:none}
.tl .av.tex{background:var(--text);color:var(--page);font-weight:700;font-size:11px;letter-spacing:-.02em}
.tl .imsg .r .bc{display:flex;flex-direction:column;align-items:flex-start;max-width:66%;min-width:0}
.tl .imsg .r.out .bc{align-items:flex-end}
.tl .imsg .nm2{font-size:11.5px;color:var(--muted);margin:12px 0 3px 48px}
.tl .imsg .und{display:flex;flex-direction:column;align-items:flex-start;padding-left:36px;max-width:100%}
.tl .imsg .und.out{align-items:flex-end;padding-left:0}
.tl .imsg .nm2 .gst{color:var(--dim)}
.tl .imsg .bw{position:relative;max-width:100%}
.tl .imsg .r.tb .bw{margin-top:14px}
.tl .imsg .b{position:relative;display:inline-block;max-width:100%;padding:7px 13px 8px;border-radius:18px;font-size:15px;line-height:1.34;background:var(--bin);color:var(--text);overflow-wrap:anywhere;white-space:pre-line}
.tl .imsg .b .bt{position:relative;z-index:1}
.tl .imsg .r.out .b{background:var(--bout);color:var(--bout-t)}
.tl .imsg .r.in .b.tail::before{content:"";position:absolute;bottom:0;left:-7px;width:20px;height:17px;background:var(--bin);border-bottom-right-radius:16px 14px}
.tl .imsg .r.in .b.tail::after{content:"";position:absolute;bottom:0;left:-26px;width:26px;height:17px;background:var(--page);border-bottom-right-radius:10px}
.tl .imsg .r.out .b.tail::before{content:"";position:absolute;bottom:0;right:-7px;width:20px;height:17px;background:var(--bout);border-bottom-left-radius:16px 14px}
.tl .imsg .r.out .b.tail::after{content:"";position:absolute;bottom:0;right:-26px;width:26px;height:17px;background:var(--page);border-bottom-left-radius:10px}
/* tapbacks */
.tl .imsg .tbs{position:absolute;top:-15px;display:flex;z-index:3}
.tl .imsg .r.in .tbs{right:-14px}
.tl .imsg .r.out .tbs{left:-14px;flex-direction:row-reverse}
.tl .imsg .tbk{width:32px;height:30px;border-radius:16px;display:grid;place-items:center;font-size:15px;background:var(--bin);border:2px solid var(--page);margin-left:-9px;position:relative}
.tl .imsg .r.out .tbk{margin-left:0;margin-right:-9px}
.tl .imsg .tbk.me{background:var(--bout)}
.tl .imsg .tbk.tex::after{content:"T";position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border-radius:50%;background:var(--text);color:var(--page);font-size:7.5px;font-weight:700;display:grid;place-items:center;border:1.5px solid var(--page)}
.tl .imsg .stk{position:absolute;font-size:40px;transform:rotate(12deg);bottom:18px;right:-22px;z-index:4;filter:drop-shadow(0 2px 3px rgba(0,0,0,.18))}
/* under-bubble lines */
.tl .imsg .st2{font-size:11px;color:var(--muted);margin:3px 4px 0;font-weight:500}
.tl .imsg .edl{font-size:11px;color:var(--accent);margin:3px 4px 0;font-weight:500}
.tl .imsg .wy{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dim);margin:3px 6px 0;white-space:nowrap;cursor:pointer;border-radius:6px;padding:1px 4px}
.tl .imsg .wy:hover{background:var(--s3)}
.tl .imsg .wy .v{font-weight:600;color:var(--muted)}
.tl .imsg .wy.yes .v{color:var(--accent)}
.tl .imsg .wy.yes::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent)}
.tl .imsg .wy.no::before{content:"";width:5px;height:5px;border-radius:50%;border:1.2px solid var(--dim)}
.tl .imsg .wy .car2{font-size:9px;color:var(--dim)}
.tl .imsg .whyx{margin:5px 0 4px;border:1px solid var(--line2);background:var(--s2);border-radius:10px;padding:8px 10px;font-size:12px;width:460px;max-width:100%;white-space:normal}
.tl .imsg .whyx .wxr{display:grid;grid-template-columns:58px 78px 48px minmax(0,1fr);gap:8px;align-items:baseline;padding:4px 0;margin:0;border-top:1px solid var(--line);font-family:var(--f);font-size:12px}
.tl .imsg .whyx .wxr > span{padding:0;margin:0;white-space:normal}
.tl .imsg .whyx .wxr:first-of-type{border-top:none}
.tl .imsg .whyx .wsn{font-weight:600;color:var(--text);font-family:var(--f);font-size:12px}
.tl .imsg .whyx .wso{color:var(--text2)}
.tl .imsg .whyx .wso.no{color:var(--muted)}
.tl .imsg .whyx .wms{font-family:var(--mono);font-size:10.5px;color:var(--dim)}
.tl .imsg .whyx .wrs{color:var(--muted)}
.tl .imsg .whyx .wxh{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11.5px;color:var(--muted)}
.tl .imsg .whyx .wxh b{color:var(--text);font-weight:600}
.tl .imsg .whyx .wxf{display:flex;gap:6px;margin-top:6px}
.tl .imsg .whyx .wxf .ghost{height:24px;font-size:11.5px}
.tl .imsg .evchg{align-self:center;font-size:12px;color:var(--text);background:var(--chg-wash);border:1px solid color-mix(in srgb,var(--chg) 45%,transparent);border-radius:8px;padding:4px 10px;margin:0 0 6px}
/* media */
.tl .imsg .pgr{display:grid;gap:2px;border-radius:18px;overflow:hidden;width:330px}
.tl .imsg .pgr.n2{grid-template-columns:1fr 1fr;height:200px}
.tl .imsg .pgr.n3{grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;height:220px}
.tl .imsg .pgr.n3 > :first-child{grid-row:1 / span 2}
.tl .imsg .pgr.n1{width:210px;height:190px}
.tl .imsg .ph1{position:relative;overflow:hidden}
.tl .imsg .ph-wb{background:linear-gradient(160deg,#f3f1ec,#e3e0d8)}
.tl .imsg .ph-wb i{position:absolute;width:34px;height:34px;border-radius:2px;box-shadow:0 2px 3px rgba(0,0,0,.15)}
.tl .imsg .ph-wb s{position:absolute;height:3px;border-radius:2px;background:#3b4a8a;opacity:.7}
.tl .imsg .ph-site{background:#fff;display:flex;flex-direction:column;padding:10px 8px;gap:6px}
.tl .imsg .ph-site .hb{height:8px;border-radius:3px;background:#1f2a5c;width:55%}
.tl .imsg .ph-site .hs{height:5px;border-radius:3px;background:#c9cde0;width:80%}
.tl .imsg .ph-site .cols{display:flex;gap:4px;flex:1;margin-top:6px}
.tl .imsg .ph-site .cols div{flex:1;border:1.5px solid #d7dbea;border-radius:5px;display:flex;flex-direction:column;align-items:center;padding-top:8px;gap:4px}
.tl .imsg .ph-site .cols div.hi{border-color:#2A45CF;background:#eef1ff}
.tl .imsg .ph-site .cols b{display:block;width:60%;height:7px;border-radius:2px;background:#1f2a5c}
.tl .imsg .ph-site .cols em{display:block;width:70%;height:4px;border-radius:2px;background:#c9cde0}
.tl .imsg .ph-cafe{background:radial-gradient(circle at 70% 30%,#f6d9a8,#c9874d 60%,#7a4a2a)}
.tl .imsg .ph-cafe i{position:absolute;border-radius:50%;background:radial-gradient(circle,#fff 55%,#e9e1d6 57%);box-shadow:0 3px 6px rgba(0,0,0,.25)}
.tl .imsg .ph-menu{background:linear-gradient(170deg,#f8f3ea,#eadfcd);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;font-family:Georgia,serif;color:#3a2a1a}
.tl .imsg .ph-menu .mt{font-size:15px;letter-spacing:.12em}
.tl .imsg .ph-menu .ml{font-size:11.5px;font-style:italic}
.tl .imsg .ph-menu .rule2{width:40%;height:1px;background:#3a2a1a;opacity:.4}
.tl .imsg .voice{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 8px}
.tl .imsg .voice .pl{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--text) 14%,transparent);font-size:11px;color:var(--text)}
.tl .imsg .voice .vwf{display:flex;align-items:center;gap:2px;height:26px}
.tl .imsg .voice .vwf i{width:3px;border-radius:2px;background:var(--muted)}
.tl .imsg .voice .vwf i.pl2{background:var(--text)}
.tl .imsg .voice .du{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.tl .imsg .filec{display:flex;align-items:center;gap:10px;padding:9px 14px 9px 10px;min-width:250px}
.tl .imsg .filec .fi{width:30px;height:38px;border-radius:4px;background:var(--page);position:relative;display:grid;place-items:end center;padding-bottom:4px;font-size:8px;font-weight:700;color:#B23A32;border:1px solid var(--line2)}
.tl .imsg .filec .fn{font-size:14px;font-weight:600;line-height:1.25}
.tl .imsg .filec .fs{font-size:12px;color:var(--muted)}
.tl .imsg .lnk{width:300px;border-radius:18px;overflow:hidden;background:var(--bin);font-size:13px}
.tl .imsg .r.out .lnk{background:var(--bout);color:#fff}
.tl .imsg .lnk .li{height:132px;position:relative;overflow:hidden}
.tl .imsg .lnk .lt{padding:8px 13px 10px;line-height:1.3}
.tl .imsg .lnk .lt b{display:block;font-weight:600;color:var(--text)}
.tl .imsg .r.out .lnk .lt b{color:#fff}
.tl .imsg .lnk .lt span{color:var(--muted);font-size:12px}
.tl .imsg .r.out .lnk .lt span{color:rgba(255,255,255,.75)}
.tl .imsg .li-check{background:#fbfaf7;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.tl .imsg .li-check .t1{height:9px;width:50%;background:#1A1714;border-radius:2px}
.tl .imsg .li-check .cr{display:flex;align-items:center;gap:7px}
.tl .imsg .li-check .cr i{width:11px;height:11px;border:1.5px solid #7A7264;border-radius:3px}
.tl .imsg .li-check .cr i.on{background:#3E7A4E;border-color:#3E7A4E}
.tl .imsg .li-check .cr s{height:5px;border-radius:2px;background:#cfc8bb}
.tl .imsg .li-tart{background:radial-gradient(circle at 50% 55%,#e8b35f 0 34%,#b9752f 35% 41%,#f1e6d4 42%)}
.tl .imsg .contact{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 8px;min-width:240px}
.tl .imsg .contact .ca{width:40px;height:40px;border-radius:50%;background:linear-gradient(#a9aebd,#868b99);color:#fff;display:grid;place-items:center;font-weight:600;font-size:15px}
.tl .imsg .contact .cn{font-size:14.5px;font-weight:600;line-height:1.25}
.tl .imsg .contact .cs{font-size:12px;color:var(--muted)}
.tl .imsg .contact .chev{margin-left:auto;color:var(--dim);font-size:16px}
.tl .imsg .typing{display:flex;gap:4px;padding:12px 14px}
.tl .imsg .typing i{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.tl .imsg .typing i:nth-child(2){opacity:.7}.tl .imsg .typing i:nth-child(3){opacity:.45}
.tl .imsg .typenote{font-size:11px;color:var(--dim);margin:3px 6px 0}
/* inline reply thread */
.tl .imsg .thq{display:flex;flex-direction:column;margin-top:12px;align-items:flex-start;padding-left:36px}
.tl .imsg .thq.out{align-items:flex-end;padding-left:0;padding-right:0}
.tl .imsg .thq .qb{opacity:.6;font-size:13px;padding:5px 11px;border-radius:15px;background:var(--bin);color:var(--text);max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl .imsg .thq .ln{display:block;width:14px;height:12px;border-left:2px solid var(--line2);border-bottom:2px solid var(--line2);border-bottom-left-radius:10px;margin-left:18px}
.tl .imsg .thq.out .ln{border-left:none;border-right:2px solid var(--line2);border-bottom-left-radius:0;border-bottom-right-radius:10px;margin-left:0;margin-right:18px}
.tl .imsg .nm2 + .thq{margin-top:0}
.tl .imsg .thq + .nm2,.tl .imsg .thq + .r{margin-top:0}
.tl .imsg .rcount{font-size:11px;color:var(--accent);margin:3px 6px 0;font-weight:500}
/* hover tools, picker, edit */
.tl .imsg .hov{position:absolute;top:50%;transform:translateY(-50%);display:flex;gap:2px;background:var(--page);border:1px solid var(--line2);border-radius:8px;padding:2px;box-shadow:var(--shadow);z-index:6}
.tl .imsg .r.in .hov{left:calc(100% + 8px)}
.tl .imsg .r.out .hov{right:calc(100% + 8px)}
.tl .imsg .hov .ib{width:26px;height:26px;border:none;background:none;font-size:13px}
.tl .imsg .hov .ib[aria-pressed=true]{background:var(--accent-dim);color:var(--accent)}
.tl .imsg .tpk{position:absolute;bottom:calc(100% + 8px);left:-4px;display:flex;align-items:center;gap:2px;background:var(--page);border:1px solid var(--line2);border-radius:22px;padding:4px 6px;box-shadow:var(--shadow);z-index:7;white-space:nowrap}
.tl .imsg .tpk button{width:34px;height:34px;border-radius:50%;border:none;background:none;font-size:19px;display:grid;place-items:center}
.tl .imsg .tpk button.on{background:var(--accent-dim)}
.tl .imsg .tpk .more{font-size:15px;color:var(--muted);background:var(--s3)}
.tl .imsg .tpk .asw{font-size:11px;color:var(--dim);padding:0 6px 0 4px}
.tl .imsg .b.lift{box-shadow:0 0 0 2px var(--page),0 0 0 4px var(--accent-dim),0 6px 18px rgba(0,0,0,.12)}
.tl .imsg .ctxm{position:absolute;top:-4px;left:calc(100% + 102px);z-index:7;width:270px}
.tl .imsg .ctxm.popm{position:absolute}
.tl .imsg .edf{display:flex;align-items:center;gap:6px}
.tl .imsg .edf .ein{min-width:300px;border:2px solid var(--bout);border-radius:18px;padding:7px 13px;font-size:15px;background:var(--page);color:var(--text);line-height:1.34}
.tl .imsg .edf .ein .cur{display:inline-block;width:1.5px;height:17px;background:var(--accent);vertical-align:-3px;margin-left:1px}
.tl .imsg .edf .ok{width:28px;height:28px;border-radius:50%;border:none;background:var(--bout);color:#fff;font-size:14px;display:grid;place-items:center}
.tl .imsg .edf .x{width:28px;height:28px;border-radius:50%;border:none;background:var(--s3);color:var(--muted);font-size:12px;display:grid;place-items:center}
.tl .imsg .ednote{font-size:11px;color:var(--dim);margin:4px 6px 0}
/* composer */
.tl .asrow{display:flex;align-items:center;gap:6px;padding:7px 14px 0;background:var(--page);border-top:1px solid var(--line2)}
.tl .asrow .lbl{font-size:12px;color:var(--dim);margin-right:2px}
.tl .asc{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 4px;border-radius:999px;border:1px solid transparent;background:var(--chip);font-size:12.5px;color:var(--text2)}
.tl .asc[aria-pressed=true]{background:var(--accent-dim);border-color:var(--accent);color:var(--text);font-weight:600}
.tl .asc.hv{border-color:var(--line2)}
.tl .asc .av{width:20px;height:20px;font-size:10px}
.tl .asrow .note2{margin-left:auto;font-size:11.5px;color:var(--dim)}
.tl .imc{display:flex;align-items:flex-end;gap:8px;padding:8px 14px 10px;background:var(--page);position:relative}
.tl .imc .plus{width:34px;height:34px;border-radius:50%;border:none;background:var(--s3);color:var(--text2);font-size:21px;line-height:1;display:grid;place-items:center;flex:none}
.tl .imc .plus[aria-expanded=true]{background:var(--accent-dim);color:var(--accent)}
.tl .imc .ifld{flex:1;min-width:0;border:1px solid var(--line2);border-radius:19px;background:var(--page);display:flex;flex-direction:column;padding:4px 4px 4px 14px}
.tl .imc .ifld .row1{display:flex;align-items:center;gap:6px;min-height:28px}
.tl .imc .ifld .tx{flex:1;font-size:15px;color:var(--dim)}
.tl .imc .ifld .tx.has{color:var(--text)}
.tl .imc .ifld .tx .mn{color:var(--accent);font-weight:600}
.tl .imc .ifld .tx .cur{display:inline-block;width:1.5px;height:17px;background:var(--accent);vertical-align:-3px;margin-left:1px}
.tl .imc .send{width:28px;height:28px;border-radius:50%;border:none;background:var(--bout);color:#fff;display:grid;place-items:center;flex:none}
.tl .imc .send:disabled{background:var(--line2);color:var(--page)}
.tl .imc .send svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.tl .imc .stg{display:flex;gap:6px;padding:6px 0 4px}
.tl .imc .stg .th2{position:relative;width:84px;height:84px;border-radius:12px;overflow:hidden}
.tl .imc .stg .th2 button{position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:10px;display:grid;place-items:center}
.tl .pmenu{position:absolute;left:10px;bottom:calc(100% + 6px);width:290px;z-index:8}
.tl .pmenu.popm{position:absolute}
.tl .pmenu .mi .ic{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;font-size:14px;background:var(--s3)}
.tl .mmenu{position:absolute;left:56px;bottom:calc(100% + 6px);width:290px;z-index:8}
.tl .mmenu.popm{position:absolute}
.tl .mmenu .mi .av{width:22px;height:22px;font-size:10px}
.tl .mmenu .mi .nm b{color:var(--accent)}
/* the Lab's own: the dock in Chat view, live controls the artboards drew still */
.tl .sbx .imsg{background:var(--page)}
.tl .sbx.fill{flex:1 1 auto;height:auto!important;max-height:none}
.tl .archsplit:has(.sbx.fill) .archcv{display:none}
.tl .imsg .scne{padding:24px;text-align:center;color:var(--muted)}
.tl .imsg .hov{display:none}
.tl .imsg .bw:hover > .hov,.tl .imsg .bw.act > .hov{display:flex}
.tl .imsg .r.in .hov::before{content:"";position:absolute;right:100%;top:0;bottom:0;width:10px}
.tl .imsg .r.out .hov::before{content:"";position:absolute;left:100%;top:0;bottom:0;width:10px}
.tl .imsg .r.out .tpk{left:auto;right:-4px}
.tl .imsg .r.out .ctxm{left:auto;right:calc(100% + 102px)}
.tl .imsg .tpk .anyin{width:56px;height:30px;border:1px solid var(--line2);border-radius:15px;background:var(--page);color:var(--text);font-size:15px;text-align:center}
.tl .imsg .pgr img{width:100%;height:100%;object-fit:cover;display:block}
.tl .imsg .pgr.n4,.tl .imsg .pgr.n5,.tl .imsg .pgr.n6{grid-template-columns:1fr 1fr;grid-auto-rows:110px}
.tl .imsg .pgr.n1 img{max-height:260px}
.tl .imsg .pgr.n1{height:auto}
.tl .imsg .edf .ein{outline:none;font-family:inherit}
.tl .imsg .wy{border:none;background:none;font-family:inherit}
.tl .imsg .wy .wyr{overflow:hidden;text-overflow:ellipsis;max-width:520px}
.tl .imsg .whyx .wxf .ghost{display:inline-flex;align-items:center;gap:4px}
.tl .imsg .ev{position:relative}
.tl .imsg .ev .evx{display:none;margin-left:6px;border:none;background:none;color:var(--dim);font-size:11.5px;cursor:pointer}
.tl .imsg .ev:hover .evx{display:inline}
.tl .imsg .ev.mut{color:var(--dim);font-size:11px;letter-spacing:.02em}
.tl .imsg .lnk a{color:inherit;text-decoration:none}
.tl .imsg .stk.alone{position:static;display:inline-block}
.tl .imcw{position:relative;background:var(--page)}
.tl .imcw .pend{border-top:1px solid var(--line2)}
.tl .imc .ifld .tx{border:none;background:none;outline:none;padding:4px 0;font-family:inherit;min-width:0}
.tl .imc .ifld .tx::placeholder{color:var(--dim)}
.tl .imc .stg .th2 img{width:100%;height:100%;object-fit:cover;display:block}
.tl .pmenu .mi:disabled .meta{opacity:1}
.tl .mmenu .mi .meta{margin-left:auto;font-size:12px;color:var(--dim)}
.tl .imsg .tpk .anyin{width:34px;height:34px;border:none;border-radius:17px;background:var(--s3);color:var(--muted);transition:width .15s}
.tl .imsg .tpk .anyin:focus{width:64px;background:var(--page);box-shadow:0 0 0 1px var(--line2) inset;color:var(--text)}
.tl .imsg .tpk .anyin::placeholder{color:var(--muted)}
.tl .imsg .r.out .ednote{text-align:right}
/* Tex's sends on its iMessage line (round 3, group-chat-features-artboards): a tag is the name, bold, no @ */
.tl .imsg .b .mtg{font-weight:600;color:var(--accent)}
.tl .imsg .r.out .b .mtg{color:#fff}
.tl .imsg .fxl{font-size:11px;color:var(--muted);margin:3px 6px 0;font-weight:500;white-space:nowrap}
.tl .imsg .fxl .rp{border:none;background:none;padding:0;font:inherit;color:var(--accent);margin-left:4px;cursor:pointer}
.tl .imsg .b.ink{cursor:pointer;background-color:var(--bin);--sp:color-mix(in srgb,var(--text) 55%,transparent);background-image:radial-gradient(var(--sp) .9px,transparent 1.3px),radial-gradient(var(--sp) .7px,transparent 1.1px),radial-gradient(color-mix(in srgb,var(--text) 30%,transparent) 1px,transparent 1.4px);background-size:5px 4px,7px 5px,4px 6px;background-position:0 0,2px 3px,3px 1px}
.tl .imsg .b.ink .bt{color:transparent}
.tl .imsg .inkh{font-size:11px;color:var(--dim);margin:3px 6px 0}
.tl .imsg .inkh b{color:var(--accent);font-weight:600}
.tl .imsg .poll{width:330px;max-width:100%;box-sizing:border-box;border-radius:18px;background:var(--bin);padding:11px 12px 10px;color:var(--text)}
.tl .imsg .poll .plh{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.tl .imsg .poll .plh svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round}
.tl .imsg .poll .plq{font-size:15.5px;font-weight:600;margin:2px 2px 7px;line-height:1.3}
.tl .imsg .poll .opt{position:relative;display:flex;align-items:center;gap:9px;height:33px;padding:0 10px;border-radius:10px;background:var(--page);margin-top:4px;overflow:hidden;font-size:14px}
.tl .imsg .poll .opt .ck{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dim);flex:none}
.tl .imsg .poll .opt .ol{flex:1;min-width:0}
.tl .imsg .poll .opt .nc{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:10px;text-align:right;margin-left:6px}
.tl .imsg .poll .plf{font-size:11.5px;color:var(--muted);margin:6px 2px 0}
.tl .imsg .ev .evth{display:inline-block;width:22px;height:22px;border-radius:50%;object-fit:cover;vertical-align:-7px;margin-right:6px;box-shadow:0 0 0 1px var(--line2)}
/* phone width: the hint gives its room to the people */
@media (max-width:700px){.tl .asrow{flex-wrap:wrap;row-gap:4px}.tl .asrow .note2{display:none}.tl .imw{padding:10px 10px 8px}}
`;
