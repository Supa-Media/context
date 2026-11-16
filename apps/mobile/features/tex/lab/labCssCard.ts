/**
 * The Lab live sandbox's step card and sandbox write viewer (approved mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): the step panel floats on the canvas's top right as the mockup's
 * `.ins` card (340px, 420px focused, a sheet at phone width), its status beside the name, the short Settings list with
 * changed fields outlined yellow, a foot that stays put, a run's finished steps outlined blue, and the modal a sandbox
 * page, email or note opens in. The Lab's compact scale: 13px text, 12px meta, 28px controls. `labCss5.ts` appends it.
 */
export const LAB_CSS_CARD = String.raw`
.tl #props.ins{position:absolute;top:12px;right:12px;bottom:60px;left:auto;width:min(340px,calc(100% - 24px));flex-direction:column;align-items:stretch;padding:0;gap:0;overflow:hidden;z-index:5;background:var(--page)}
.tl #props.ins[hidden]{display:none}
.tl #props.ins.wide{width:min(420px,calc(100% - 24px))}
.tl #props .insbd{flex:1;min-height:0;overflow:auto;padding:10px 14px 0;display:flex;flex-direction:column}
.tl #props .pclose{position:absolute;top:8px;right:8px;width:28px!important;height:28px!important;z-index:3}
.tl #props .cardrow{padding-right:34px}
.tl #props .ph{gap:8px;margin-bottom:2px}
.tl #props .ph input{flex:0 1 auto;field-sizing:content;min-width:4ch;max-width:62%;font-size:15px;padding:3px 4px}
.tl #props .ph .st{flex:none}
.tl #props .ph .pfocus{margin-left:auto;height:24px;font-size:12px;padding:0 8px}
.tl #props .was{display:block;font-size:11px;color:var(--chg);font-weight:600;margin-top:2px}
.tl #props .insft{position:sticky;bottom:0;margin:10px -14px 0;padding:8px 14px;border-top:1px solid var(--line);background:var(--page);font-size:11px;color:var(--dim);margin-top:auto}
.tl #props .insft code,.tl .sbwrites code{font-family:var(--mono);font-size:11px;background:var(--chip);padding:1px 4px;border-radius:4px}
.tl .archcv.withcard .ctop{right:364px}
.tl #props .setf{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 10px;align-items:center;font-size:12px;margin:6px 0 10px}
.tl #props .setf>label{color:var(--muted)}
.tl #props .setf select,.tl #props .setf input{height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--s2);padding:0 8px;min-width:0;width:100%;box-sizing:border-box;font-size:12px}
.tl #props .setf .unit{display:flex;align-items:center;gap:6px;color:var(--muted)}
.tl #props .setf .chgf{outline:none;background:none}
.tl #props .setf .chgf select,.tl #props .setf .chgf input{border:2px solid var(--chg);background:var(--chg-wash)}
.tl #props .setf .chgf .mods{outline:2px solid var(--chg);outline-offset:2px;border-radius:5px;background:var(--chg-wash)}
.tl #props .setf .mods{display:flex;flex-wrap:wrap;gap:4px}
.tl #props .setf .mods span{font-size:11px;background:var(--chip);border-radius:5px;padding:2px 6px;font-family:var(--mono)}
.tl #props .setf .mods .none{font-family:var(--f);color:var(--dim);background:none;padding:2px 0}
.tl #props #nMore{align-self:flex-start;border:none;background:none;color:var(--accent);font-size:12px;padding:0 0 8px}
.tl .nd.lit.done .card{stroke:var(--accent);stroke-width:1.6;fill:color-mix(in srgb,var(--accent) 7%,var(--page))}
.tl .sbwrites .wr.open{width:100%;border:none;background:none;text-align:left;cursor:pointer;border-radius:6px;align-items:center}
.tl .sbwrites .wr.open:hover{background:var(--s3)}
.tl .sbwrites .wr .wt{display:flex;flex-direction:column;min-width:0}
.tl .sbwrites .wr .sub{font-size:11px;color:var(--muted)}
.tl .sbwrites .wr .meta{margin-left:auto;color:var(--dim);font-size:12px;padding-left:10px}
.tl .sbscrim{position:fixed;inset:0;background:rgba(10,8,6,.35);z-index:70;display:grid;place-items:center;padding:16px}
.tl .sbmodal{background:var(--page);border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);width:min(720px,100%);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
.tl .sbmodal .mh{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
.tl .sbmodal .mh b{font-size:14px}
.tl .sbmodal .url{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--chip);padding:3px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tl .sbmodal .mb{overflow:auto;min-height:0}
.tl .sbmodal .banner{background:var(--warn-wash);color:var(--warn);font-size:12px;padding:6px 14px;font-weight:500}
.tl .sbmodal .mnote{padding:14px;font-size:12px;color:var(--muted)}
.tl .sbmodal .pagev,.tl .sbmodal .notev{margin:0;padding:14px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text2)}
.tl .sbmodal .mailv{padding:14px;font-size:13px}
.tl .sbmodal .mailv .kv{display:grid;grid-template-columns:70px 1fr;gap:4px 10px;padding-bottom:10px;border-bottom:1px solid var(--line);margin-bottom:10px}
.tl .sbmodal .mailv .kv span:nth-child(odd){color:var(--muted)}
.tl .sbmodal .mailb{white-space:pre-wrap}
@media (max-width:760px){.tl #props.ins,.tl #props.ins.wide{top:auto;left:12px;right:12px;width:auto;bottom:12px;height:55%}.tl .archcv.withcard .ctop{right:12px}}
`;
