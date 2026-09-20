/**
 * @jest-environment jsdom
 */

/**
 * A PLUGIN'S IN-EDITOR SUGGESTIONS, ON THE PHONE.
 *
 * `pluginSuggestEditor.test.ts` proves the completion source against a real
 * `EditorView` — what the plugin is asked, and what a pick writes. That editor
 * is the console's, and on a phone the same CodeMirror is inside a `WebView`
 * with a JSON bridge in front of it, so none of it reached the native half:
 * `LiveEditor.tsx` accepted `onSuggest` and `onPickSuggestion` through the
 * shared props type and used neither. A plugin that showed **Running** on a
 * phone, with a grant the owner had approved, offered nothing in any note and
 * said nothing about why.
 *
 * "An absent capability is reported, never faked" — and a prop that is accepted
 * and dropped is the one shape that does neither.
 *
 * ## What this file proves that the web one cannot
 *
 * The web editor holds the callbacks. This one holds a bridge, so everything
 * interesting is in the conversation rather than in either end:
 *
 *  - the line crosses to the host and the items come back, through the same
 *    request/reply pair the form blocks use;
 *  - nothing is asked at all while no plugin can answer, so a note on a
 *    surface with no runtime costs no bridge traffic per keystroke;
 *  - a pick on a note the viewer may not write is refused **by the host**,
 *    which is the second of the three refusals every edit meets here;
 *  - and a reply whose payload is not the shape it claims is dropped rather
 *    than inserted into somebody's note.
 *
 * The harness is `webviewBridge.test.ts`'s: a real host wired to a real guest
 * with a real `EditorView` in it, in one process. WKWebView carries strings and
 * contributes no behaviour to any of the above.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorView } from "@codemirror/view";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { mountGuest, type MountedGuest } from "../features/console/files/webview/guest";
import { createHostBridge, themeVars } from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";
import { darkColors } from "../features/design/tokens";

/*
  Several turns, not one. CodeMirror runs a completion source from a state
  field after a debounce and only for a focused view, and here the answer also
  crosses a bridge and back — so the harness lets the scheduler settle rather
  than assuming anything ran synchronously.
*/
const tick = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface Wired {
  guest: MountedGuest;
  host: ReturnType<typeof createHostBridge>;
  view: EditorView;
  /** Every `(line, ch)` the host's `onSuggest` was called with. */
  asked: { line: string; ch: number }[];
  /** Every index the host's `onPickSuggestion` was called with. */
  picked: number[];
  /** Every raw message the guest posted to the host, in order. */
  fromGuest: string[];
  destroy: () => void;
}

/**
 * Host and guest, connected, with a suggesting console behind the host.
 *
 * `available` is deliberately separate from `items`: the console's own answer
 * to "can a plugin be asked right now" is whether it handed `onSuggest` at all,
 * and the interesting states are the ones where those two disagree.
 */
function connect(options: {
  doc: string;
  editable: boolean;
  available?: boolean;
  items?: (line: string, ch: number) => { text: string }[];
  pick?: (index: number) => string | null;
  /**
   * Keep `suggest-pick` from reaching the host, so a test can be the only
   * thing that ever answers that token.
   *
   * Needed because the host answers every request it receives — which is the
   * property that stops a completion hanging forever, and which also means a
   * test replying "out of band" is replying *second*, to a token already
   * settled and deleted. A guard checked against a reply nobody was waiting for
   * is a test that passes with the guard removed; this one did.
   */
  swallowPick?: boolean;
}): Wired {
  const root = document.createElement("div");
  document.body.appendChild(root);

  const asked: { line: string; ch: number }[] = [];
  const picked: number[] = [];
  const fromGuest: string[] = [];

  let deliver: (raw: string) => void = () => {};
  const host = createHostBridge((raw) => deliver(raw), {
    onChange: () => {},
    onSave: () => {},
    onSuggest: async (line, ch) => {
      asked.push({ line, ch });
      return options.items ? options.items(line, ch) : [];
    },
    onPickSuggestion: async (index) => {
      picked.push(index);
      return options.pick ? options.pick(index) : null;
    },
  });

  host.setDoc(options.doc);
  host.setEditable(options.editable);
  host.setTheme(themeVars(darkColors, "Menlo", true));
  host.setSuggest(options.available ?? true);

  const guest = mountGuest(
    root,
    {
      post: (message) => {
        const raw = JSON.stringify(message);
        fromGuest.push(raw);
        if (options.swallowPick && message.type === "suggest-pick") return;
        host.receive(raw);
      },
      listen: (handler) => {
        deliver = handler;
      },
      // Run the guest's coalesced posts immediately: nothing here is about
      // frame timing, and a queue nobody drains would swallow the `change`
      // a pick produces.
      schedule: (flush) => {
        flush();
      },
    },
    document.documentElement,
  );

  guest.view.focus();

  return {
    guest,
    host,
    view: guest.view,
    asked,
    picked,
    fromGuest,
    destroy: () => {
      guest.destroy();
      root.remove();
    },
  };
}

