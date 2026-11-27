/**
 * The step panel as redesigned on 2026-11-26 (Dev: "the goal should literally be the first thing I see when clicking
 * on a node"; artboards in the project's `node-panel-artboards/`): the name, the goal as plain text that edits in
 * place, one line of facts, the card switch, then one settings list, quiet "+ Add a case", a closed "More" and Delete
 * set apart. `labCss5.ts` appends it after the card's own rules, so these win where they differ.
 */
export const LAB_CSS_PANEL = String.raw`
.tl #props .ph{padding-right:34px;margin:0}
.tl #props .ph input{flex:1 1 auto;max-width:none;font-size:16px;font-weight:600}
.tl #props .goal{font-size:14px;line-height:1.5;color:var(--text);margin:6px -8px 0;padding:6px 8px;border-radius:8px;cursor:text;white-space:pre-wrap;overflow-wrap:anywhere}
.tl #props .goal:hover{background:var(--chip)}
.tl #props .goal:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.tl #props .goal.empty{color:var(--dim);font-style:italic}
.tl #props .goal.chgf{outline:2px solid var(--chg);outline-offset:-2px;background:var(--chg-wash)}
.tl #props .goal .was{font-style:normal;white-space:normal}
.tl #props .goaled{margin:6px 0 0}
.tl #props .goaled textarea{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:14px;line-height:1.5;color:var(--text);border:2px solid var(--accent);border-radius:8px;background:var(--page);padding:4px 6px;resize:none;outline:none;overflow:hidden}
.tl #props .goaled .gk{display:flex;justify-content:flex-end;gap:10px;font-size:11px;color:var(--dim);margin-top:4px}
.tl #props .runhead{margin:4px 0 12px}
.tl #props .runmeta{align-items:center}
.tl #props .runmeta .mdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.tl #props .runmeta>span+span:not(.st)::before{content:"·";margin-right:10px;color:var(--dim)}
.tl #props .runmeta .st{margin-left:auto}
.tl #props .cardrow{padding-right:0;margin:0 0 4px}
.tl #props .grp>h4{font-size:12px;font-weight:600;color:var(--text)}
.tl #props .grp>h4 small{float:right;font-weight:400;color:var(--dim);font-size:11px;font-family:var(--mono)}
.tl #props .setgrp .setf{margin:0}
.tl #props .setf>label:not(.stl){align-self:start;line-height:28px}
.tl #props .changes{border:2px solid var(--chg);background:var(--chg-wash);border-radius:10px;padding:10px 12px;margin:0 0 12px;display:flex;flex-direction:column;gap:8px}
.tl #props .changes h4{font-size:12px;font-weight:600;color:var(--text)}
.tl #props .changes .box{background:var(--page)}
.tl #props .changes .flex .lnk{font-size:12px}
.tl #props .changes .lnk:disabled{color:var(--dim)}
.tl #props .setf .ro{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tl #props .setf .ro select{flex:1;width:auto}
.tl #props .setf .ro .was{flex-basis:100%;margin-top:0}
.tl #props .setf .ro .lnk{white-space:nowrap}
.tl #props .setf input[disabled]{color:var(--muted)}
.tl #props .setgrp .mform{margin-top:10px}
.tl #props .pillrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.tl #props .mnote{font-size:12px;color:var(--muted);margin:8px 0 0;line-height:1.45}
.tl #props .ghostadd{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:1px dashed var(--line2);border-radius:7px;background:none;color:var(--accent);font-size:12px;margin-top:2px;align-self:flex-start}
.tl #props .ncases .hint{margin:0}
.tl #props .ncases .ghostadd{justify-self:start}
.tl #props #nMore.adv{color:var(--muted);padding:12px 0}
.tl #props .adv{display:flex;align-items:center;gap:6px;border:none;border-top:1px solid var(--line);background:none;padding:12px 0;color:var(--muted);font-size:12px;font-weight:600;width:100%;text-align:left;border-radius:0}
.tl #props .adv .car{display:inline-block;transition:transform .15s}
.tl #props .adv[aria-expanded=true] .car{transform:rotate(90deg)}
.tl #props .adv small{font-weight:400;color:var(--dim);margin-left:auto}
.tl #props .advbody{padding:0 0 4px}
.tl #props .advbody .sub{font-size:11px;color:var(--muted);margin:12px 0 4px}
.tl #props .advbody>.sub:first-child{margin-top:0}
.tl #props .advbody .file{font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--text2);background:var(--chip);border-radius:6px;padding:6px 8px;word-break:break-all;margin:0}
.tl #props .advbody .lgno{margin:6px 0 0}
.tl #props .advbody textarea.note{width:100%;box-sizing:border-box}
<<<<<<< HEAD
.tl #props .wr .wrn{color:var(--dim);font-size:11px;font-family:var(--mono)}
=======
>>>>>>> 8a8d352829093aae6b2d930583be24b1821c12ff
.tl #props .delrow{padding:16px 0 12px}
`;
