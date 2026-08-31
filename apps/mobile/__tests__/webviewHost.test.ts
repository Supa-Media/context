/**
 * The native side of the Live Preview bridge, as functions over values.
 *
 * `webviewBridge.test.ts` wires the host to a real editor and proves the
 * conversation. This file proves the three things that are not a conversation:
 * what document the web view is handed, that the editor it contains is
 * genuinely local, and how much of it the keyboard is covering.
 *
 * Plain node, no DOM. `LiveEditor.tsx` itself is not mounted here and cannot
 * usefully be: react-native-webview has no web build — its platform-less
 * `WebView.js` renders "React Native WebView does not support this platform" —
 * so a suite that resolves `react-native` to `react-native-web` would render a
 * paragraph of apology and learn nothing. That is why the deciding is in
 * `host.ts` rather than in the component.
 */

import { describe, expect, test } from "@jest/globals";
import {
  EDITOR_HTML,
  coveredHeight,
  createHostBridge,
  editorDocument,
  escapeForScript,
} from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";

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
});
