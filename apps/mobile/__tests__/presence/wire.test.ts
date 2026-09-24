/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import {
  cursorFrame,
  liveUpdateFrame,
  decodeServerFrame,
  presenceSocketUrl,
} from "../../features/console/presence/protocol";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
} from "../../features/console/presence/session";
import { createSharedDoc, seedSharedDoc } from "../../features/console/presence/sharedDoc";
import { cursorPositions } from "../../features/console/presence/sync";

describe("the presence wire", () => {
  test("live edits carry a generation and transient authorization, but peer frames cannot expose credentials", () => {
    expect(JSON.parse(liveUpdateFrame("doc-1", "AQID", "secret"))).toEqual({
      t: "live", documentId: "doc-1", d: "AQID", accessToken: "secret",
    });
    const frame = { t: "live", documentId: "doc-1", d: "AQID", clientKey: "peer", accessToken: "secret" };
    expect(decodeServerFrame(JSON.stringify(frame))).toEqual({
      t: "live", documentId: "doc-1", d: "AQID", clientKey: "peer",
    });
    for (const over of [{ documentId: "" }, { d: "?" }, { d: "A".repeat(32 * 1024 + 1) }, { clientKey: null }]) {
      expect(decodeServerFrame(JSON.stringify({ ...frame, ...over }))).toBeNull();
    }
  });
  test("durable cursor positions use the externally owned shared document", () => {
    const shared = createSharedDoc({});
    seedSharedDoc(shared, "hello world");
    const positions = cursorPositions(shared.text, 3, 8);
    expect(positions.anchor).toBeTruthy();
    expect(positions.head).toBeTruthy();
    expect(positions.anchor).not.toBe(positions.head);
    expect(cursorPositions(null, 3, 8)).toEqual({ anchor: null, head: null });
    shared.destroy();
  });

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

  test("a durable v2 welcome populates existing peers without ever authorizing legacy seeding", () => {
    const frame = decodeServerFrame(JSON.stringify({
      t: "welcome", v: 2, you: "me", seed: true,
      members: [{ id: "me", name: "@bo", w: true }, { id: "existing", name: "@ana", w: true }],
    }));
    expect(frame).toMatchObject({ t: "welcome", seed: false });
    const state = presenceReducer({ ...initialPresenceState, notePath: "a.md" }, {
      type: "frame", notePath: "a.md", frame: frame!,
    });
    expect(state.phase).toBe("live");
    expect(state.you).toBe("me");
    expect(state.members.map((peer) => peer.name)).toEqual(["@ana"]);
    expect(presenceSummary(state)).toBe("1 here");
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