/** Put the caret somewhere and ask CodeMirror for the list there. */
async function completionsAt(w: Wired, cursor: number): Promise<readonly string[]> {
  w.view.dispatch({ selection: { anchor: cursor } });
  startCompletion(w.view);
  await tick();
  return currentCompletions(w.view.state).map((option) => option.label);
}

describe("the line crosses and the plugin's items come back", () => {
  test("the plugin is asked the line up to the caret, and where the caret is in it", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
    });
    await completionsAt(w, "see --Heb 11:1".length);
    expect(w.asked).toEqual([{ line: "see --Heb 11:1", ch: "see --Heb 11:1".length }]);
    w.destroy();
  });

  test("and what it answered is what the editor offers", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }, { text: "Hebrews 11:1 (NIV)" }],
    });
    const labels = await completionsAt(w, "see --Heb 11:1".length);
    expect(labels).toEqual(["Hebrews 11:1 (KJV)", "Hebrews 11:1 (NIV)"]);
    w.destroy();
  });

  /**
   * The ask and the answer are a request/reply pair on the bridge, matched by
   * a token — the same shape `form-submit` uses and for the same reason: two
   * asks can be in flight, and "the last reply is for the last request" is not
   * true when the answer comes from a sandbox.
   */
  test("the ask crosses as a tokened request", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
    });
    await completionsAt(w, "see --Heb 11:1".length);
    const ask = w.fromGuest.map((raw) => JSON.parse(raw)).find((m) => m.type === "suggest-ask");
    expect(ask).toMatchObject({
      v: PROTOCOL_VERSION,
      type: "suggest-ask",
      line: "see --Heb 11:1",
      ch: "see --Heb 11:1".length,
    });
    expect(typeof ask.token).toBe("string");
    w.destroy();
  });
});

describe("nothing is asked while nothing can answer", () => {
  /**
   * The state every surface with no plugin running is in — and every note on
   * every surface before a plugin is started. A source that asked anyway would
   * be a bridge round trip per keystroke, forever, for an empty list.
   */
  test("no plugin running means no message at all", async () => {
    const w = connect({ doc: "see --Heb 11:1 now", editable: true, available: false });
    await completionsAt(w, "see --Heb 11:1".length);
    expect(w.fromGuest.map((raw) => JSON.parse(raw)).filter((m) => m.type === "suggest-ask")).toEqual(
      [],
    );
    expect(w.asked).toEqual([]);
    w.destroy();
  });

  /**
   * A plugin started after the note was opened is the case the whole
   * indirection exists for: the editor's state is built once, so a source that
   * captured "nobody can answer" at mount would stay silent for the life of
   * that editor. The web half documents this as its second production report.
   */
  test("a plugin started after the note was opened is asked", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      available: false,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
    });
    await completionsAt(w, "see --Heb 11:1".length);
    expect(w.asked).toEqual([]);

    w.host.setSuggest(true);
    const labels = await completionsAt(w, "see --Heb 11:1".length);
    expect(labels).toEqual(["Hebrews 11:1 (KJV)"]);
    w.destroy();
  });

  /** And a plugin stopped afterwards stops being asked. */
  test("a plugin stopped afterwards is not", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
    });
    await completionsAt(w, "see --Heb 11:1".length);
    expect(w.asked.length).toBe(1);

    w.host.setSuggest(false);
    await completionsAt(w, "see --Heb 11:1".length);
    expect(w.asked.length).toBe(1);
    w.destroy();
  });
});

