/**
 * K2 in the sweep: find-in-note.
 *
 * `@codemirror/search` was not in the bundle's dependency list and no search
 * binding existed at all, so ⌘F/Ctrl-F fell through to the browser's own
 * Find — which searches only the lines CodeMirror has actually rendered, and
 * silently misses on a long note. The report was "silently misses text on a
 * long note," not "I can't find the search feature," so this is a keymap
 * binding to CodeMirror's own search panel and nothing more: no toolbar key,
 * no new UI of this app's own. A discoverable entry point is a decision for
 * later, once the binding exists to discover.
 *
 * **Web only, and deliberately its own module rather than an addition to
 * `editorExtensions` in `editorSetup.ts`.** That file is compiled twice — once
 * by Metro for the browser, once by esbuild into the iOS guest bundle
 * (`webview/bundle.generated.ts`), which ships to every phone over the air.
 * The search panel needs real screen space, a text input and a close control
 * that the accessory bar has nowhere to put yet, so this ships only to the
 * surface that already has room for a floating panel over a wide document.
 * Keeping it out of `editorSetup.ts` is not just "unused on native" — it means
 * `webview/entry.ts` never imports this file, so esbuild never traces into
 * `@codemirror/search` at all and `bundle.generated.ts` is untouched by this
 * change: the native guest bundle is byte-identical, not merely unaffected in
 * behaviour. `editorBundleUnaffected.test.ts` pins that this file is reachable
 * from `LiveEditor.web.tsx` and not from `webview/entry.ts`.
 */

import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** ⌘F/Ctrl-F opens CodeMirror's own search panel; Escape closes it. */
export function findInNote(): Extension {
  return [search(), keymap.of(searchKeymap)];
}
