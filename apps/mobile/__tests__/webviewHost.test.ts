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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CARET_MARGIN,
  EDITOR_HTML,
  ESTIMATED_HEIGHT,
  NAVIGATION_ORIGINS,
  allowInitialLoadOnly,
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

  /**
   * A SECOND `ready` IS A RELOAD, AND IT MUST NOT REWIND THE NOTE.
   *
   * The handshake's whole reason for resending state rather than flushing a
   * queue is that a WKWebView can reload on its own after a memory warning —
   * `createHostBridge`'s own header says so. What it resends is `doc`, and the
   * echo guard used to return *before* `doc` was assigned, so `doc` froze at
   * the text the note was opened with while `known` tracked what the person had
   * actually typed.
   *
   * The visible half of that is bad and the invisible half is worse. The editor
   * reverts, which a person can see; but `replaceDocument` is annotated
   * `externalDoc` so no `change` is emitted, leaving `known` at the reverted
   * text — so the very next keystroke posts a `change` derived from the rewound
   * document and overwrites the draft, with no undo entry and nothing said.
   * Unsaved work, lost silently, on a memory warning nobody triggered.
   */
  test("a reload is answered with what the person has typed, not what they opened", () => {
    const { bridge, sent } = traced(true);
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "typed" }));
    // The echo of that change, which is exactly the call that must not be
    // allowed to leave `doc` behind.
    bridge.setDoc("typed");
    sent.length = 0;

    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    const doc = sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === "doc");
    expect(doc).toEqual([{ v: PROTOCOL_VERSION, type: "doc", text: "typed" }]);
  });

  /**
   * And the guest is believed to hold what it was just resent.
   *
   * `known` is what stops the next keystroke being written back over the
   * caret; after a reload it has to name the resent document. Asserted through
   * the seam rather than inferred from the `doc` message above, because the
   * two are set in different statements and a fix that moved one and not the
   * other would pass the test before this one.
   */
  test("and the guest is believed to hold that, not the opened text", () => {
    const { bridge } = traced(true);
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "typed" }));
    bridge.setDoc("typed");
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));

    expect(bridge.known()).toBe("typed");
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


/**
 * WHERE THE NOTE COULD HAVE LEFT THE DEVICE, AND WHY THE FIX LOOKS LIKE A HOLE.
 *
 * `editorDocument`'s CSP closes fetching, framing, form posts and base
 * rewriting. It cannot close navigation — no browser has a directive that stops
 * `location.assign()` — so the one remaining way a script inside that document
 * could put somebody's private markdown on the network is by navigating to
 * `https://attacker.example/?d=<the note>`. `allowInitialLoadOnly` refuses that.
 * These tests are about whether it is ever *asked*.
 *
 * The model below is react-native-webview's own
 * `createOnShouldStartLoadWithRequest`, transcribed from
 * `src/WebViewShared.tsx` at the version this app pins (asserted at the bottom
 * of this block, so an upgrade forces somebody to read it again). It is
 * modelled rather than imported for the reason this whole file exists: the
 * package has no web build, so a suite resolving `react-native` to
 * `react-native-web` cannot load it — and the branch that matters is four lines
 * of dispatch around a `Linking` call, not behaviour that needs a device.
 *
 * The first test is the model's self-test: driven with the whitelist this
 * repository used to carry, it must reproduce the defect. A model that passes
 * both values proves nothing.
 */
