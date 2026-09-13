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
  envelope,
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
      appState: null,
      theme: "dark",
      editable: true,
    });
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

  test("editable defaults to false rather than to true", () => {
    // A `load` that says nothing about write access must not grant it.
    const load = { channel: DRAWING_CHANNEL, type: "load", elements: [], theme: "light" };
    expect(readToEditor(load, OURS, OURS)?.editable).toBe(false);
    // And a truthy non-`true` value is not `true`.
    expect(readToEditor({ ...load, editable: "yes" }, OURS, OURS)?.editable).toBe(false);
  });

  test("an unknown theme falls back to light rather than to undefined", () => {
    const load = { channel: DRAWING_CHANNEL, type: "load", elements: [], theme: "neon" };
    expect(readToEditor(load, OURS, OURS)?.theme).toBe("light");
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
