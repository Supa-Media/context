/**
 * The native side of the Live Preview bridge, as functions over values.
 *
 * `webviewBridge.test.ts` wires the host to a real editor and proves the
 * conversation. This file proves the things that are not a conversation: what
 * document the web view is handed, that the editor it contains is genuinely
 * local, how much of it the keyboard is covering, how tall a box it is drawn
 * in, and how far the page must scroll to keep the caret off the keys.
 *
 * Plain node, no DOM. `LiveEditor.tsx` is not mounted here: react-native-webview
 * has no web build — its platform-less `WebView.js` renders "React Native
 * WebView does not support this platform" — so a suite that resolves
 * `react-native` to `react-native-web` would render a paragraph of apology and
 * learn nothing. That is why the deciding is in `host.ts` rather than in the
 * component.
 *
 * Which is a good rule and not a sufficient one: the blank note editor was a
 * component that had stopped asking the right question, and no amount of
 * correct arithmetic in this file would have caught it. `nativeEditorBox.test.ts`
 * is the other half — it stubs that one child and mounts the real component to
 * prove these answers reach the view.
 */

import { describe, expect, test } from "@jest/globals";
import {
  CARET_MARGIN,
  EDITOR_HTML,
  ESTIMATED_HEIGHT,
  caretOvershoot,
  coveredHeight,
  createHostBridge,
  editorBox,
  editorDocument,
  escapeForScript,
} from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";
import { ACCESSORY_HEIGHT, accessoryUp } from "../features/console/files/accessory";

describe("the document the web view loads", () => {
  /**
   * "The bundle must be local, not remote."
   *
   * The app works offline and the note lives in a bucket the customer owns; an
   * editor that fetches its own code to open a file is not that product. The
   * CSP is what makes that structural rather than a promise — `default-src
   * 'none'` means this document cannot reach anything, so an editor that
   * quietly started fetching would fail rather than work-and-be-wrong.
   */
  test("cannot reach the network at all", () => {
    expect(EDITOR_HTML).toContain("default-src 'none'");
    expect(EDITOR_HTML).toContain("base-uri 'none'");
    expect(EDITOR_HTML).toContain("form-action 'none'");
  });

  test("and does not try to: nothing in the shell has a src or an href", () => {
    const shell = editorDocument("/* the bundle */");
    expect(shell).not.toMatch(/\ssrc=/);
    expect(shell).not.toMatch(/\shref=/);
    expect(shell).toContain("<script>/* the bundle */</script>");
  });

  test("nor does the bundle name a CDN", () => {
    // Namespace URIs (`http://www.w3.org/1999/xhtml`) are in there and are not
    // fetches, so this asks the narrower question the promise is actually about.
    for (const host of ["cdn.jsdelivr", "unpkg.com", "cdnjs.", "esm.sh", "//cdn."]) {
      expect(EDITOR_HTML).not.toContain(host);
    }
  });

  test("a `</script` inside the bundle does not end the element holding it", () => {
    // The HTML tokenizer looks for the characters, not for JavaScript syntax.
    // One string constant in 500kb of minified CodeMirror would otherwise close
    // the tag and leave the rest of the editor as text on the page.
    const escaped = escapeForScript('const end = "</script>";');
    expect(escaped).toBe('const end = "<\\/script>";');
    expect(editorDocument('a = "</SCRIPT>"')).toContain('<\\/SCRIPT>');
  });

  test("the editor is actually in there", () => {
    // Not an assertion about size for its own sake: a shell that shipped
    // without its bundle is a blank white note, and it looks fine in a diff.
    expect(EDITOR_HTML.length).toBeGreaterThan(100_000);
  });
});

