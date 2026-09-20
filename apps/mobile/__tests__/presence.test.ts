/**
 * @jest-environment jsdom
 */

/**
 * PRESENCE, ON THE CLIENT — the wire, the state machine, and the decorations.
 *
 * The socket itself lives in `usePresence` and is deliberately not tested here:
 * everything it *decides* was moved into `session.ts` so it could be, which is
 * the same split `autosave.ts` draws. What is left in the hook is a
 * `WebSocket`, three timers and React.
 *
 * Two failures are worth naming before the checks that prove they cannot
 * happen, because both would be reported as "the editor is broken" rather than
 * as "presence is broken":
 *
 *  1. **A caret drawn past the end of the document.** Offsets come from another
 *     person's browser through a gateway that has never seen this note, so they
 *     can be anything. A CodeMirror range past `doc.length` throws inside the
 *     update cycle of an editor somebody is typing in, which costs them their
 *     next keystrokes.
 *  2. **Carets from the note you just closed, in the note you just opened.** A
 *     frame in flight when a different note is opened describes a document that
 *     is no longer on screen, and its offsets are meaningless against the one
 *     that is.
 */

import { describe, expect, test } from "@jest/globals";
import {
  clampToDocument,
  cursorFrame,
  decodeServerFrame,
  presenceSocketUrl,
  type PresenceMember,
} from "../features/console/presence/protocol";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
  reconnectDelayMs,
  type PresenceState,
} from "../features/console/presence/session";
import {
  CARET_LABEL_MS,
  buildCaretDecorations,
  reportSelection,
} from "../features/console/presence/remoteCarets";
import {
  createSharedDoc,
  electWriter,
  isWriter,
  mergeExternalText,
  seedSharedDoc,
} from "../features/console/presence/sharedDoc";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * A peer, with its caret as an encoded relative position.
 *
 * The tests use readable stand-ins ("p:12") and a resolver that reads the
 * number back out, because what these checks are about is the geometry the
 * decorations produce — not Yjs's encoding, which `sync.test` covers against
 * a real document.
 */
function member(over: Partial<PresenceMember> = {}): PresenceMember {
  return {
    id: "m1",
    name: "@ana",
    color: "#8b5cf6",
    anchor: "p:0",
    head: "p:0",
    canWrite: true,
    ...over,
  };
}

/** Reads the offset back out of a stand-in position. */
const resolve = (encoded: string): number | null => {
  const match = /^p:(-?\d+)$/.exec(encoded);
  return match ? Number(match[1]) : null;
};

const at = (offset: number) => `p:${offset}`;

function live(members: PresenceMember[]): PresenceState {
  return { ...initialPresenceState, phase: "live", notePath: "a.md", you: "me", members, stale: false };
}

