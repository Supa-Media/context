import { livePreviewStyles } from "../livePreview";
import { fonts, layout } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";

/**
 * The stylesheet, injected once per document rather than per editor.
 *
 * `EditorView.theme` would scope this properly, but the decoration classes are
 * plain strings shared with the pure module and a theme would mean expressing
 * them twice. One `<style>` with a stable id is the smaller lie.
 */
const STYLE_ELEMENT_ID = "context-live-preview-styles";

/**
 * Write the stylesheet, creating the element the first time and rewriting it
 * whenever the palette changes.
 *
 * It used to return early once the element existed, which was right while the
 * app had one palette and is a stale-colour bug now: the first editor to mount
 * would decide the note's colours for the rest of the session, and a change of
 * appearance would leave the surrounding app light and the note dark.
 *
 * One element for the document rather than one per editor, because these are
 * CSS custom properties on a shared class and CodeMirror's own
 * `EditorView.theme` would mean expressing the decoration classes twice. That
 * is only correct while the whole document is in one scheme, which is the case
 * here: the appearance comes from `useColors()`, and every editor on screen
 * reads the same one.
 */
export function ensureStyles(colors: Colors): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  const fresh = style === null;
  if (style === null) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
  }
  style.textContent = `
.cm-lp-root {
  --lp-heading: ${colors.text};
  --lp-muted: ${colors.text2};
  --lp-link: ${colors.codeKey};
  --lp-code-bg: ${colors.well};
  --lp-mono: ${fonts.mono};
  /*
    THIS BLOCK IS THE CONTRACT, AND IT HAS BEEN BROKEN TWICE THE SAME WAY.

    Everything drawn inside the editor — the shared stylesheet appended below,
    the completion list's theme, the link affordance — names its colours as
    --lp-* custom properties rather than as values, because the same rules run
    inside the iOS WebView where the palette arrives over a bridge. The guest
    declares the whole set (webview/host.ts themeVars, webview/styles.ts); this
    half has to declare the same set or those rules are talking to nothing.

    A missing one does not fail loudly. An unknown custom property makes its
    whole declaration invalid at computed-value time, so a colour naming one
    becomes inherit rather than an error — and the text takes whatever colour
    the app around the editor happens to be using, which was white ink on the
    light ground in the completion list and in every form label. It was right
    on iOS the whole time, which is exactly why nobody found it by looking at a
    phone.

    So: KEEP THIS IN STEP WITH themeVars. liveEditorMount.test.ts asserts
    that every --lp-* any mounted stylesheet reads is one declared here, which
    is the guard rather than this paragraph.
  */
  --lp-content: ${colors.text2};
  /*
    Hairlines, which this file had no token for at all — a rule that needed one
    borrowed --lp-code-bg, and that is the code fence's *fill*: #F5F5F5 on a
    #FFFFFF ground, which is not an edge. The palette has had the right two
    values the whole time.
  */
  --lp-line: ${colors.line};
  --lp-line-strong: ${colors.lineStrong};
  /* The wash behind a focused control, so focus is a ring rather than one
     pixel of border changing colour. */
  --lp-focus-ring: ${colors.accentDim};
  /*
    What a menu item that removes something is drawn in. The rust family
    tokens.ts reserves for conflict, revoked and failed; Delete row is the
    first thing in the editor that destroys anything on a press. (No backticks
    in this comment: it is inside a template literal and one would end it.)
  */
  --lp-danger: ${colors.crit};
  /*
    What the note is drawn *on*. The editor itself is transparent (below), so
    this names the surface behind it rather than painting one. The checkbox's
    tick is cut out of the filled box in this colour.
  */
  --lp-bg: ${colors.surface};
  /*
    The face the rendered blocks are set in — a form's fields, a table's cells.
    Not the scroller's own font-family, which is set directly below: that one
    is the note's body text and existed before anything here needed a token.
  */
  --lp-body: ${fonts.body};
  /*
    THE READING MEASURE — the one --lp-* here that is not a colour or a face.

    It is in this block rather than beside the rule that uses it for the
    reason the paragraph above gives: the identical rule runs inside the iOS
    WebView, where every --lp-* arrives over the bridge, so a property
    declared on one host and read on both is a declaration that silently
    becomes nothing on the other. themeVars sends this one too.

    A BARE NUMBER, and the unit is added by the rule that uses it. A
    font-relative length inside a custom property may be resolved either where
    the property is declared or where it is substituted, and engines differ —
    and those are two different lengths here, because this element is Times New
    Roman at 16px (nothing sets a face on it) while the note is a sans at
    14.5px. Multiplying by 1em down in .cm-content resolves it against the text
    it is measuring, on every engine.

    The number is layout.readingMeasureEm, which carries the argument for it,
    including why it is em rather than the ch that nominally means characters.
  */
  --lp-measure: ${layout.readingMeasureEm};
  height: 100%;
}
.cm-lp-root .cm-editor { height: 100%; background: transparent; }
.cm-lp-root .cm-editor.cm-focused { outline: none; }
.cm-lp-root .cm-scroller {
  font-family: ${fonts.body};
  /*
    The two numbers noteGutterFor needs, spent here and read there.

    (No backticks in this comment: it is inside a template literal, and one
    would end the string — the same trap frontmatterRange's neighbour records.)

    They were literals, which is fine for a rule nothing else has to line up
    with — and the breadcrumb above the note does. layout.noteFontSize is what
    --lp-measure is multiplied by down in .cm-content, and layout.notePadX is
    the gutter the measure is centred inside; anything drawn over this column
    adds them the same way or sits four points off the text at one width and
    level at another.
  */
  font-size: ${layout.noteFontSize}px;
  line-height: 1.75;
  padding: 14px ${layout.notePadX}px;
  overflow: auto;
}
/*
  Through the property rather than the value, so the body text and everything
  that says "the note's ink" resolve to one colour. The media query below moves
  both by moving the property once.
*/
.cm-lp-root .cm-content {
  color: var(--lp-content);
  caret-color: ${colors.text};
  /*
    ONE COLUMN, AND EVERYTHING IN THE NOTE SHARES IT.

    The measure is on .cm-content rather than on .cm-line because a note is
    not only prose: a table, a form, a rendered diagram and a code fence are
    block children of the same element, and constraining the lines alone would
    leave every one of those starting at a different left edge from the
    sentence above it. Nothing is allowed to be wider than the text it belongs
    to; what a wide table gets instead is its own scroller (.cm-lp-grid's
    overflow-x), which is why a 12-column table still reads as part of the
    document rather than dragging the document sideways.

    PADDING RATHER THAN MAX-WIDTH, BECAUSE THE EMPTY HALF OF THE PANE IS
    STILL THE EDITOR.

    The obvious recipe is max-width plus auto margins, and it draws exactly
    the same column. It was measured in Chromium and rejected: it makes
    .cm-content 572px wide inside a 1192px pane, so the 310px either side of
    the text stop being the editable surface. A click there lands on
    .cm-scroller, the editor does not take focus, and nothing happens — on a
    desktop console that is half the note's apparent area gone dead, and
    clicking beside a line to put the caret in it is something people do.

    Padding keeps .cm-content the full width of the pane, so CodeMirror's own
    mousedown handler still maps a click in the margin to the nearest position
    the way it always did, while every block child is inset to the measure.
    The max() floor is what hands the width back at narrow widths: once the
    pane is no wider than the measure the padding is zero and .cm-scroller's
    --lp-pad-x is the only gutter, which is the phone.

    1em is this element's own font size — the note's — which is the point of
    doing the multiplication here rather than storing a length.
  */
  padding-inline: max(0px, calc((100% - var(--lp-measure) * 1em) / 2));
}
.cm-lp-root .cm-line { padding: 0; }
/*
  The phone reads the note; it does not inspect it. Same buffer, same
  decorations, larger measure and more air — see the native half's file comment
  for the argument. A media query rather than a prop because this stylesheet is
  injected once for the document and has no React state to read; the breakpoint
  is layout.narrowBreakpoint, which is what densityFor calls compact, so the
  two surfaces change over at the same width instead of at two numbers that
  agree until somebody edits one. Minus 0.02 rather than minus 1: densityFor
  says compact below the breakpoint, and CSS max-width is inclusive, so a whole
  point would leave a window between 879 and 880 where one surface had changed
  over and the other had not. (No backticks in here: this comment is inside a
  template literal, and one would end the string.)
*/
@media (max-width: ${layout.narrowBreakpoint - 0.02}px) {
  .cm-lp-root .cm-scroller {
    /*
      Measured off Obsidian mobile: 16px on a 24px line box, 24px of side
      padding. Ours was 16.5/1.65 in 20px, which is a 27px line box — 13%
      looser than the reference and enough to make a paragraph read as a list
      of lines rather than a block of prose.
    */
    font-size: 16px;
    line-height: 1.5;
    padding: 8px 24px 32px;
  }
  /*
    The note is the whole screen here rather than a column beside a file tree,
    so it is drawn in the full-strength ink — themeVars' compact ? text : text2,
    which is the same sentence in the same two colours.
  */
  .cm-lp-root { --lp-content: ${colors.text}; }
}
/*
  The line under a note's title (titleLine.ts): the Text "error" variant's
  size, in the tone's text colour. Values rather than --lp-* properties
  because only this half draws it — the guest has no title line, so a
  property here would be one the contract above says it must also declare.
*/
.cm-lp-root .cm-lp-title-note {
  font-family: ${fonts.body};
  font-size: 13px;
  line-height: 20px;
  margin: 2px 0 6px;
}
.cm-lp-root .cm-lp-title-note-problem { color: ${colors.critText}; }
.cm-lp-root .cm-lp-title-note-held { color: ${colors.warnText}; }
${livePreviewStyles}
`;
  if (fresh) document.head.appendChild(style);
}