describe("the ready handshake", () => {
  function traced(editable: boolean) {
    const sent: string[] = [];
    const changes: string[] = [];
    const bridge = createHostBridge((raw) => sent.push(raw), {
      onChange: (text) => changes.push(text),
      onSave: () => {},
    });
    bridge.setDoc("# note\n");
    bridge.setEditable(editable);
    bridge.setTheme({ "--lp-bg": "#000" });
    return { bridge, sent, changes };
  }

  /**
   * Nothing sent before the web view is listening is lost, because nothing is
   * *kept* — the whole desired state is sent again when the guest announces
   * itself. That is also what makes this right if WKWebView reloads on its own
   * after a memory warning, which a queue would not be.
   */
  test("nothing crosses until the guest says it is listening", () => {
    const { sent } = traced(true);
    expect(sent).toEqual([]);
  });

  test("and then the whole state does, editability first", () => {
    const { bridge, sent } = traced(true);
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));

    const types = sent.map((raw) => JSON.parse(raw).type);
    // `editable` before `doc`: the document write is annotated and would be
    // accepted either way, but a guest that learns what it may do first is one
    // fewer ordering to reason about.
    expect(types).toEqual(["editable", "theme", "inset", "doc"]);
    expect(JSON.parse(sent[types.indexOf("doc")]).text).toBe("# note\n");
  });

  test("after which changes go straight across", () => {
    const { bridge, sent } = traced(true);
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    sent.length = 0;

    bridge.setDoc("# other\n");
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { v: PROTOCOL_VERSION, type: "doc", text: "# other\n" },
    ]);

    // ...but the echo of the guest's own typing does not, which is the guard
    // that keeps the caret where the person put it.
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "typed" }));
    sent.length = 0;
    bridge.setDoc("typed");
    expect(sent).toEqual([]);
  });
});

describe("how much of the note the keyboard is covering", () => {
  /**
   * Measured as an overlap rather than taken as the keyboard's height, so it is
   * right whether or not something above the editor has already resized it to
   * make room. If it has, this goes to zero on its own and the note is not
   * padded twice.
   */
  test("a full-height editor under a 336pt keyboard is covered by 336", () => {
    expect(
      coveredHeight({ top: 0, height: 844, windowHeight: 844, keyboardHeight: 336 }),
    ).toBe(336);
  });

  test("an editor that has already been resized for it is covered by nothing", () => {
    // The layout shrank the editor to sit above the keyboard. Padding it as
    // well would push the last line of the note off the bottom.
    expect(
      coveredHeight({ top: 0, height: 508, windowHeight: 844, keyboardHeight: 336 }),
    ).toBe(0);
  });

  test("a partial overlap is the part that overlaps", () => {
    expect(
      coveredHeight({ top: 100, height: 600, windowHeight: 844, keyboardHeight: 336 }),
    ).toBe(192);
  });

  test("no keyboard is no inset, whatever the geometry says", () => {
    expect(
      coveredHeight({ top: 0, height: 844, windowHeight: 844, keyboardHeight: 0 }),
    ).toBe(0);
  });

  /**
   * The accessory bar is added rather than measured, and that is not the same
   * kind of number as the overlap above.
   *
   * `KeyboardSticky` positions the bar absolutely and translates it up by the
   * keyboard's height, so it is drawn *over* the editor and resizes nothing —
   * there is nothing in the layout for `measureInWindow` to find. Its height
   * comes from `ACCESSORY_HEIGHT`, which is also what its stylesheet is drawn
   * to, so the two cannot drift.
   */
  test("the accessory bar is added on top of what the keyboard covers", () => {
    const box = { top: 0, height: 844, windowHeight: 844, keyboardHeight: 336 };
    expect(coveredHeight(box)).toBe(336);
    expect(coveredHeight({ ...box, accessoryHeight: ACCESSORY_HEIGHT })).toBe(
      336 + ACCESSORY_HEIGHT,
    );
  });

  test("but not when there is no keyboard for it to be riding on", () => {
    expect(
      coveredHeight({
        top: 0,
        height: 844,
        windowHeight: 844,
        keyboardHeight: 0,
        accessoryHeight: ACCESSORY_HEIGHT,
      }),
    ).toBe(0);
  });
});

/**
 * The three conditions the accessory bar appears under, in one place.
 *
 * `NoteEditor` renders the bar from this and `LiveEditor` pads the note for it
 * from the same call, so a fourth condition added in one and not the other
 * would be a bar hanging over a note that had not made room for it.
 */
describe("when the accessory bar is up", () => {
  const up = { compact: true, editable: true, focused: true };

  test("a phone, a note this viewer may write, and the caret in it", () => {
    expect(accessoryUp(up)).toBe(true);
  });

  test.each([
    ["a pointer has a keyboard and the chords that go with it", { compact: false }],
    ["a note the viewer may not write has nothing for the keys to do", { editable: false }],
    ["and there is no keyboard to ride above until the note has the caret", { focused: false }],
  ])("%s", (_why, off) => {
    expect(accessoryUp({ ...up, ...off })).toBe(false);
  });
});