describe("the presence wire", () => {
  test("a frame that is not one is ignored rather than thrown on", () => {
    expect(decodeServerFrame("not json")).toBeNull();
    expect(decodeServerFrame("[1,2]")).toBeNull();
    expect(decodeServerFrame("null")).toBeNull();
    expect(decodeServerFrame(42)).toBeNull();
    expect(decodeServerFrame('{"t":"nonsense"}')).toBeNull();
  });

  test("a welcome from another protocol version is refused", () => {
    // Refused rather than half-read: a client that guesses at frames it does
    // not understand draws a roster it cannot justify.
    expect(decodeServerFrame('{"t":"welcome","v":99,"you":"m1","members":[]}')).toBeNull();
    expect(decodeServerFrame('{"t":"welcome","v":1,"you":"m1","members":[]}')).not.toBeNull();
  });

  test("a member without an id is dropped from the roster rather than drawn", () => {
    const frame = decodeServerFrame(
      '{"t":"welcome","v":1,"you":"me","members":[{"id":"m1","name":"@ana"},{"name":"@nobody"}]}',
    );
    expect(frame).toMatchObject({ t: "welcome" });
    expect(frame && frame.t === "welcome" ? frame.members.length : -1).toBe(1);
  });

  test("a peer's name cannot carry control characters into the label", () => {
    const frame = decodeServerFrame(
      JSON.stringify({ t: "join", member: { id: "m2", name: `${String.fromCharCode(0x202e)}evil\nname`, a: 0, h: 0 } }),
    );
    expect(frame && frame.t === "join" ? frame.member.name : "").toBe("evilname");
  });

  test("a peer's colour is refused unless it is a plain hex", () => {
    // It is written into a style attribute. "red; background: url(...)" is the
    // shape this refuses. `null` rather than a fallback hex: this module decides
    // what is safe and the view decides what things look like, so the
    // substitute comes from the palette rather than from a literal on the wire.
    const frame = decodeServerFrame(
      JSON.stringify({ t: "join", member: { id: "m2", name: "@x", color: "red;x:y", a: 0, h: 0 } }),
    );
    expect(frame && frame.t === "join" ? frame.member.color : "unread").toBeNull();
  });

  test("a caret position that is not a position is dropped, not guessed at", () => {
    // Relative positions replaced integer offsets, so the check changed with
    // them: there is no clamping to do, and the failure mode to guard is a
    // peer sending something that is not an encoded position at all. `null`
    // means "do not draw this caret" rather than "draw it at the start", which
    // would put somebody's name at the top of the note and claim they are there.
    const frame = decodeServerFrame('{"t":"cursor","id":"m1","a":"not base64!","h":12}');
    expect(frame).toEqual({ t: "cursor", id: "m1", anchor: null, head: null });
  });

  test("a caret frame carries two positions and a type, and nothing else", () => {
    // The property the whole feature rests on, asserted rather than commented:
    // there is no field on this frame that note text could travel in.
    expect(Object.keys(JSON.parse(cursorFrame("p:3", "p:9"))).sort()).toEqual(["a", "h", "t"]);
    expect(JSON.parse(cursorFrame(null, null))).toEqual({ t: "cursor", a: null, h: null });
  });

  test("the socket url carries the token in the path, over wss", () => {
    const url = presenceSocketUrl({
      gatewayOrigin: "https://mcp.example.test",
      notePath: "1-projects/a b.md",
      token: "cat_example",
      colorSeed: "tab-1",
    });
    expect(url.startsWith("wss://mcp.example.test/t/cat_example/presence")).toBe(true);
    // The path is a query parameter and stays escaped; a space in a note name
    // is ordinary and must not split the URL.
    expect(url).toContain("note=1-projects%2Fa+b.md");
    expect(url).toContain("seed=tab-1");
  });

  test("a plain-http origin degrades to ws rather than silently staying https", () => {
    const url = presenceSocketUrl({
      gatewayOrigin: "http://localhost:8787",
      notePath: "a.md",
      token: "t",
      colorSeed: "s",
    });
    expect(url.startsWith("ws://localhost:8787/")).toBe(true);
  });
});

