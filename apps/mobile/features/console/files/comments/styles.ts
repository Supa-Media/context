/**
 * The comment margin's stylesheet, appended to the web editor's by
 * `liveEditorWeb/stylesheet.ts`.
 *
 * Values from the palette rather than `--lp-*` properties, for the reason the
 * title line gives there: only the web half draws comments, so a property
 * here would be one the native guest's contract says it must also declare.
 * (No backticks in the CSS comments: this is a template literal.)
 */

import { fonts } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";
import { RAIL_RESERVE } from "./rail";

export function commentStyles(colors: Colors): string {
  return `
.cm-lp-root .cm-scroller { position: relative; }
/*
  With comments in a wide pane the reading column moves left and the right
  side keeps a margin for the cards: the same centring formula as the content's
  own padding, computed over the width minus the margin.
*/
.cm-lp-root .cm-cmt-wide .cm-content {
  padding-left: max(0px, calc((100% - var(--lp-measure) * 1em - ${RAIL_RESERVE}px) / 2));
  padding-right: calc(max(0px, calc((100% - var(--lp-measure) * 1em - ${RAIL_RESERVE}px) / 2)) + ${RAIL_RESERVE}px);
}
.cm-lp-root .cm-cmt-hl {
  background: ${colors.commentWash};
  border-bottom: 2px solid ${colors.warn};
  border-radius: 2px;
  cursor: pointer;
}
.cm-lp-root .cm-cmt-hl-active { background: ${colors.commentWashActive}; }
.cm-lp-root .cm-cmt-hl-resolved { background: transparent; border-bottom-style: dotted; }
.cm-cmt-rail {
  position: absolute;
  inset: 0 auto auto 0;
  width: 0;
  height: 0;
  z-index: 3;
  font-family: ${fonts.body};
  font-size: 13px;
  line-height: 1.45;
  color: ${colors.text};
}
.cm-cmt-card, .cm-cmt-head, .cm-cmt-chip {
  position: absolute;
  box-sizing: border-box;
  transition: top 160ms ease;
}
.cm-cmt-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px;
  background: ${colors.surface};
  border: 1px solid ${colors.line};
  border-radius: 10px;
}
.cm-cmt-card-active { border-color: ${colors.lineStrong}; box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.10); }
.cm-cmt-card-resolved { opacity: 0.75; }
.cm-cmt-msg { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: start; }
.cm-cmt-av {
  width: 22px; height: 22px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 10.5px; font-weight: 700;
  background: ${colors.accentDim}; color: ${colors.accent};
}
.cm-cmt-av-agent { border-radius: 6px; background: ${colors.chipFill}; color: ${colors.markTeam}; }
.cm-cmt-who { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; line-height: 1.3; }
.cm-cmt-who b { font-weight: 600; }
.cm-cmt-tag { font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: ${colors.markTeam}; }
.cm-cmt-when { font-size: 11.5px; color: ${colors.muted}; font-variant-numeric: tabular-nums; }
.cm-cmt-body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; }
.cm-cmt-quote {
  font-size: 12px; color: ${colors.muted};
  border-left: 2px solid ${colors.warn}; padding-left: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cm-cmt-detached, .cm-cmt-problem { font-size: 12px; color: ${colors.muted}; }
.cm-cmt-problem { color: ${colors.critText}; }
.cm-cmt-resolved { display: flex; gap: 8px; align-items: center; font-size: 12px; color: ${colors.okText}; }
.cm-cmt-resolved .cm-cmt-link { margin-left: auto; }
.cm-cmt-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.cm-cmt-compose { display: flex; flex-direction: column; gap: 4px; }
.cm-cmt-input {
  box-sizing: border-box; width: 100%; resize: none; overflow: hidden;
  min-height: 32px; padding: 6px 9px;
  font: inherit; color: ${colors.text};
  background: ${colors.surface}; border: 1px solid ${colors.lineStrong}; border-radius: 7px;
}
.cm-cmt-input:focus { outline: none; border-color: ${colors.accent}; box-shadow: 0 0 0 3px ${colors.accentDim}; }
.cm-cmt-rail button {
  font: inherit; font-size: 12px; cursor: pointer;
  border-radius: 6px; padding: 3px 9px;
  border: 1px solid transparent; background: transparent; color: ${colors.text2};
}
.cm-cmt-rail button:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 1px; }
.cm-cmt-rail .cm-cmt-link:hover, .cm-cmt-rail .cm-cmt-resolve:hover { background: ${colors.chipFill}; color: ${colors.text}; }
.cm-cmt-rail .cm-cmt-resolve { border-color: ${colors.line}; }
.cm-cmt-rail .cm-cmt-primary { background: ${colors.accent}; color: ${colors.surface}; }
.cm-cmt-rail .cm-cmt-chip {
  background: ${colors.surface}; border-color: ${colors.lineStrong}; color: ${colors.text};
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}
.cm-cmt-head { display: flex; justify-content: flex-end; }
.cm-cmt-rail-narrow .cm-cmt-card { box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12); }
@media (prefers-reduced-motion: reduce) {
  .cm-cmt-card, .cm-cmt-head, .cm-cmt-chip { transition: none; }
}
`;
}
