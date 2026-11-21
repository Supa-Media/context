/**
 * The stylesheet of the wide pane's thread popover (`popover.ts`, `popoverDom.ts`)
 * and the selection toolbar (`seltool.ts`): the mock's `.cw`, `.cmsg`, `.seltool`
 * and their neighbours, prefixed `.cm-` and drawn in the same palette
 * `styles.ts` takes. The shared parts (avatars, problems, the point's colour
 * from `.cm-cmt-point`) are in `styles.ts` and this file uses their classes.
 * (No backticks in the CSS comments: this is a template literal.)
 */

import type { CommentPalette } from "./styles";

export function popoverStyles(colors: CommentPalette, font: string | undefined): string {
  return `
.cm-cw, .cm-seltool { font-family: ${font}; text-align: left; }
.cm-cw {
  position: absolute; z-index: 21; box-sizing: border-box;
  width: min(420px, calc(100% - 8px));
  display: flex; flex-direction: column;
  font-size: 13px; line-height: 1.4; color: ${colors.text};
  background: ${colors.surface}; border: 1px solid ${colors.line}; border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08);
  animation: cm-pop 160ms ease-out;
}
.cm-cw [hidden] { display: none !important; }
:where(.cm-cw) button { font: inherit; cursor: pointer; border: 0; background: transparent; color: inherit; }
.cm-cw button:focus-visible, .cm-seltool button:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 1px; }
.cm-cwh { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 10px; border-bottom: 1px solid ${colors.line}; }
.cm-cti { width: 22px; height: 22px; display: grid; place-items: center; color: ${colors.muted}; flex-shrink: 0; }
.cm-cti svg { width: 14px; height: 14px; }
.cm-cwt { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.cm-cwt b { font-size: 13px; }
.cm-ctsub { font-size: 11px; color: ${colors.muted}; }
.cm-ctsub:empty { display: none; }
.cm-cwx { width: 26px; height: 26px; border-radius: 50%; color: ${colors.muted}; font-size: 14px; }
.cm-cwx:hover { background: ${colors.chipFill}; }
.cm-btn { padding: 4px 10px; border-radius: 7px; font-weight: 600; font-size: 12px; }
.cm-btn-pri { background: ${colors.accent}; color: ${colors.surface}; }
.cm-btn-sec { background: ${colors.chipFill}; color: ${colors.text}; }
.cm-btn-danger { background: ${colors.critText}; color: ${colors.surface}; }
.cm-cwlog { max-height: 200px; overflow: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.cm-cwlog:empty { display: none; }
.cm-cmsg { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: start; font-size: 13px; flex-shrink: 0; }
.cm-cmsg > .cm-cmt-av { margin-top: 1px; }
.cm-cmsg-main { min-width: 0; }
.cm-cwho { display: flex; align-items: baseline; gap: 6px; line-height: 1.3; }
.cm-cwho b { font-size: 12.5px; font-weight: 600; }
.cm-cdel { margin-left: auto; padding: 0 4px; font-size: 11.5px; color: ${colors.muted}; }
.cm-cdel:hover { color: ${colors.critText}; }
@media (hover: hover) {
  .cm-cdel { opacity: 0; }
  .cm-cmsg:hover .cm-cdel, .cm-cdel:focus-visible { opacity: 1; }
}
.cm-cbody { color: ${colors.text2}; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
.cm-at { color: ${colors.accent}; font-weight: 600; }
.cm-cav { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.cm-cav-tex { background: transparent; }
.cm-cconfirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 12.5px; color: ${colors.text2}; }
.cm-cconfirm > button { margin-left: 6px; }
.cm-cacts { display: flex; gap: 6px; margin-top: 6px; }
.cm-cdone { font-size: 11.5px; color: ${colors.okText}; margin-top: 4px; font-weight: 600; }
.cm-cwresolved { font-size: 12px; color: ${colors.okText}; }
.cm-cwerr { color: ${colors.critText}; }
.cm-cwstep { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.cm-spin { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; border: 2px solid ${colors.line}; border-top-color: ${colors.accent}; animation: cm-spin 0.7s linear infinite; }
.cm-shimmer {
  background: linear-gradient(90deg, ${colors.muted} 0%, ${colors.text} 40%, ${colors.muted} 80%);
  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text;
  color: transparent; animation: cm-sh 1.6s linear infinite;
}
.cm-cw .cm-cmt-problem { padding: 0 10px 6px; }
.cm-mention { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px; }
.cm-mention button {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 7px; font-size: 12.5px;
  border: 1px solid ${colors.line}; color: ${colors.text2};
}
.cm-mention button:hover { background: ${colors.chipFill}; }
.cm-mention .cm-cav { width: 18px; height: 18px; font-size: 10px; }
.cm-mention .cm-cmt-av { width: 18px; height: 18px; font-size: 9px; }
.cm-cwbox {
  display: flex; align-items: center; gap: 6px; box-sizing: border-box;
  margin: 8px; padding: 4px 4px 4px 10px;
  background: ${colors.surface}; border: 1px solid ${colors.line}; border-radius: 12px;
}
.cm-cwbox:focus-within { border-color: ${colors.accent}; }
.cm-cwin {
  flex: 1; min-width: 0; border: 0; background: transparent; outline: none;
  font: inherit; font-size: 14px; color: ${colors.text}; padding: 5px 0;
}
.cm-cwin::placeholder { color: ${colors.muted}; }
@media (pointer: coarse) { .cm-cwin { font-size: 16px; } }
.cm-send {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  display: grid; place-items: center;
  background: ${colors.accent}; color: ${colors.surface};
  transition: transform 100ms ease;
}
.cm-send svg { width: 16px; height: 16px; }
.cm-send:disabled { opacity: 0.35; cursor: default; }
.cm-send:not(:disabled):active { transform: scale(0.9); }
.cm-cmt-point { color: ${colors.accent}; cursor: pointer; user-select: none; }
.cm-seltool {
  position: absolute; z-index: 20; box-sizing: border-box;
  display: flex; gap: 2px; padding: 3px;
  background: ${colors.text}; color: ${colors.surface};
  border-radius: 9px; box-shadow: 0 8px 28px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08);
  font-size: 12.5px; animation: cm-pop 140ms ease-out;
}
.cm-seltool[hidden] { display: none; }
.cm-seltool-btn {
  height: 30px; padding: 0 8px; border: 0; border-radius: 6px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  background: transparent; color: inherit; font: inherit;
}
.cm-seltool-btn:hover { background: ${colors.muted}; }
.cm-seltool-btn svg { width: 16px; height: 16px; }
.cm-seltool kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; opacity: 0.6; }
.cm-texbtn { display: inline-flex; }
@keyframes cm-spin { to { transform: rotate(360deg); } }
@keyframes cm-sh { to { background-position: -200% 0; } }
@keyframes cm-pop { from { transform: translateY(4px) scale(0.97); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .cm-cw, .cm-seltool, .cm-spin, .cm-shimmer { animation: none; }
}
`;
}