describe("the presence state machine", () => {
  test("a frame for another note is dropped", () => {
    // The failure this guard exists for: a socket opened for a.md delivering
    // after b.md was opened, painting b.md with a.md's offsets.
    const state = live([member()]);
    const next = presenceReducer(state, {
      type: "frame",
      notePath: "b.md",
      frame: { t: "leave", id: "m1" },
    });
    expect(next).toBe(state);
    expect(next.members).toHaveLength(1);
  });

  test("opening a different note keeps nothing from the last one", () => {
    const next = presenceReducer(live([member()]), { type: "open", notePath: "b.md" });
    expect(next.members).toEqual([]);
    expect(next.you).toBeNull();
    expect(next.notePath).toBe("b.md");
    expect(next.phase).toBe("connecting");
  });

  test("a welcome replaces the roster and leaves yourself out of it", () => {
    const next = presenceReducer(
      { ...initialPresenceState, phase: "connecting", notePath: "a.md" },
      {
        type: "frame",
        notePath: "a.md",
        frame: {
          t: "welcome",
          you: "me",
          members: [member({ id: "me" }), member({ id: "m2" })],
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        },
      },
    );
    expect(next.members.map((one) => one.id)).toEqual(["m2"]);
    expect(next.phase).toBe("live");
  });

  test("a join for an id already present replaces rather than duplicates", () => {
    const next = presenceReducer(live([member({ id: "m2", head: at(4) })]), {
      type: "frame",
      notePath: "a.md",
      frame: { t: "join", member: member({ id: "m2", head: at(9) }) },
    });
    expect(next.members).toHaveLength(1);
    expect(next.members[0].head).toBe(at(9));
  });

  test("a cursor for somebody not in the roster is dropped", () => {
    // Otherwise it becomes a nameless, colourless caret: a rendering bug
    // wearing a person's clothes.
    const state = live([member({ id: "m2" })]);
    const next = presenceReducer(state, {
      type: "frame",
      notePath: "a.md",
      frame: { t: "cursor", id: "ghost", anchor: at(1), head: at(2) },
    });
    expect(next).toBe(state);
  });

  test("a drop keeps the roster but stops the carets being drawn", () => {
    // A reconnect happens every five minutes by design. Emptying the header
    // each time would make everybody blink; drawing stale offsets would put
    // carets in the wrong place.
    const next = presenceReducer(live([member({ id: "m2" })]), { type: "dropped" });
    expect(next.phase).toBe("reconnecting");
    expect(next.members).toHaveLength(1);
    expect(next.stale).toBe(true);
    expect(next.you).toBeNull();
  });

  test("unavailable is terminal and cannot be talked back out of", () => {
    const dead = presenceReducer(live([member()]), { type: "unavailable" });
    expect(dead.phase).toBe("unavailable");
    expect(dead.members).toEqual([]);
    expect(presenceReducer(dead, { type: "connected" }).phase).toBe("unavailable");
    expect(
      presenceReducer(dead, {
        type: "frame",
        notePath: dead.notePath as string,
        frame: { t: "join", member: member() },
      }).members,
    ).toEqual([]);
  });

  test("the backoff is fast once and then bounded", () => {
    expect(reconnectDelayMs(1)).toBe(250);
    expect(reconnectDelayMs(4)).toBe(2_000);
    // A console left open overnight against a gateway that is down must not be
    // retrying every second by morning.
    expect(reconnectDelayMs(40)).toBe(30_000);
  });

  test("the header says nothing when there is nothing to say", () => {
    expect(presenceSummary(live([]))).toBe("");
    expect(presenceSummary(live([member()]))).toBe("1 here");
    expect(presenceSummary(live([member({ id: "a" }), member({ id: "b" })]))).toBe("2 here");
    expect(presenceSummary({ ...live([member()]), phase: "reconnecting" })).toBe("Reconnecting");
  });
});

