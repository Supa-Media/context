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
  savesToBucket,
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
  mayPersist,
  isWriter,
  mergeExternalText,
  seedSharedDoc,
} from "../features/console/presence/sharedDoc";
import { applyExternalWrite } from "../features/console/presence/externalWrite";
import { newDrawing, serializeDrawing } from "@context/drawings";
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
    isAgent: false,
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

    /*
      Except for a tool's, which never fades.

      A person's caret keeps moving, so its label comes back whenever they do
      anything; a tool's lands once when its write does and then sits still
      until it is taken down about a minute later. Fading it leaves an
      unattributed caret in somebody's note for the rest of that minute, which
      is precisely the question — *who is changing this?* — the feature exists
      to answer.
    */
    const tool = member({ head: at(3), name: "Some Client", isAgent: true });
    const long = buildCaretDecorations([tool], 10, 1_000 + CARET_LABEL_MS * 100, moved, resolve);
    expect(label(long)).toBe("Some Client");
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
    // And reports no span, because a caret is a claim that somebody is
    // working at a position and an identical file is not an edit.
    const { a } = pair();
    seedSharedDoc(a, "same");
    expect(mergeExternalText(a, "same")).toBeNull();
  });

  test("the span it reports is where the tool's text actually landed", () => {
    /*
      This is the position a tool's caret is drawn at, so it is asserted
      against the merged text rather than against the arithmetic that produced
      it: `slice(from, to)` has to be exactly what the tool wrote and nothing
      of what was already there.
    */
    const { a } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const span = mergeExternalText(a, "# Notes\n\nfirst line\nsecond line\n");
    expect(span).not.toBeNull();
    expect(a.markdown().slice(span!.from, span!.to)).toBe("second line\n");
  });

  test("a tool that rewrote the middle reports the middle", () => {
    // Not an append: the suffix is shared, so the span must stop before it
    // rather than running to the end of the note.
    const { a } = pair();
    seedSharedDoc(a, "top\nMIDDLE\nbottom\n");
    const span = mergeExternalText(a, "top\nchanged\nbottom\n");
    expect(a.markdown().slice(span!.from, span!.to)).toBe("changed");
  });
});

