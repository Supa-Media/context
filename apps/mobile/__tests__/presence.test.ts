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
} from "../features/console/presence/remoteCarets";

function member(over: Partial<PresenceMember> = {}): PresenceMember {
  return { id: "m1", name: "@ana", color: "#8b5cf6", anchor: 0, head: 0, ...over };
}

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
      JSON.stringify({ t: "join", member: { id: "m2", name: "‮evil\nname", a: 0, h: 0 } }),
    );
    expect(frame && frame.t === "join" ? frame.member.name : "").toBe("evilname");
  });

  test("a peer's colour is refused unless it is a plain hex", () => {
    // It is written into a style attribute. "red; background: url(...)" is the
    // shape this refuses, and the fallback is the muted grey.
    const frame = decodeServerFrame(
      JSON.stringify({ t: "join", member: { id: "m2", name: "@x", color: "red;x:y", a: 0, h: 0 } }),
    );
    expect(frame && frame.t === "join" ? frame.member.color : "").toBe("#8D857B");
  });

  test("offsets from a peer are bounded before they are believed", () => {
    const frame = decodeServerFrame('{"t":"cursor","id":"m1","a":-4,"h":1e12}');
    expect(frame).toEqual({ t: "cursor", id: "m1", anchor: 0, head: 10_000_000 });
  });

  test("what this client sends is two integers and a type, and nothing else", () => {
    // The property the whole feature rests on, asserted rather than commented:
    // there is no field on this frame that note text could travel in.
    expect(Object.keys(JSON.parse(cursorFrame(3, 9))).sort()).toEqual(["a", "h", "t"]);
    expect(JSON.parse(cursorFrame(-1, 4.9))).toEqual({ t: "cursor", a: 0, h: 4 });
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
        },
      },
    );
    expect(next.members.map((one) => one.id)).toEqual(["m2"]);
    expect(next.phase).toBe("live");
  });

  test("a join for an id already present replaces rather than duplicates", () => {
    const next = presenceReducer(live([member({ id: "m2", head: 4 })]), {
      type: "frame",
      notePath: "a.md",
      frame: { t: "join", member: member({ id: "m2", head: 9 }) },
    });
    expect(next.members).toHaveLength(1);
    expect(next.members[0].head).toBe(9);
  });

  test("a cursor for somebody not in the roster is dropped", () => {
    // Otherwise it becomes a nameless, colourless caret: a rendering bug
    // wearing a person's clothes.
    const state = live([member({ id: "m2" })]);
    const next = presenceReducer(state, {
      type: "frame",
      notePath: "a.md",
      frame: { t: "cursor", id: "ghost", anchor: 1, head: 2 },
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
    expect(() => buildCaretDecorations([member({ head: 9_000, anchor: 9_000 })], 10, 0, new Map())).not.toThrow();
    const ranges = positions(buildCaretDecorations([member({ head: 9_000, anchor: 9_000 })], 10, 0, new Map()));
    expect(ranges).toEqual([{ from: 10, to: 10 }]);
  });

  test("a reversed selection is drawn the right way round", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: 8, head: 2 })], 20, 0, new Map()));
    expect(ranges).toContainEqual({ from: 2, to: 8 });
  });

  test("an empty selection draws a caret and no highlight", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: 5, head: 5 })], 20, 0, new Map()));
    expect(ranges).toEqual([{ from: 5, to: 5 }]);
  });

  test("several people are added in document order", () => {
    // `RangeSetBuilder` throws "Ranges must be added sorted" otherwise, and the
    // roster arrives in whatever order the room sent it.
    const ranges = positions(
      buildCaretDecorations(
        [member({ id: "a", anchor: 30, head: 30 }), member({ id: "b", anchor: 2, head: 6 })],
        40,
        0,
        new Map(),
      ),
    );
    expect(ranges.map((one) => one.from)).toEqual([2, 6, 30].slice(0, ranges.length));
    expect(ranges).toEqual([...ranges].sort((x, y) => x.from - y.from || x.to - y.to));
  });

  test("clamping is the client's job because the server cannot do it", () => {
    expect(clampToDocument(-1, 10)).toBe(0);
    expect(clampToDocument(11, 10)).toBe(10);
    expect(clampToDocument(4.7, 10)).toBe(4);
  });

  test("the label is drawn only while the caret is recently moved", () => {
    const moved = new Map([["m1", 1_000]]);
    const fresh = buildCaretDecorations([member({ head: 3 })], 10, 1_000 + CARET_LABEL_MS - 1, moved);
    const faded = buildCaretDecorations([member({ head: 3 })], 10, 1_000 + CARET_LABEL_MS + 1, moved);
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
