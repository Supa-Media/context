/**
 * The comments' stylesheet: the highlights, the phone's sheet and its chip, and
 * the cards' shared parts (the popover's own rules are in `popoverStyles.ts`).
 *
 * Two surfaces draw comments and they hand in their colours differently. The
 * web editor (`liveEditorWeb/stylesheet.ts`) passes the palette itself. The
 * iOS app's web view (`webview/styles.ts`) passes `var(--lp-…)` references,
 * because its palette arrives over the bridge after the stylesheet is written
 * (`themeVars`). So this file takes the colours and the font as arguments and
 * imports nothing from the design tokens, which pull in React Native and must
 * never enter the web view's bundle.
 * (No backticks in the CSS comments: this is a template literal.)
 */

import type { Colors } from "../../../design/theme";

/** The colours comments are drawn in. */
export type CommentPalette = Pick<
  Colors,
  | "commentWash"
  | "commentWashActive"
  | "warn"
  | "text"
  | "text2"
  | "muted"
  | "surface"
  | "line"
  | "lineStrong"
  | "accent"
  | "accentDim"
  | "chipFill"
  | "markTeam"
  | "critText"
  | "okText"
>;

export function commentStyles(colors: CommentPalette, font: string | undefined): string {
  return `${marginStyles(colors)}${sheetStyles(colors, font)}`;
}

function marginStyles(colors: CommentPalette): string {
  return `
.cm-lp-root .cm-scroller { position: relative; }
.cm-lp-root .cm-cmt-hl {
  background: ${colors.commentWash};
  border-bottom: 2px solid ${colors.warn};
  border-radius: 2px;
  cursor: pointer;
}
.cm-lp-root .cm-cmt-hl-active { background: ${colors.commentWashActive}; }
.cm-lp-root .cm-cmt-hl-resolved { background: transparent; border-bottom-style: dotted; }
.cm-cmt-resolved-row { padding: 12px 0 4px; }
.cm-cmt-resolved-toggle { font: inherit; font-size: 12px; color: ${colors.muted}; background: transparent; border: 0; padding: 2px 0; cursor: pointer; }
.cm-cmt-resolved-toggle:hover { color: ${colors.text}; }
.cm-lp-root .cm-cmt-hl { transition: background-color 120ms ease; }
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
.cm-cmt-who .cm-cmt-del { margin-left: auto; }
.cm-cmt-del[hidden] { display: none; }
.cm-cmt-confirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 12.5px; color: ${colors.text2}; }
.cm-cmt-confirm-actions { display: flex; gap: 6px; margin-left: auto; }
.cm-cmt-body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; }
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
/* A tablet's field, typed into with a finger: 16px, or iOS zooms on focus. */
@media (pointer: coarse) { .cm-cmt-input { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .cm-lp-root .cm-cmt-hl { transition: none; } }
`;
}

/*
  The phone's sheet (sheet.ts) and its floating Comment chip. Every field is
  16px: below that iOS zooms the page when the field takes focus.
*/
function sheetStyles(colors: CommentPalette, font: string | undefined): string {
  return `
.cm-cmt-sheet-layer[hidden], .cm-cmt-float[hidden] { display: none !important; }
.cm-cmt-sheet-layer {
  box-sizing: border-box;
  font-family: ${font};
  font-size: 15px;
  line-height: 1.45;
  color: ${colors.text};
  text-align: left;
}
.cm-cmt-sheet-viewport { position: fixed; inset: 0; z-index: 1000; }
.cm-cmt-scrim { position: absolute; inset: 0; background: rgba(0,0,0,0.28); }
.cm-cmt-sheet-viewport .cm-cmt-sheet {
  position: absolute; left: 0; right: 0; bottom: 0;
  max-height: 72vh; overflow-y: auto; overscroll-behavior: contain;
  box-sizing: border-box;
  padding: 6px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  background: ${colors.surface};
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -8px 30px rgba(0,0,0,0.18);
}
.cm-cmt-sheet-inline { position: absolute; z-index: 4; }
.cm-cmt-sheet-inline .cm-cmt-sheet {
  box-sizing: border-box;
  padding: 10px 12px 12px;
  background: ${colors.surface};
  border: 1px solid ${colors.lineStrong};
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12);
}
.cm-cmt-sheet-body { display: flex; flex-direction: column; gap: 12px; }
.cm-cmt-grab { align-self: center; width: 36px; height: 4px; margin: 4px 0 0; border-radius: 2px; background: ${colors.lineStrong}; }
.cm-cmt-sheet-inline .cm-cmt-grab { display: none; }
.cm-cmt-sheet-head { display: flex; align-items: center; gap: 8px; }
.cm-cmt-sheet-title {
  flex: 1; min-width: 0; margin: 0;
  font-size: 15px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cm-cmt-badge { font-size: 12.5px; font-weight: 600; color: ${colors.okText}; }
.cm-cmt-sheet-list { display: flex; flex-direction: column; gap: 14px; }
.cm-cmt-sheet .cm-cmt-msg { grid-template-columns: 28px minmax(0, 1fr); gap: 10px; }
.cm-cmt-sheet .cm-cmt-av { width: 28px; height: 28px; font-size: 12px; }
.cm-cmt-sheet .cm-cmt-resolved, .cm-cmt-sheet .cm-cmt-detached, .cm-cmt-sheet .cm-cmt-problem { font-size: 14px; }
.cm-cmt-sheet button {
  font: inherit; font-size: 15px; cursor: pointer;
  min-height: 40px; padding: 8px 14px; border-radius: 10px;
  border: 1px solid transparent; background: transparent; color: ${colors.text2};
}
.cm-cmt-sheet button:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 1px; }
.cm-cmt-sheet .cm-cmt-del { min-height: 32px; padding: 2px 6px; font-size: 13.5px; color: ${colors.muted}; }
.cm-cmt-sheet .cm-cmt-confirm { font-size: 14px; }
.cm-cmt-sheet .cm-cmt-resolve { border-color: ${colors.line}; }
.cm-cmt-sheet .cm-cmt-primary { background: ${colors.accent}; color: ${colors.surface}; font-weight: 600; }
.cm-cmt-sheet .cm-cmt-danger { background: ${colors.critText}; color: ${colors.surface}; font-weight: 600; }
.cm-cmt-sheet .cm-cmt-close { min-height: 36px; padding: 2px 10px; font-size: 22px; line-height: 1; color: ${colors.muted}; }
.cm-cmt-sheet .cm-cmt-input, .cm-cmt-sheet .cm-cmt-signin {
  box-sizing: border-box; width: 100%;
  min-height: 44px; padding: 10px 12px;
  font: inherit; font-size: 16px; text-align: left;
  color: ${colors.text}; background: ${colors.surface};
  border: 1px solid ${colors.lineStrong}; border-radius: 10px;
}
.cm-cmt-sheet .cm-cmt-signin { color: ${colors.muted}; }
.cm-cmt-float {
  position: absolute; z-index: 5;
  font-family: ${font}; font-size: 15px; font-weight: 600;
  min-height: 40px; padding: 8px 16px;
  border: none; border-radius: 10px;
  background: ${colors.text}; color: ${colors.surface};
  box-shadow: 0 3px 10px rgba(0,0,0,0.2);
  cursor: pointer;
}
`;
}
