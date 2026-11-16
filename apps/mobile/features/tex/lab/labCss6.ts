/**
 * The step panel's cards (`views/props/CardSwitch.web.tsx`, `RunCard.web.tsx`; Lab live sandbox mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): the Run details / Settings switch, the status line, the run
 * tabs and summary, and a changed setting outlined yellow. `labCss5.ts` appends it.
 */
export const LAB_CSS_6 = String.raw`
.tl .cardrow{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.tl .cardsw{display:flex;gap:2px;background:var(--chip);border-radius:7px;padding:2px}
.tl .cardsw button{border:none;background:none;height:22px;padding:0 9px;border-radius:5px;font-size:12px;font-weight:500;color:var(--muted)}
.tl .cardsw button[aria-pressed=true]{background:var(--page);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.tl .cardsw .cd{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--chg);margin-left:5px;vertical-align:1px}
.tl .cardrow .follow{margin-left:auto;height:24px;font-size:12px;padding:0 8px}
.tl .cardrow .follow.on{color:var(--accent);border-color:transparent;background:var(--accent-dim)}
.tl .runhead{display:flex;flex-direction:column;gap:4px;margin:0 0 8px}
.tl .runmeta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 10px;font-variant-numeric:tabular-nums}
.tl .st{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px}
.tl .st.ok{background:var(--ok-wash);color:var(--ok)}
.tl .st.run{background:var(--accent-dim);color:var(--accent)}
.tl .st.none{background:var(--chip);color:var(--muted)}
.tl .props-pane .tabs{display:flex;gap:2px;padding:6px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tl .props-pane .tabs button{border:none;background:none;padding:3px 8px;border-radius:6px;color:var(--muted);font-weight:500;font-size:12px}
.tl .props-pane .tabs button[aria-pressed=true]{background:var(--s3);color:var(--text)}
.tl .runbody{padding:10px 0}
.tl .runbody pre{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text2)}
.tl .runbody .think{font-size:12px;color:var(--text2);white-space:pre-wrap}
.tl .runbody .empty{color:var(--muted);font-size:12px;padding:6px 0}
.tl .call{border:1px solid var(--line);border-radius:8px;padding:7px 9px;margin-bottom:6px;display:flex;flex-direction:column;gap:3px}
.tl .call .top{display:flex;align-items:center;gap:6px}
.tl .call .top b{font-family:var(--mono);font-size:11px;font-weight:500}
.tl .call .ms{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--dim)}
.tl .call .d{font-size:12px;color:var(--muted)}
.tl .bdg{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:4px;white-space:nowrap}
.tl .bdg.real{background:var(--ok-wash);color:var(--ok)}
.tl .bdg.swr{background:var(--warn-wash);color:var(--warn)}
.tl .bdg.line{background:var(--chip);color:var(--muted)}
.tl .sum{display:flex;flex-direction:column;gap:12px}
.tl .sum .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.tl .sum .stat{background:var(--s2);border:1px solid var(--line);border-radius:8px;padding:6px 8px;min-width:0}
.tl .sum .stat b{display:block;font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl .sum .stat span{font-size:11px;color:var(--muted)}
.tl .sum .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:4px}
.tl .sum .pills{display:flex;gap:4px;flex-wrap:wrap}
.tl .sum .pill{font-size:12px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--accent-dim);color:var(--accent)}
.tl .sum .said{background:var(--s3);border-radius:14px 14px 14px 5px;padding:7px 11px;font-size:13px}
.tl .sum .why{font-size:12px;color:var(--text2);border-left:2px solid var(--line2);padding-left:8px}
.tl .sum .kvs{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px}
.tl .sum .kvs>span>span:nth-child(odd){color:var(--muted);white-space:nowrap}
.tl .sum .kvs>span>span:nth-child(even){min-width:0;overflow-wrap:anywhere}
.tl .sum .cl{display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 0;border-top:1px solid var(--line)}
.tl .sum .cl:first-of-type{border-top:none}
.tl .sum .cl code{font-family:var(--mono);font-size:11px}
.tl .sum .cl .ms{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--dim)}
.tl .sum .more{border:none;background:none;color:var(--accent);font-size:12px;padding:0}
.tl .chgf{outline:2px solid var(--chg);outline-offset:1px;background:var(--chg-wash);border-radius:8px}
.tl .chgf .was,.tl .props-pane .was{display:block;font-size:11px;color:var(--chg);font-weight:600;margin-top:2px}
`;
