/**
 * A MESSAGE FROM ANYWHERE BUT OUR OWN PAGE IS NOT A MESSAGE.
 *
 * The drawing editor runs in an iframe (web) or a WebView (native), and talks
 * to the console over `postMessage`. That is a channel **anything on the page
 * can post to** — another frame, an extension, an embed — and what arrives on
 * it is fed to `serializeDrawing` and written to the customer's file. So the
 * reader is the security boundary of this feature, and it is tested as one:
 *
 *  1. **Origin first, before anything is read.** A well-formed message from the
 *     wrong origin is nothing at all.
 *  2. **Shape is checked, not cast.** `elements` must be an array, because the
 *     next thing that happens to it is a splice into somebody's bytes.
 *  3. **The channel is checked**, so an unrelated `{type:"change"}` from some
 *     other library on the page is ignored rather than acted on.
 *  4. **The two copies of the channel name agree.** The editor page shares no
 *     code with the app on purpose, so the one constant it duplicates is
 *     asserted here rather than trusted to a comment.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests here.
 *
 *   the origin check removed from `readFromEditor`                          3
 *   the origin compared by prefix rather than equality                       1
 *   the channel check removed                                                1
 *   `elements` accepted without an array check                               1
 *   `editable` defaulting to true                                            1
 *   `theme` passed through unchecked                                         1
 *
 * The first two rows are the ones this file exists for, and the second is the
 * one a reviewer would not have thought to write: `startsWith` instead of `===`
 * reads as equivalent and lets `https://console.example.evil.test` through.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";

import {
  DRAWING_CHANNEL,
  DRAWING_EDITOR_PATH,
  envelope,
  isEditorPageUrl,
  readFromEditor,
  readToEditor,
} from "../features/console/files/drawingBridge";

const OURS = "https://console.example";
const THEIRS = "https://evil.example";

const CHANGE = envelope({ type: "change", elements: [{ id: "a", type: "rectangle" }] });

describe("origin is checked before anything is read", () => {
  test("a well-formed message from another origin is nothing", () => {
    expect(readFromEditor(CHANGE, THEIRS, OURS)).toBeNull();
  });

  test("the same message from our own origin is read", () => {
    expect(readFromEditor(CHANGE, OURS, OURS)).toEqual({
      type: "change",
      elements: [{ id: "a", type: "rectangle" }],
    });
  });

  test("an empty origin is not treated as ours", () => {
    expect(readFromEditor(CHANGE, "", OURS)).toBeNull();
  });

  test("a prefix of our origin is not ours", () => {
    // `https://console.example.evil.test` starts with our host and is not it.
    expect(readFromEditor(CHANGE, `${OURS}.evil.test`, OURS)).toBeNull();
  });

  test("the console's own messages are read by the same rule, the other way", () => {
    const load = envelope({ type: "load", elements: [], appState: null, theme: "dark", editable: true });
    expect(readToEditor(load, THEIRS, OURS)).toBeNull();
    expect(readToEditor(load, OURS, OURS)).toEqual({
      type: "load",
      elements: [],
      collaborating: false,
      appState: null,
      theme: "dark",
      editable: true,
    });
  });
});

describe("the page that sent it is the page we loaded", () => {
  /*
    The native half has no `event.origin`. It has `event.nativeEvent.url`, and
    it used to reduce that to an origin with a regex and compare origins —
    with `?? origin` behind it, so **a url the regex could not read counted as
    ours**. Fail-open, in the one check standing between an arbitrary page and
    a splice into somebody's file.

    `file:///…` is the case that makes it concrete: the host is empty, so the
    regex matches nothing, the fallback fires, and the check passes for a page
    we never loaded. That is not hypothetical — a downloaded offline copy is
    exactly the change that would introduce it, which is how it was found.

    So the comparison is the whole url now, not an origin distilled out of it,
    and an unreadable one is refused rather than assumed.
  */
  const PAGE = `${OURS}${DRAWING_EDITOR_PATH}`;

  test("the exact page is ours", () => {
    expect(isEditorPageUrl(PAGE, PAGE)).toBe(true);
  });

  test("a fragment or a query does not make it somebody else's", () => {
    // A WebView reports what it loaded, and Excalidraw puts state in the hash.
    expect(isEditorPageUrl(`${PAGE}#zoom=2`, PAGE)).toBe(true);
    expect(isEditorPageUrl(`${PAGE}?v=2`, PAGE)).toBe(true);
  });

  test("another path on our own origin is not the editor", () => {
    expect(isEditorPageUrl(`${OURS}/console/@seyi`, PAGE)).toBe(false);
    expect(isEditorPageUrl(`${OURS}/drawing-assets/editor/other.html`, PAGE)).toBe(false);
  });

  test("another origin at the same path is not the editor", () => {
    expect(isEditorPageUrl(`${THEIRS}${DRAWING_EDITOR_PATH}`, PAGE)).toBe(false);
  });

  test("a url with no readable host is refused rather than assumed", () => {
    // The fail-open case, named. Every one of these used to be "ours".
    expect(isEditorPageUrl("file:///var/mobile/editor/index.html", PAGE)).toBe(false);
    expect(isEditorPageUrl("about:blank", PAGE)).toBe(false);
    expect(isEditorPageUrl("", PAGE)).toBe(false);
    expect(isEditorPageUrl(undefined, PAGE)).toBe(false);
  });

  test("a prefix of the page is not the page", () => {
    // `startsWith` would accept this, and it is a real url somebody can serve.
    expect(isEditorPageUrl(`${PAGE}.evil`, PAGE)).toBe(false);
    expect(isEditorPageUrl(`${OURS}/drawing-assets/editor/index.html.evil`, PAGE)).toBe(false);
  });
});