describe("what a pick writes", () => {
  test("the line the plugin produced, in place of the line it was shown", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
      pick: () => "see [[Hebrews 11-1]]",
    });
    await completionsAt(w, "see --Heb 11:1".length);
    const option = currentCompletions(w.view.state)[0];
    (option.apply as (view: EditorView) => void)(w.view);
    await tick();
    expect(w.picked).toEqual([0]);
    expect(w.view.state.doc.toString()).toBe("see [[Hebrews 11-1]] now");
    w.destroy();
  });

  /**
   * THE REFUSAL THIS FILE MOST NEEDS.
   *
   * A pick is an edit, and `EditorView.editable.of(false)` does not stop a
   * programmatic one — the whole subject of `editability`'s third facet. The
   * guest's `changeFilter` is the last refusal; this is the one before it, on
   * the other side of a process boundary, because "the other side checked" is
   * exactly the assumption that let a read-only drop rewrite a document for a
   * release.
   */
  test("a pick on a note the viewer may not write never reaches the plugin", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: false,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
      pick: () => "see [[Hebrews 11-1]]",
    });
    await completionsAt(w, "see --Heb 11:1".length);
    const option = currentCompletions(w.view.state)[0];
    (option.apply as (view: EditorView) => void)(w.view);
    await tick();
    expect(w.picked).toEqual([]);
    expect(w.view.state.doc.toString()).toBe("see --Heb 11:1 now");
    w.destroy();
  });
});

describe("a reply is not trusted to be the shape it claims", () => {
  /**
   * `decode` proves a message is one of ours and says nothing about its
   * payload, and this payload becomes an **edit**. `decodeCommand` carries the
   * same rule one level in for the accessory bar; a `suggest-pick-result`
   * whose text arrived as an object would put `[object Object]` into somebody's
   * note.
   */
  /**
   * The host is held back so that the reply below is the FIRST answer to that
   * token rather than a second one to an entry already settled and deleted. The
   * first version of this test replied second, and passed with the guard taken
   * out — which is what `swallowPick` exists for.
   */
  async function pickAnsweredWith(text: unknown): Promise<string> {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () => [{ text: "Hebrews 11:1 (KJV)" }],
      swallowPick: true,
    });
    await completionsAt(w, "see --Heb 11:1".length);
    const option = currentCompletions(w.view.state)[0];
    (option.apply as (view: EditorView) => void)(w.view);
    await tick();

    const pick = w.fromGuest.map((raw) => JSON.parse(raw)).find((m) => m.type === "suggest-pick");
    expect(pick).toBeDefined();
    w.guest.receive(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "suggest-pick-result",
        token: pick.token,
        text,
      }),
    );
    await tick();
    const doc = w.view.state.doc.toString();
    w.destroy();
    return doc;
  }

  /** The harness itself, proven: a well-formed answer down this path does write. */
  test("a pick answer that is a string is written", async () => {
    expect(await pickAnsweredWith("see [[Hebrews 11-1]]")).toBe("see [[Hebrews 11-1]] now");
  });

  test("a pick answer that is not a string writes nothing", async () => {
    expect(await pickAnsweredWith({ nasty: true })).toBe("see --Heb 11:1 now");
  });

  /**
   * All or nothing, and the reason is the pick.
   *
   * A pick crosses back as an *index* into this list. Dropping the malformed
   * row and offering the good ones is the obvious kindness and renumbers every
   * row after it — the reader picks the label they read and the plugin rewrites
   * their line from the row below it. A list that cannot be picked from
   * correctly is not a list worth showing.
   */
  test("one malformed item silences the whole list rather than renumbering it", async () => {
    const w = connect({
      doc: "see --Heb 11:1 now",
      editable: true,
      items: () =>
        [
          { text: "Hebrews 11:1 (KJV)" },
          { text: 7 },
          { text: "Hebrews 11:1 (NIV)" },
        ] as unknown as { text: string }[],
    });
    const labels = await completionsAt(w, "see --Heb 11:1".length);
    expect(labels).toEqual([]);
    w.destroy();
  });
});