describe("a URL that appears inside the note", () => {
  /** `escape-string-regexp`, inlined — the library's own escaping. */
  const escapeStringRegexp = (text: string) =>
    text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");

  const originWhitelistToRegex = (entry: string) =>
    `^${escapeStringRegexp(entry).replace(/\\\*/g, ".*")}`;

  // The library prepends `about:blank` itself, which is why the initial load
  // passes whatever this app sets and why the whitelist has no work left to do.
  const compileWhitelist = (whitelist: readonly string[]) =>
    ["about:blank", ...whitelist].map(originWhitelistToRegex);

  const extractOrigin = (url: string) => {
    const result = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url);
    return result === null ? "" : result[0];
  };

  const passesWhitelist = (compiled: readonly string[], url: string) =>
    compiled.some((entry) => new RegExp(entry).test(extractOrigin(url)));

  /**
   * The library's dispatch, as an answer rather than a side effect.
   *
   * `askedTheApp` is the whole point: `onShouldStartLoadWithRequest` sits in
   * the `else` of the whitelist check, so a URL that fails the whitelist never
   * reaches it — it reaches `Linking.openURL`, in full, query string included.
   */
  function dispatch(whitelist: readonly string[], url: string) {
    const compiled = compileWhitelist(whitelist);
    if (!passesWhitelist(compiled, url)) {
      return { shouldStart: false, handedToTheOs: url, askedTheApp: false };
    }
    return {
      shouldStart: allowInitialLoadOnly({ url }),
      handedToTheOs: null as string | null,
      askedTheApp: true,
    };
  }

  const NOTE = "the%20thing%20I%20told%20nobody";
  const EXFILTRATION = `https://attacker.example/?d=${NOTE}`;
  const HOSTILE = [
    EXFILTRATION,
    "http://attacker.example/",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "intent://x#Intent;scheme=http;end",
  ];

  test("the model reproduces the defect it exists to catch", () => {
    // `["about:*"]` is the value this app carried until this test was written.
    // It reads as the tightest possible whitelist and is the leak: the URL is
    // not refused, it is handed to the operating system with the note in it,
    // and the app's own refusal is never consulted.
    const narrow = dispatch(["about:*"], EXFILTRATION);
    expect(narrow.askedTheApp).toBe(false);
    expect(narrow.handedToTheOs).toBe(EXFILTRATION);
    expect(narrow.handedToTheOs).toContain(NOTE);
  });

  test("reaches this app's refusal, rather than Safari", () => {
    for (const url of HOSTILE) {
      const result = dispatch(NAVIGATION_ORIGINS, url);
      expect({ url, ...result }).toEqual({
        url,
        shouldStart: false,
        handedToTheOs: null,
        askedTheApp: true,
      });
    }
  });

  test("which is what `[\"*\"]` buys, and why it may not be tightened", () => {
    // The property, stated directly and not through one worked example: every
    // URL passes the whitelist, so every URL is decided by this app.
    expect(NAVIGATION_ORIGINS).toEqual(["*"]);
    for (const url of [...HOSTILE, "about:blank", "https://context.lc/"]) {
      expect(passesWhitelist(compileWhitelist(NAVIGATION_ORIGINS), url)).toBe(true);
    }
  });

  test("and the load that brings the editor up is still allowed", () => {
    expect(dispatch(NAVIGATION_ORIGINS, "about:blank")).toEqual({
      shouldStart: true,
      handedToTheOs: null,
      askedTheApp: true,
    });
    expect(allowInitialLoadOnly({ url: "about:blank" })).toBe(true);
    expect(allowInitialLoadOnly({ url: EXFILTRATION })).toBe(false);
  });

  test("the component wires both of these rather than its own literals", () => {
    // `LiveEditor.tsx` cannot be mounted here — see this file's header — so the
    // half that proves the policy reaches the view is read instead. A local
    // `originWhitelist={["about:*"]}` in the component would put the leak back
    // with `host.ts` still passing every test above it.
    const component = readFileSync(
      resolve(__dirname, "..", "features/console/files/LiveEditor.tsx"),
      "utf8",
    );
    expect(component).toContain("originWhitelist={NAVIGATION_ORIGINS as string[]}");
    expect(component).toContain("onShouldStartLoadWithRequest={allowInitialLoadOnly}");
    expect(component).toMatch(/NAVIGATION_ORIGINS,\s*\n\s*allowInitialLoadOnly,/);
    // One `originWhitelist` in the file, and it is that one.
    expect(component.match(/originWhitelist/g)).toHaveLength(1);
  });

  test("the modelled dispatch is pinned to the version it was read from", () => {
    // The model above is a copy of somebody else's four lines. What keeps it
    // honest is not a comment claiming it is current: it is that the version
    // is pinned exactly, so an upgrade fails here and somebody re-reads
    // `src/WebViewShared.tsx` before the whitelist argument is trusted again.
    const manifest = JSON.parse(
      readFileSync(join(resolve(__dirname, ".."), "package.json"), "utf8"),
    );
    expect(manifest.dependencies["react-native-webview"]).toBe("13.15.0");
  });
});
