/**
 * The mail section's stylesheet (`extension.ts`). Takes its colours and font
 * the way `comments/styles.ts` does, for the same two surfaces and the same
 * reason: the iOS web view hands in `var(--lp-…)` references, and nothing
 * here may pull design tokens into the web view's bundle.
 * (No backticks in the CSS comments: this is a template literal.)
 */

import type { CommentPalette } from "../comments/styles";

export function mailStyles(colors: CommentPalette, font: string | undefined): string {
  return `
.cm-lp-root .cm-mail {
  margin: 18px 0 8px;
  border-top: 1px solid ${colors.line};
  font-family: ${font};
  font-size: 13px;
  line-height: 1.45;
  color: ${colors.text};
  cursor: default;
}
.cm-lp-root .cm-mail-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 10px 0; margin: 0;
  font: inherit; font-size: 13px; text-align: left; cursor: pointer;
  background: transparent; border: 0; color: ${colors.muted};
}
.cm-lp-root .cm-mail-head:hover { color: ${colors.text}; }
.cm-lp-root .cm-mail-head:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; border-radius: 4px; }
.cm-lp-root .cm-mail-icon { font-size: 13px; }
.cm-lp-root .cm-mail-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-lp-root .cm-mail-chev { font-size: 12px; }
.cm-lp-root .cm-mail-open .cm-mail-summary { color: ${colors.text}; }
.cm-lp-root .cm-mail-log { display: flex; flex-direction: column; gap: 10px; padding: 2px 0 12px; }
.cm-lp-root .cm-mail-entry { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: start; }
.cm-lp-root .cm-mail-joined { font-size: 12px; color: ${colors.muted}; }
.cm-lp-root .cm-mail-joined .cm-cmt-av { width: 16px; height: 16px; margin: 0 3px; opacity: 0.7; }
.cm-lp-root .cm-mail-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0; line-height: 1.3; }
.cm-lp-root .cm-mail-from, .cm-lp-root .cm-mail-target { font-weight: 600; }
.cm-lp-root .cm-mail-joined .cm-mail-from { font-weight: 400; }
.cm-lp-root .cm-mail-app { color: ${colors.muted}; white-space: pre; }
.cm-lp-root .cm-mail-time { margin-left: auto; padding-left: 8px; font-size: 11.5px; color: ${colors.muted}; font-variant-numeric: tabular-nums; }
.cm-lp-root .cm-mail-text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.cm-lp-root .cm-mail-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 5px 5px 10px;
  border: 1px solid ${colors.lineStrong}; border-radius: 9px; background: ${colors.surface};
}
.cm-lp-root .cm-mail-row:focus-within { border-color: ${colors.accent}; box-shadow: 0 0 0 3px ${colors.accentDim}; }
.cm-lp-root .cm-mail-input {
  flex: 1; min-width: 0; resize: none; overflow: hidden;
  min-height: 22px; padding: 2px 0; margin: 0;
  font: inherit; color: ${colors.text}; background: transparent; border: 0; outline: none;
}
.cm-lp-root .cm-mail-to {
  max-width: 40%;
  font: inherit; font-size: 12px; color: ${colors.text2};
  padding: 3px 6px; border: 0; border-radius: 6px; background: ${colors.chipFill};
}
.cm-lp-root .cm-mail-send {
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  padding: 4px 11px; border: 0; border-radius: 6px;
  background: ${colors.chipFill}; color: ${colors.text};
}
.cm-lp-root .cm-mail-send:hover { background: ${colors.accentDim}; color: ${colors.accent}; }
.cm-lp-root .cm-mail-problem { margin-top: 4px; font-size: 12px; color: ${colors.critText}; }
.cm-lp-root .cm-mail-problem[hidden] { display: none; }
.cm-lp-root .cm-mail-note { margin-top: 6px; font-size: 11.5px; color: ${colors.muted}; }
`;
}