describe("the caret decorations", () => {
  function positions(set: ReturnType<typeof buildCaretDecorations>) {
    const found: { from: number; to: number }[] = [];
    const cursor = set.iter();
    while (cursor.value !== null) {
      found.push({ from: cursor.from, to: cursor.to });
      cursor.next();
    }
    return found;
  }

  test("an offset past the end of the document is clamped, not thrown on", () => {
    // The failure worth the whole feature being reverted: this throws inside
    // the update cycle of an editor somebody is typing in.
    expect(() => buildCaretDecorations([member({ head: at(9_000), anchor: at(9_000) })], 10, 0, new Map(), resolve)).not.toThrow();
    const ranges = positions(buildCaretDecorations([member({ head: at(9_000), anchor: at(9_000) })], 10, 0, new Map(), resolve));
    expect(ranges).toEqual([{ from: 10, to: 10 }]);
  });

  test("a reversed selection is drawn the right way round", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: at(8), head: at(2) })], 20, 0, new Map(), resolve));
    expect(ranges).toContainEqual({ from: 2, to: 8 });
  });

  test("an empty selection draws a caret and no highlight", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: at(5), head: at(5) })], 20, 0, new Map(), resolve));
    expect(ranges).toEqual([{ from: 5, to: 5 }]);
  });

  test("several people are added in document order", () => {
    // `RangeSetBuilder` throws "Ranges must be added sorted" otherwise, and the
    // roster arrives in whatever order the room sent it.
    const ranges = positions(
      buildCaretDecorations([member({ id: "a", anchor: at(30), head: at(30) }), member({ id: "b", anchor: at(2), head: at(6) })], 40, 0, new Map(), resolve),
    );
    expect(ranges.map((one) => one.from)).toEqual([2, 6, 30].slice(0, ranges.length));
    expect(ranges).toEqual([...ranges].sort((x, y) => x.from - y.from || x.to - y.to));
  });

  test("a caret the document cannot place is not drawn", () => {
    // The replacement for clamping: a relative position referring to text this
    // client has not received yet resolves to nothing, and nothing is the
    // right thing to draw. Drawing at zero would be a claim about where
    // somebody is standing, and a false one.
    const ranges = positions(
      buildCaretDecorations([member({ head: "p:unresolvable" })], 20, 0, new Map(), resolve),
    );
    expect(ranges).toEqual([]);
  });

  test("clamping is the client's job because the server cannot do it", () => {
    expect(clampToDocument(-1, 10)).toBe(0);
    expect(clampToDocument(11, 10)).toBe(10);
    expect(clampToDocument(4.7, 10)).toBe(4);
  });

  test("the label is drawn only while the caret is recently moved", () => {
    const moved = new Map([["m1", 1_000]]);
    const fresh = buildCaretDecorations([member({ head: at(3) })], 10, 1_000 + CARET_LABEL_MS - 1, moved, resolve);
    const faded = buildCaretDecorations([member({ head: at(3) })], 10, 1_000 + CARET_LABEL_MS + 1, moved, resolve);
    // Same range either way — what changes is the widget, so compare the DOM
    // the widget builds rather than the positions.
    // The caret widget is not necessarily the first range: a member with a
    // selection contributes a mark before it. Find the widget rather than
    // assuming where it sits, which is what the first version of this did.
    const label = (set: ReturnType<typeof buildCaretDecorations>) => {
      const cursor = set.iter();
      while (cursor.value !== null) {
        const spec = cursor.value.spec as { widget?: { toDOM: () => HTMLElement } };
        if (spec.widget) return spec.widget.toDOM().textContent;
        cursor.next();
      }
      return null;
    };
    expect(label(fresh)).toBe("@ana");
    expect(label(faded)).toBe("");
  });
});