/**
 * THE BOX THE NOTE IS DRAWN IN, which is the blank-editor bug as arithmetic.
 *
 * `nativeEditorBox.test.ts` mounts the component and proves this reaches the
 * view. Here it is only the decision. The two are a pair on purpose: a rule in
 * a module nothing reads is how the blank editor shipped in the first place.
 */
describe("the box the web view is laid out in", () => {
  const window = { windowHeight: 956 };

  test("a phone gets a height, never a flex, because a flex there is nothing", () => {
    // The whole bug: at compact the editor is a child of the note's page
    // scroller, whose content container is *defined* by its children's heights.
    // A `flex: 1` child of it has no free space to grow into.
    expect(editorBox({ compact: true, height: 1240, ...window })).toEqual({ height: 1240 });
  });

  test("and an under-estimate until the guest has measured, rather than nothing", () => {
    // Something has to be on the glass in the frame or two before the first
    // `height` message. Deliberately short: a box that starts too short grows
    // into place; one that starts too tall strands the durability line below
    // the fold and then jumps up to meet it.
    const box = editorBox({ compact: true, height: null, ...window })!;
    expect(box.height).toBe(Math.round(956 * ESTIMATED_HEIGHT));
    expect(box.height).toBeLessThan(956);
  });

  test.each([
    ["a document that has not laid out", 0],
    ["a measurement that arrived negative", -40],
    ["a measurement that arrived as an infinity", Number.POSITIVE_INFINITY],
    ["a measurement that arrived as a NaN", Number.NaN],
  ])("%s falls back rather than collapsing the note", (_why, height) => {
    // React Native drops a whole subtree rather than lay out a nonsense box, so
    // a bad number here is the blank editor again by another route.
    const box = editorBox({ compact: true, height, ...window })!;
    expect(box.height).toBe(Math.round(956 * ESTIMATED_HEIGHT));
  });

  test("a pointer layout is not sized here at all", () => {
    // There a region bounds the editor, the free space exists, and `flex: 1`
    // from the stylesheet is right — a stated height would stop the note
    // growing with the window. `null` says "not mine to decide".
    expect(editorBox({ compact: false, height: 1240, ...window })).toBeNull();
    expect(editorBox({ compact: false, height: null, ...window })).toBeNull();
  });
});

/**
 * Scrolling the caret out from under the keyboard, where CodeMirror cannot.
 *
 * The other half of "the editor is as tall as its document": its own scroller
 * has nothing to scroll, so `coveredBottom`'s scroll margin has nothing to act
 * on and its idea of "visible" covers the whole note. The page scroller moves
 * instead, by this much.
 */
describe("how far the page must scroll to clear the caret", () => {
  const box = {
    editorTop: 0,
    windowHeight: 956,
    keyboardHeight: 336,
    accessoryHeight: ACCESSORY_HEIGHT,
  };

  test("nothing at all while there is no keyboard", () => {
    expect(caretOvershoot({ ...box, caretBottom: 900, keyboardHeight: 0 })).toBe(0);
  });

  test("nothing while the caret is already above the keys", () => {
    expect(caretOvershoot({ ...box, caretBottom: 100 })).toBe(0);
  });

  test("the overshoot, plus a line of air, once it is behind them", () => {
    const clear = 956 - 336 - ACCESSORY_HEIGHT - CARET_MARGIN;
    expect(caretOvershoot({ ...box, caretBottom: clear + 60 })).toBe(60);
  });

  test("measured from where the editor is, not from where the note starts", () => {
    // Half the note has already scrolled past the top of the glass: the same
    // caret is that much higher on the screen and needs that much less.
    const clear = 956 - 336 - ACCESSORY_HEIGHT - CARET_MARGIN;
    expect(caretOvershoot({ ...box, editorTop: -200, caretBottom: clear + 60 })).toBe(0);
    expect(caretOvershoot({ ...box, editorTop: -40, caretBottom: clear + 60 })).toBe(20);
  });

  test("the accessory bar is part of what is covering the note", () => {
    const clear = 956 - 336 - CARET_MARGIN;
    // Exactly clear of the keyboard, and exactly the bar's height short of
    // clear of the bar.
    expect(caretOvershoot({ ...box, accessoryHeight: 0, caretBottom: clear })).toBe(0);
    expect(caretOvershoot({ ...box, caretBottom: clear })).toBe(ACCESSORY_HEIGHT);
  });
});