describe("shape is checked, not cast", () => {
  test("a change without an elements array is refused", () => {
    for (const elements of [undefined, null, "elements", 3, { length: 1 }]) {
      expect(readFromEditor({ channel: DRAWING_CHANNEL, type: "change", elements }, OURS, OURS)).toBeNull();
    }
  });

  test("a load without an elements array is refused", () => {
    expect(readToEditor({ channel: DRAWING_CHANNEL, type: "load" }, OURS, OURS)).toBeNull();
  });

  test("non-objects are refused", () => {
    for (const data of [undefined, null, "ready", 0, []]) {
      expect(readFromEditor(data, OURS, OURS)).toBeNull();
    }
  });

  test("an unknown message type is refused rather than passed through", () => {
    expect(readFromEditor(envelope({ type: "save" }), OURS, OURS)).toBeNull();
  });

  /** `readToEditor` answers a union now, and only `load` carries these. */
  const loaded = (data: unknown) => {
    const message = readToEditor(data, OURS, OURS);
    return message && message.type === "load" ? message : null;
  };

  test("editable defaults to false rather than to true", () => {
    // A `load` that says nothing about write access must not grant it.
    const load = { channel: DRAWING_CHANNEL, type: "load", elements: [], theme: "light" };
    expect(loaded(load)?.editable).toBe(false);
    // And a truthy non-`true` value is not `true`.
    expect(loaded({ ...load, editable: "yes" })?.editable).toBe(false);
  });

  test("an unknown theme falls back to light rather than to undefined", () => {
    const load = { channel: DRAWING_CHANNEL, type: "load", elements: [], theme: "neon" };
    expect(loaded(load)?.theme).toBe("light");
  });

  test("collaborating defaults to false, so undo stays ordinary when alone", () => {
    // `isCollaborating` changes how Excalidraw's history behaves. A `load`
    // that does not ask for that must not get it.
    const load = { channel: DRAWING_CHANNEL, type: "load", elements: [], theme: "light" };
    expect(loaded(load)?.collaborating).toBe(false);
    expect(loaded({ ...load, collaborating: true })?.collaborating).toBe(true);
  });
});

describe("the channel is checked", () => {
  test("another library's message with the same type is ignored", () => {
    expect(readFromEditor({ type: "change", elements: [] }, OURS, OURS)).toBeNull();
    expect(
      readFromEditor({ channel: "something.else", type: "change", elements: [] }, OURS, OURS)
    ).toBeNull();
  });
});

describe("the editor page uses this module, not a copy of it", () => {
  test("its entry imports the real bridge", () => {
    /*
      This matters more than it looks. The page started with its own copy of
      the channel constant and its own inline message handler, which made every
      check in this file a test of a parallel implementation that merely
      resembled the page's — a guard checking nothing. esbuild compiles
      TypeScript, so the page imports this module directly and these rules are
      the rules it actually runs.
    */
    const entry = readFileSync(path.join(__dirname, "..", "drawing-editor", "entry.jsx"), "utf8");
    expect(entry).toMatch(/from "\.\.\/features\/console\/files\/drawingBridge"/);
    // And no second copy of the constant anywhere in that folder.
    expect(entry).not.toMatch(/DRAWING_CHANNEL\s*=\s*"/);
  });
});