describe("the shared document", () => {
  /**
   * TWO EDITORS, ONE NOTE.
   *
   * These wire two documents to each other the way the room does — whatever
   * one produces, the other applies — and assert the thing the feature is for:
   * both people type at once and both keep every character.
   */
  function pair() {
    let a: ReturnType<typeof createSharedDoc>;
    let b: ReturnType<typeof createSharedDoc>;
    a = createSharedDoc({ onLocalUpdate: (u) => b.applyRemote(u) });
    b = createSharedDoc({ onLocalUpdate: (u) => a.applyRemote(u) });
    return { a, b };
  }

  test("a letter typed in one editor appears in the other", () => {
    const { a, b } = pair();
    seedSharedDoc(a, "hello");
    a.text.insert(5, "!");
    expect(b.markdown()).toBe("hello!");
  });

  test("two people typing at the same time keep both sets of characters", () => {
    // The whole point. Neither edit is discarded and neither overwrites the
    // other, which is what a conflict box exists to ask about and what this
    // removes the need to ask.
    const { a, b } = pair();
    seedSharedDoc(a, "the quick fox");
    a.text.insert(4, "very ");
    b.text.insert(13, " jumps");
    expect(a.markdown()).toBe(b.markdown());
    expect(a.markdown()).toContain("very ");
    expect(a.markdown()).toContain(" jumps");
  });

  test("only one client seeds, so the note does not arrive twice", () => {
    // The duplicated-first-paragraph bug every CRDT editor ships once.
    const { a, b } = pair();
    expect(seedSharedDoc(a, "the note")).toBe(true);
    expect(seedSharedDoc(b, "the note")).toBe(false);
    expect(a.markdown()).toBe("the note");
  });

  test("a late joiner replayed the log lands on the same text", () => {
    const { a } = pair();
    const log: string[] = [];
    const origin = createSharedDoc({ onLocalUpdate: (u) => log.push(u) });
    seedSharedDoc(origin, "a shared note");
    origin.text.insert(13, ", edited");

    const late = createSharedDoc({ onLocalUpdate: () => {} });
    for (const update of log) late.applyRemote(update);
    expect(late.markdown()).toBe(origin.markdown());
    void a;
  });

  test("a malformed update from a peer is refused, not fatal", () => {
    const { a } = pair();
    seedSharedDoc(a, "intact");
    expect(() => a.applyRemote("bm90IGEgdmFsaWQgdXBkYXRl")).not.toThrow();
    expect(a.markdown()).toBe("intact");
  });

  test("an agent's whole-file write lands as just the part that changed", () => {
    // An MCP agent appends a paragraph. If this replaced the document, every
    // caret in the room would jump to the end; instead the untouched prefix is
    // left alone and the new text is an insert.
    const { a, b } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const before = a.text.toString().indexOf("first");
    mergeExternalText(a, "# Notes\n\nfirst line\nsecond line\n");
    expect(b.markdown()).toBe("# Notes\n\nfirst line\nsecond line\n");
    // The prefix was not re-inserted: the position of existing text is unmoved.
    expect(a.text.toString().indexOf("first")).toBe(before);
  });

  test("an external write identical to the document changes nothing", () => {
    const { a } = pair();
    seedSharedDoc(a, "same");
    expect(mergeExternalText(a, "same")).toBe(false);
  });

  test("exactly one member is the writer, and it survives them leaving", () => {
    // Two writers would race to save the same document and conflict with each
    // other — the bug this feature removes, reintroduced from the other end.
    expect(isWriter("m2", ["m3", "m9"])).toBe(true);
    expect(isWriter("m9", ["m2", "m3"])).toBe(false);
    // m2 left; m3 takes over off the very next roster, with no gap.
    expect(isWriter("m3", ["m9"])).toBe(true);
    expect(isWriter(null, ["m1"])).toBe(false);
  });

  test("the election skips members the room would refuse an edit from", () => {
    /*
      A room whose lowest member id belongs to a read-only viewer used to elect
      that viewer, and then nobody saved at all: the one client that believed
      it was saving was the one whose frames the room drops. Both halves are
      checked, because leaving either out reintroduces it.
    */
    const viewer = { id: "m1", canWrite: false };
    const editor = { id: "m2", canWrite: true };
    const later = { id: "m9", canWrite: true };

    expect(electWriter("m2", [viewer, editor, later])).toBe(true);
    expect(electWriter("m1", [viewer, editor, later])).toBe(false);
    expect(electWriter("m9", [viewer, editor, later])).toBe(false);

    // A read-only member alone in a room elects nobody, rather than itself
    // against an empty field.
    expect(electWriter("m1", [viewer])).toBe(false);

    // And when the only editor leaves, the next one takes over off the very
    // next roster.
    expect(electWriter("m9", [viewer, later])).toBe(true);
  });
});

describe("presence cannot break the editor", () => {
  /**
   * The defect this describes was shipped and reported: somebody typed and
   * their characters did not appear.
   *
   * An `updateListener` runs *inside* the transaction applying a keystroke, so
   * a reporter that throws takes the edit with it — and it is reported as "the
   * editor is broken", not as "presence is broken", because from the typist's
   * side that is what happened. The guard is the try/catch in
   * `reportSelection`; this is what makes it a guard rather than a comment.
   */
  function editorWith(report: (anchor: number, head: number) => void) {
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello",
        extensions: [reportSelection(() => report)],
      }),
    });
    return view;
  }

  test("a reporter that throws does not stop the document changing", () => {
    const view = editorWith(() => {
      throw new Error("socket in a state nobody predicted");
    });
    expect(() =>
      view.dispatch({ changes: { from: 5, insert: " world" } }),
    ).not.toThrow();
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  test("a reporter that throws does not stop the selection moving", () => {
    const view = editorWith(() => {
      throw new Error("nope");
    });
    view.dispatch({ selection: { anchor: 2 } });
    expect(view.state.selection.main.anchor).toBe(2);
    view.destroy();
  });

  test("a working reporter is told where the caret went", () => {
    // Non-vacuity: without this, both checks above pass against a listener that
    // was never wired up at all.
    const seen: number[][] = [];
    const view = editorWith((anchor, head) => seen.push([anchor, head]));
    view.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 6 } });
    expect(seen.at(-1)).toEqual([6, 6]);
    view.destroy();
  });
});