/*
  A TOOL'S VERSION MAY ONLY BE ADOPTED BY A CLIENT THAT RECEIVED ITS CONTENT.

  A console save is a conditional write against the etag the editor holds, and
  that refusal is the only thing between a stale draft and a silent overwrite.
  Moving the etag spends it. So the two halves of a write — its content and its
  version — travel together or not at all.

  These checks are here rather than in the hook because `usePresence`'s socket
  handler is not reachable by any test in this repository, which
  `docs/decisions/testing.md` now states outright. That is exactly why the
  decision was moved out of it: measured beforehand, inverting the `if` that
  used to live there failed **0** of the app's tests.
*/
describe("a tool's write, and the version that comes with it", () => {
  /*
    Built with the package's own serializer rather than hand-written, so the
    fixture is a drawing by construction: a hand-rolled payload that stopped
    parsing would turn these checks green for the wrong reason.
  */
  /** Two documents wired to each other, as the room wires them. */
  function pair() {
    let a: ReturnType<typeof createSharedDoc>;
    let b: ReturnType<typeof createSharedDoc>;
    a = createSharedDoc({ onLocalUpdate: (u) => b.applyRemote(u) });
    b = createSharedDoc({ onLocalUpdate: (u) => a.applyRemote(u) });
    return { a, b };
  }

  /**
   * Every sink, recorded.
   *
   * One recorder rather than a counter per test: the defects this describe
   * exists for were all "the right thing happened and the wrong thing also
   * did", and a test that counts only what it expects cannot see the second
   * half of that.
   */
  function sinks() {
    const seen = {
      delivered: [] as unknown[][],
      shared: [] as unknown[][],
      carets: [] as { from: number; to: number }[],
      pointers: [] as { x: number; y: number }[],
      adopted: 0,
    };
    return {
      seen,
      deliverElements: (elements: unknown[]) => seen.delivered.push(elements),
      shareElements: (elements: unknown[]) => seen.shared.push(elements),
      reportCaret: (span: { from: number; to: number }) => seen.carets.push(span),
      reportPointer: (at: { x: number; y: number }) => seen.pointers.push(at),
      adopt: () => {
        seen.adopted += 1;
      },
    };
  }

  const DRAWING_PATH = "1-projects/plan.excalidraw.md";
  const blank = newDrawing() as string;
  const oneShape = serializeDrawing(blank, [
    { id: "one", type: "rectangle", version: 3, versionNonce: 7, x: 0, y: 0, width: 10, height: 10 },
  ] as never[]) as string;
  const emptyScene = serializeDrawing(blank, [] as never[]) as string;

  test("a note adopts it, and holds the text that came with it", () => {
    const { a, b } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const out = sinks();
    applyExternalWrite(
      { text: "# Notes\n\nfirst line\nfrom a tool\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect(out.seen.adopted).toBe(1);
    expect(a.markdown()).toBe("# Notes\n\nfirst line\nfrom a tool\n");
    // The peer bound to the same document has it too, which is what makes
    // adopting the version safe rather than only defensible.
    expect(b.markdown()).toBe(a.markdown());
  });

  test("a merge that throws does not move the version", () => {
    /*
      The document is left exactly as it was, so this client does not hold the
      tool's text — and the branch that swallowed the throw moved the version
      regardless, reasoning that "the bucket has the tool's version either
      way". True before the version moved; false after it.
    */
    const { a } = pair();
    seedSharedDoc(a, "intact");
    const exploding = {
      ...a,
      doc: {
        ...a.doc,
        transact: () => {
          throw new Error("a document mid-transaction");
        },
      },
    } as unknown as typeof a;
    const out = sinks();
    applyExternalWrite(
      { text: "something else", path: "1-projects/n.md", shared: exploding, drawing: false },
      out,
    );
    // No version, and no caret either: a caret drawn for a merge that did not
    // happen points at text nobody in this room can see.
    expect([out.seen.adopted, out.seen.carets.length]).toEqual([0, 0]);
    expect(a.markdown()).toBe("intact");
  });

  test("a canvas adopts it only once the elements are delivered", () => {
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.delivered.length).toBe(1);
    expect((out.seen.delivered[0] as { id: string }[]).map((element) => element.id)).toEqual(["one"]);
    expect(out.seen.adopted).toBe(1);
  });

  test("a payload carrying no elements delivers nothing and moves nothing", () => {
    /*
      Not a cleared canvas — Excalidraw deletes by flag, so a real clear
      arrives as elements carrying `isDeleted`. This is a scene this client
      cannot be brought onto, and claiming its version would have the next save
      put the old shapes back over it.
    */
    const out = sinks();
    applyExternalWrite({ text: emptyScene, path: DRAWING_PATH, shared: null, drawing: true }, out);
    // Nothing delivered, nothing re-broadcast, no pointer, no version.
    expect([
      out.seen.delivered.length,
      out.seen.shared.length,
      out.seen.pointers.length,
      out.seen.adopted,
    ]).toEqual([0, 0, 0, 0]);
  });

  test("a payload this console could not have opened delivers nothing either", () => {
    /*
      `parseDrawing` reports rather than throws, for all three of its reasons,
      so this is the branch that has to carry them. Each one arrives with
      `elements: null` and must leave the version where it is.

      Measured before it was written: a `catch` here failed **0** checks,
      because nothing makes that parser throw. A guard around a throw that
      cannot happen is not a guard.
    */
    for (const text of ["# just a note", "", "```compressed-json\nnot-base64!!\n```"]) {
      const out = sinks();
      applyExternalWrite({ text, path: DRAWING_PATH, shared: null, drawing: true }, out);
      expect([text, out.seen.delivered.length, out.seen.shared.length, out.seen.adopted]).toEqual([
        text,
        0,
        0,
        0,
      ]);
    }
  });

  test("a room that is neither receives nothing", () => {
    // No document and not a canvas: there is nothing here that could take the
    // write, so there is nothing that may take its version.
    const out = sinks();
    applyExternalWrite({ text: "anything", path: "1-projects/n.md", shared: null, drawing: false }, out);
    expect(out.seen.adopted).toBe(0);
  });

  /*
    A TOOL IS SOMEBODY IN THE ROOM, NOT TEXT THAT APPEARS FROM NOWHERE.

    Watching an agent work was the point of the whole feature, and the first
    version of it delivered the agent's write to one browser and told nobody:
    the second person on a note saw the paragraph (it is an edit, and edits
    travel) and the second person on a *canvas* saw nothing at all, because
    elements handed to one browser's Excalidraw go nowhere.

    So the client the room asked to merge owes the room two things afterwards,
    and they are the two halves below.
  */
  test("a tool's caret is reported where its text landed", () => {
    const { a } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const out = sinks();
    applyExternalWrite(
      { text: "# Notes\n\nfirst line\nfrom a tool\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect(out.seen.carets.length).toBe(1);
    const span = out.seen.carets[0];
    expect(a.markdown().slice(span.from, span.to)).toBe("from a tool\n");
  });

  test("a tool that changed nothing gets no caret", () => {
    // A rewrite of identical content is not somebody working in the note, and
    // a caret would say it was. The version still moves: the bucket did.
    const { a } = pair();
    seedSharedDoc(a, "unchanged");
    const out = sinks();
    applyExternalWrite(
      { text: "unchanged", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect([out.seen.carets.length, out.seen.adopted]).toEqual([0, 1]);
  });

  test("a tool's elements go to everybody else, not just to this browser", () => {
    /*
      The defect, exactly: the room hands a canvas write to one member because
      the same *text* merged twice inserts it twice — but elements reconcile by
      version, so the second person's canvas stayed empty for no reason at all.
      Delivered here and re-broadcast, and the same elements in both.
    */
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.shared.length).toBe(1);
    expect((out.seen.shared[0] as { id: string }[]).map((one) => one.id)).toEqual(["one"]);
    expect(out.seen.shared[0]).toEqual(out.seen.delivered[0]);
  });

  test("a note's merge is not re-broadcast, because it already travels", () => {
    // The other half of the rule above, and the one that would be a duplicated
    // paragraph rather than a redundant frame: text merged into the shared
    // document reaches every peer down the ordinary update path.
    const { a } = pair();
    seedSharedDoc(a, "first\n");
    const out = sinks();
    applyExternalWrite(
      { text: "first\nsecond\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect([out.seen.shared.length, out.seen.delivered.length]).toEqual([0, 0]);
  });

  test("a tool's pointer lands on the shape it just drew", () => {
    const recent = serializeDrawing(blank, [
      { id: "old", type: "rectangle", version: 40, versionNonce: 1, updated: 1_000, x: 0, y: 0, width: 10, height: 10 },
      { id: "new", type: "rectangle", version: 1, versionNonce: 2, updated: 2_000, x: 100, y: 100, width: 20, height: 20 },
    ] as never[]) as string;
    const out = sinks();
    applyExternalWrite({ text: recent, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.pointers).toEqual([{ x: 110, y: 110 }]);
  });

  test("a scene with no honest position gets no pointer, and still adopts", () => {
    /*
      `oneShape` carries no `updated` — it is hand-built above — which is the
      case of a tool that wrote a file without going through Excalidraw. A
      pointer at the origin would claim the tool is working in the top-left
      corner of somebody's canvas. Withholding the *version* over it would be
      the separate, worse bug: the shapes arrived, which is the whole test.
    */
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect([out.seen.pointers.length, out.seen.adopted]).toEqual([0, 1]);
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
    const later = { id: "m9", canWrite: true };

    /*
      **The roster never contains the caller**, which these calls used to get
      wrong — they passed the caller's own entry in `members` and so tested a
      shape `session.ts` does not produce. Your own authority is the second
      argument now; the list is the other people.
    */
    expect(electWriter("m2", true, [viewer, later])).toBe(true);
    expect(electWriter("m1", false, [later])).toBe(false);
    expect(electWriter("m9", true, [viewer, { id: "m2", canWrite: true }])).toBe(false);

    // A read-only member alone in a room elects nobody, rather than itself
    // against an empty field.
    expect(electWriter("m1", false, [])).toBe(false);

    // And when the only editor leaves, the next one takes over off the very
    // next roster.
    expect(electWriter("m9", true, [viewer])).toBe(true);

    // Nobody is elected before the room has named this client.
    expect(electWriter(null, true, [later])).toBe(false);
  });
});

describe("who actually writes the note to the bucket", () => {
  /*
    THE SEAM NOTHING CROSSED, AND IT COST EVERY SAVE IN THE PRODUCT.

    Reported by the owner: "new changes are not saved/persisted, when I refresh
    the page, or go to a page and then come back, all the new things added is
    lost."

    `electWriter` required the caller to appear in its own `members` list. The
    reducer **removes** the caller from that list — `session.ts` does it in the
    welcome branch, deliberately, because the roster is what the header counts
    as "2 here". So the guard could never be satisfied: `canWrite` was false for
    every client in every room, `mayPersist` therefore refused every change and
    every ⌘S, and the text lived in the shared document and in the room's log
    and never reached the bucket at all.

    Every test on both sides was green. The unit tests below called
    `electWriter("m2", [viewer, editor, later])` with `editor` being `m2` — a
    roster containing the caller. The browser harness built `state.members`
    from the welcome frame **unfiltered**, so it contained the caller too, and
    "exactly one browser is elected to save" passed against a roster shape the
    product never produces.

    So the checks here drive the **real reducer** with a **real welcome frame**
    and ask the question the editor asks. That is the only shape that could
    have caught this, and it is why the decision now lives in a pure function
    rather than inside the hook.
  */

  /** A room as the app builds one: a welcome through the real reducer. */
  function room(you: string, everybody: { id: string; canWrite: boolean }[]): PresenceState {
    return presenceReducer(
      { ...initialPresenceState, phase: "connecting", notePath: "a.md" },
      {
        type: "frame",
        notePath: "a.md",
        frame: {
          t: "welcome",
          you,
          members: everybody.map((one) => member({ id: one.id, canWrite: one.canWrite })),
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        },
      },
    );
  }

  test("somebody alone in a note saves it", () => {
    // The whole bug, in one line. A person opens a note nobody else is in,
    // types, and the text must reach the bucket.
    const alone = room("me", [{ id: "me", canWrite: true }]);
    expect(savesToBucket(alone)).toBe(true);
  });

  test("...and mayPersist agrees, which is what the editor actually calls", () => {
    // `bound` rather than the document's existence: the editor asks whether it
    // is wired to a room, not whether one was allocated. See `mayPersist`.
    const alone = room("me", [{ id: "me", canWrite: true }]);
    expect(mayPersist({ bound: true, canWrite: savesToBucket(alone) })).toBe(true);
  });

  test("exactly one of two editors saves, and it is the lower id", () => {
    const mine = room("m2", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    const theirs = room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    expect([savesToBucket(mine), savesToBucket(theirs)]).toEqual([true, false]);
  });

  test("a read-only viewer never saves, even alone in a room", () => {
    // The other half, and the reason the caller's own authority has to travel
    // rather than be assumed: a viewer alone would otherwise elect itself
    // against an empty field and push a draft the room refuses.
    const viewer = room("m1", [{ id: "m1", canWrite: false }]);
    expect(savesToBucket(viewer)).toBe(false);
  });

  test("...and the lowest id being a viewer does not stop the editor saving", () => {
    // A room whose lowest member id belongs to a read-only viewer used to
    // elect that viewer, and then nobody saved at all.
    const editor = room("m2", [
      { id: "m1", canWrite: false },
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    expect(savesToBucket(editor)).toBe(true);
  });

  test("a client with no live room saves, exactly as it did before presence", () => {
    /*
      **Presence is never allowed to break the editor**, and this is the half
      the election quietly took away. `shared` is created the moment the hook
      runs, before any socket connects and whether or not one ever does — so
      `mayPersist`'s "no room at all" escape hatch could not fire, and a
      gateway with no presence binding, a refused socket or a dead network left
      the editor unable to save anything.

      Nobody else is coordinating in any of these states, so this client is the
      one that saves.
    */
    for (const phase of ["idle", "connecting", "unavailable", "reconnecting"] as const) {
      const state = { ...initialPresenceState, phase, notePath: "a.md" };
      expect([phase, savesToBucket(state)]).toEqual([phase, true]);
    }
  });

  /*
    THE SOCKET OPENING IS NOT THE ROOM NAMING YOU.

    `connected` fires from `live.onopen` and sets `phase: "live"` — before any
    frame, so with `you: null` and `youCanWrite: false`. `savesToBucket` then
    takes the live branch and `electWriter` refuses, because there is nobody to
    elect: this client has no id and no roster yet.

    That is the same sentence this whole change exists to delete — nobody is
    elected, so nothing is written — reached by a different route, and every
    reconnect passes through it as well as every first connect. Nobody is
    coordinating this client in that window either: the escape hatch's
    condition drifted from the state it describes, because `live` is one label
    over two different states and only one of them has an identity in it.

    The loop above could not see it: it enumerates phases against
    `initialPresenceState`, and this is a phase-and-identity pair.
  */
  test("a socket that is open but not yet welcomed still saves", () => {
    const open = presenceReducer(initialPresenceState, { type: "open", notePath: "a.md" });
    const connected = presenceReducer(open, { type: "connected" });
    expect([connected.phase, connected.you]).toEqual(["live", null]);
    expect(savesToBucket(connected)).toBe(true);
  });

  test("...and so does a reconnected socket waiting for its welcome", () => {
    const dropped = presenceReducer(room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]), { type: "dropped" });
    const reopened = presenceReducer(dropped, { type: "connected" });
    expect([reopened.phase, reopened.you]).toEqual(["live", null]);
    expect(savesToBucket(reopened)).toBe(true);
  });

  test("...and the welcome still hands the decision back to the election", () => {
    // The positive control: without it, "always save when live" would pass
    // both checks above and take the election away entirely.
    const viewer = room("m9", [{ id: "m2", canWrite: true }, { id: "m9", canWrite: false }]);
    expect([viewer.phase, savesToBucket(viewer)]).toEqual(["live", false]);
  });

  test("...including a reconnect that still remembers the roster", () => {
    // `dropped` keeps the members and clears `you`. Saving during the gap can
    // cost a conflict; not saving costs the work, and a conflict is the one
    // the person can see and recover from.
    const dropped = presenceReducer(room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]), { type: "dropped" });
    expect(dropped.phase).toBe("reconnecting");
    expect(savesToBucket(dropped)).toBe(true);
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
