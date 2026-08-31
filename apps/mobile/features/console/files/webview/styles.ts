/**
 * How the note is drawn inside the web view.
 *
 * Every value is a `var(--lp-…)` the host sets — see `themeVars` in `host.ts`.
 * This file states *relationships* and the host states values, which is the
 * split `livePreview.ts` already uses for its own type scale, and it is what
 * lets the same stylesheet draw two palettes and two densities without holding
 * either. Nothing here holds a colour, for the same reason no module in the app
 * holds a palette: a surface that decides its own colours is a third palette,
 * and the one nobody remembers to update.
 *
 * **In particular there is no media query.** The web half switches to reading
 * type below `layout.narrowBreakpoint`; here that switch is `densityFor` on the
 * native side, sent over as values. Same numbers, same crossover, one source —
 * rather than a breakpoint written down twice, in two units, in two files.
 *
 * The type scale itself is `livePreviewStyles`, imported rather than restated,
 * because the console and the phone are showing the same note and "a note that
 * reflows differently on the two platforms is two documents".
 *
 * This module lives inside the guest bundle and is compiled by esbuild. It is
 * never imported by the native host: it pulls in `livePreview.ts`, which pulls
 * in CodeMirror, which must not enter the React Native bundle.
 */

import { livePreviewStyles } from "../livePreview";

/**
 * The stylesheet, as one string.
 *
 * A function rather than a constant so the tests read it the way the guest
 * does, and so nothing is computed at module scope.
 */
export function guestStyles(): string {
  return `
:root {
  /*
    Defaults, so a bundle whose first theme message never arrives is a readable
    note rather than black text on a black ground. The host overwrites all of
    these on mount; these are the values only a broken bridge sees, and they are
    deliberately neutral rather than either palette. (No backticks in any
    comment below: this whole stylesheet is inside a template literal and one
    would end the string.)
  */
  --lp-bg: #ffffff;
  --lp-content: #222222;
  --lp-heading: #111111;
  --lp-muted: #666666;
  --lp-link: #2a5db0;
  --lp-code-bg: rgba(0,0,0,0.06);
  --lp-caret: #222222;
  --lp-selection: rgba(37,99,235,0.20);
  --lp-mono: ui-monospace, Menlo, monospace;
  --lp-body: -apple-system, system-ui, sans-serif;

  /* The reading measure. See themeVars for the two sets of values. */
  --lp-size: 16px;
  --lp-leading: 1.5;
  --lp-pad-top: 8px;
  --lp-pad-x: 24px;
  --lp-pad-bottom: 32px;

  /* How much of the editor something else is covering. See the inset message. */
  --lp-inset-bottom: 0px;
}

html, body {
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--lp-bg);
  /*
    The document does not scroll; the editor's own scroller does. Without this
    WKWebView gives the page a scroll view of its own and the note ends up with
    two, which on a phone reads as the text sticking and then lurching. The
    host sets scrollEnabled={false} for the same reason, on the other side.
  */
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}

/*
  Everything below is prefixed with the host element's id, and that is not
  ornament.

  CodeMirror injects its own base theme through style-mod at the moment the
  view is constructed — which is AFTER this stylesheet has been appended to the
  head — and that base theme sets font-family: monospace on .cm-scroller and
  padding on .cm-line. At equal specificity the later sheet wins, so the whole
  note rendered in a code face with the wrong line box, which is exactly what
  the first screenshot of this editor showed. An id beats a class and does not
  depend on which sheet was appended first. The web half never hit this because
  its selectors are already two classes deep (.cm-lp-root .cm-scroller).
*/
#root { height: 100%; }

#root .cm-editor { height: 100%; background: transparent; }
#root .cm-editor.cm-focused { outline: none; }

#root .cm-scroller {
  font-family: var(--lp-body);
  /*
    On a phone this resolves to 16px, which is also the number below which iOS
    zooms the page when a field takes focus. So it is load-bearing twice: the
    measured reading size, and what stops the note jumping to 150% the moment
    somebody taps into it.
  */
  font-size: var(--lp-size);
  line-height: var(--lp-leading);
  /*
    The bottom padding grows by whatever the keyboard is covering, so the last
    line of a note can always be scrolled clear of it. It is on the scroller
    rather than on the host's layout because moving the web view would reflow
    the whole document every time the keyboard opened.
  */
  padding: var(--lp-pad-top) var(--lp-pad-x)
           calc(var(--lp-pad-bottom) + var(--lp-inset-bottom));
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

#root .cm-content {
  color: var(--lp-content);
  caret-color: var(--lp-caret);
}
#root .cm-line { padding: 0; }
#root .cm-cursor, #root .cm-dropCursor { border-left-color: var(--lp-caret); }
#root .cm-selectionBackground,
#root .cm-content ::selection { background: var(--lp-selection); }
#root .cm-placeholder { color: var(--lp-muted); }

/*
  A note the viewer may not write reads; it does not pretend to be a text
  field. The facets in editorSetup.ts are what actually refuse the edit — this
  is only so the caret does not blink on a surface nothing can be typed into.
*/
#root .cm-editor[aria-readonly="true"] .cm-cursor { display: none; }

${livePreviewStyles}
`;
}
