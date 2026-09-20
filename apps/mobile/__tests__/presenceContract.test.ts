/**
 * @jest-environment jsdom
 */

/**
 * THE TWO HALVES HAVE TO AGREE, AND NOTHING ELSE CHECKS THAT THEY DO.
 *
 * `apps/mcp/src/presence.js` decides what the room accepts. This app decides
 * what it sends and what it can read back. They are different codebases in
 * different languages that never import each other, and every test on either
 * side passes with a stub of the other — which is exactly the shape of a bug
 * that survives a green suite and then shows up as "I typed and nothing
 * happened" in two real windows.
 *
 * So this imports the gateway's real module and the client's real module and
 * runs frames between them. No fixtures, no stubs: if somebody renames a field
 * on one side, this is what goes red.
 */

import { describe, expect, test } from "@jest/globals";
// The gateway's own source, imported rather than mirrored.
import {
  MAX_UPDATE_BYTES,
  decodeClientFrame,
} from "../../mcp/src/presence.js";
import {
  askFrame,
  cursorFrame,
  decodeServerFrame,
  drawFrame,
  drawSnapshotFrame,
  pingFrame,
  pointerFrame,
  snapshotFrame,
  syncFrame,
} from "../features/console/presence/protocol";
import {
  changedElements,
  decodeElements,
  encodeElements,
  remember,
} from "@context/drawings";
import {
  encodeSyncStep1,
  encodeUpdate,
  readSyncMessage,
} from "../features/console/presence/sync";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";

describe("what the client sends, the room accepts", () => {
  test("a sync handshake", () => {
    // The first thing any client sends, on every connect and reconnect. If the
    // room refused this shape, nobody would ever receive a document.
    const doc = createSharedDoc({});
    const accepted = decodeClientFrame(askFrame(encodeSyncStep1(doc.doc)));
    expect(accepted.ok).toBe(true);
    // `ask`, not `y`: the room relays it without logging it, and lets a
    // read-only member send it, because asking what a note says is a read.
    expect(accepted.msg?.t).toBe("ask");
  });

  test("an edit", () => {
    let sent = "";
    const watched = createSharedDoc({
      onLocalUpdateBytes: (u) => (sent = syncFrame(encodeUpdate(u))),
    });
    seedSharedDoc(watched, "a real document");
    watched.text.insert(1, "x");

    const accepted = decodeClientFrame(sent);
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("y");
  });

  test("a snapshot", () => {
    const doc = createSharedDoc({});
    seedSharedDoc(doc, "# A note\n\nwith some words in it\n");
    const accepted = decodeClientFrame(snapshotFrame(doc.snapshot()));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("snap");
  });

  test("a caret and a heartbeat", () => {
    expect(decodeClientFrame(cursorFrame("QUJD", "QUJD")).ok).toBe(true);
    expect(decodeClientFrame(pingFrame()).ok).toBe(true);
  });

  test("a caret with no position is still a caret frame", () => {
    // An empty document has no character for a position to be relative to, so
    // `null` is an ordinary state on connect rather than a malformed frame.
    expect(decodeClientFrame(cursorFrame(null, null)).ok).toBe(true);
  });

  test("a real keystroke is nowhere near the room's ceiling", () => {
    // If it were, ordinary typing would be refused as oversized and the note
    // would silently stop syncing — a failure with no error anywhere.
    let sent = "";
    const typed = createSharedDoc({
      onLocalUpdateBytes: (u) => (sent = encodeUpdate(u)),
    });
    seedSharedDoc(typed, "x".repeat(20_000));
    typed.text.insert(10_000, "!");
    expect(new TextEncoder().encode(sent).length).toBeLessThan(MAX_UPDATE_BYTES / 4);
  });
});

describe("what the room sends, the client reads", () => {
  /**
   * The room relays frames between two clients, exactly as it does in
   * production: decode what the sender sent, hand the same payload to the
   * other side, and let the protocol do the rest.
   */
  function relay(from: { pending: string[] }, toDoc: ReturnType<typeof createSharedDoc>) {
    const replies: string[] = [];
    while (from.pending.length > 0) {
      const frame = from.pending.shift() as string;
      const atRoom = decodeClientFrame(frame);
      expect(atRoom.ok).toBe(true);
      const atClient = decodeServerFrame(JSON.stringify({ t: "y", d: atRoom.msg?.d }));
      expect(atClient).not.toBeNull();
      if (atClient && atClient.t === "y") {
        const outcome = readSyncMessage(atClient.d, toDoc.doc, "remote");
        if (outcome.kind === "reply") replies.push(syncFrame(outcome.payload));
      }
    }
    return replies;
  }

  test("an empty client joining a full room receives the document", () => {
    /*
      The bug this protocol replaced, as a check. The old relay had every
      client announce its whole document on connect and the room replace its
      history with it — so the second person to open a note destroyed what the
      first had written. Here the newcomer announces only what it *has*, which
      is nothing, and converges upward.
    */
    const full = createSharedDoc({});
    seedSharedDoc(full, "somebody's real work");
    const empty = createSharedDoc({});

    // The newcomer opens with SyncStep1; the room relays it; the holder replies.
    const fromEmpty = { pending: [syncFrame(encodeSyncStep1(empty.doc))] };
    const replies = relay(fromEmpty, full);
    relay({ pending: replies }, empty);

    expect(empty.markdown()).toBe("somebody's real work");
    expect(full.markdown()).toBe("somebody's real work");
  });

  test("...and the full client is not damaged by the exchange", () => {
    // Non-vacuity for the row above: the check would also pass if the protocol
    // simply wiped both, so the holder's own text is asserted too.
    const full = createSharedDoc({});
    seedSharedDoc(full, "still here");
    const empty = createSharedDoc({});
    const replies = relay({ pending: [syncFrame(encodeSyncStep1(empty.doc))] }, full);
    relay({ pending: replies }, empty);
    expect(full.markdown()).toBe("still here");
  });

  test("a relayed edit round-trips into another document", () => {
    const b = createSharedDoc({});
    const outbound: string[] = [];
    const a = createSharedDoc({
      onLocalUpdateBytes: (u) => outbound.push(syncFrame(encodeUpdate(u))),
    });
    seedSharedDoc(a, "shared");
    a.text.insert(6, " text");
    relay({ pending: outbound }, b);
    expect(b.markdown()).toBe("shared text");
  });

  test("a replayed log lands a late joiner on the same text", () => {
    // The room stores the sync messages it relayed and replays them in order.
    const log: string[] = [];
    const author = createSharedDoc({
      onLocalUpdateBytes: (u) => {
        const atRoom = decodeClientFrame(syncFrame(encodeUpdate(u)));
        if (atRoom.ok && atRoom.msg) log.push(atRoom.msg.d);
      },
    });
    seedSharedDoc(author, "# Roadmap\n");
    author.text.insert(author.text.length, "- presence\n");
    author.text.insert(author.text.length, "- merge\n");

    const joiner = createSharedDoc({});
    const sync = decodeServerFrame(JSON.stringify({ t: "sync", updates: log }));
    expect(sync).not.toBeNull();
    if (sync && sync.t === "sync") {
      for (const message of sync.updates) readSyncMessage(message, joiner.doc, "remote");
    }
    expect(joiner.markdown()).toBe(author.markdown());
    expect(joiner.markdown()).toContain("- merge");
  });

  test("the room's compaction request is one the client understands", () => {
    expect(decodeServerFrame(JSON.stringify({ t: "compact" }))).toEqual({ t: "compact" });
  });

  test("a canvas's elements are accepted, relayed and read back", () => {
    /*
      The drawing half of the same seam, and the same reason for existing: the
      gateway decides what a `draw` frame is, this app decides how one is
      built, and two codebases in two languages that never import each other
      are exactly where a rename passes both suites and breaks in a browser.

      What travels is elements. Merging the `.excalidraw.md` *file* as
      collaborative text would merge two people's compressed payloads character
      by character, which produces a scene that is neither person's drawing.
    */
    const scene = [
      { id: "r1", type: "rectangle", version: 3, versionNonce: 7, x: 10, y: 20 },
      { id: "t1", type: "text", version: 1, versionNonce: 9, text: "héllo 🌍" },
    ];

    const atRoom = decodeClientFrame(drawFrame(encodeElements(scene)));
    expect(atRoom.ok).toBe(true);
    expect(atRoom.msg?.t).toBe("draw");

    // The room relays it under the same type whichever way it arrived, so a
    // compaction and an ordinary change read identically on the far side.
    const snapAtRoom = decodeClientFrame(drawSnapshotFrame(encodeElements(scene)));
    expect(snapAtRoom.ok).toBe(true);
    expect(snapAtRoom.msg?.t).toBe("drawsnap");

    const atClient = decodeServerFrame(JSON.stringify({ t: "draw", d: atRoom.msg?.d }));
    expect(atClient).not.toBeNull();
    if (atClient && atClient.t === "draw") {
      const back = decodeElements(atClient.d);
      expect(back).toEqual(scene);
    }
  });

  test("only this person's own changes go out, not everything on the canvas", () => {
    // Excalidraw reports a change per animation frame per element. The frame
    // the room sees must be the delta, or a drag of a hundred shapes is a
    // hundred elements a hundred times.
    const seen = new Map();
    const scene = [
      { id: "a", type: "rectangle", version: 1, versionNonce: 1 },
      { id: "b", type: "ellipse", version: 1, versionNonce: 2 },
    ];
    remember(changedElements(scene, seen), seen);

    const moved = [scene[0], { ...scene[1], version: 2, versionNonce: 3 }];
    const delta = changedElements(moved, seen);
    expect(delta.map((one) => one.id)).toEqual(["b"]);

    const atRoom = decodeClientFrame(drawFrame(encodeElements(delta)));
    expect(atRoom.ok).toBe(true);
    expect(decodeElements(atRoom.msg!.d).map((one) => one.id)).toEqual(["b"]);
  });

  test("a pointer on a canvas is two numbers and some ids", () => {
    const accepted = decodeClientFrame(pointerFrame(12.5, -3, ["el1", "el2"]));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("pointer");
    // Nothing else rides along: this is not a second channel for scene data.
    expect(Object.keys(accepted.msg!).sort()).toEqual(["s", "t", "x", "y"]);

    const relayed = decodeServerFrame(
      JSON.stringify({ t: "pointer", id: "m1", x: 12.5, y: -3, s: ["el1"] }),
    );
    expect(relayed).toEqual({ t: "pointer", id: "m1", x: 12.5, y: -3, selected: ["el1"] });
  });

  test("who seeds the document is the room's answer, and it survives the wire", () => {
    /*
      The bug two browsers found and fifty-two green checks did not.

      The client used to decide this itself, by asking whether the roster in
      its own welcome was empty. A welcome's roster always contains the member
      it was sent to — the room seats you before it describes the room — so the
      answer was "somebody is already here" for the very first person, nobody
      ever seeded, and the note's text never entered the shared document.

      So the roster is deliberately non-empty in both frames below. What
      decides is `seed`, and only `seed`.
    */
    const me = { id: "m1", name: "@ana", color: "#3b82f6", a: null, h: null };

    const first = decodeServerFrame(
      JSON.stringify({ t: "welcome", v: 1, you: "m1", members: [me], seed: true }),
    );
    expect(first).not.toBeNull();
    if (first && first.t === "welcome") {
      expect(first.seed).toBe(true);
      expect(first.members.length).toBe(1);
    }

    const second = decodeServerFrame(
      JSON.stringify({ t: "welcome", v: 1, you: "m1", members: [me], seed: false }),
    );
    if (second && second.t === "welcome") expect(second.seed).toBe(false);

    // An older gateway that does not send the field at all reads as "do not
    // seed", which is the safe way to be wrong: an empty editor is recoverable
    // and a note containing itself twice is not.
    const older = decodeServerFrame(
      JSON.stringify({ t: "welcome", v: 1, you: "m1", members: [me] }),
    );
    if (older && older.t === "welcome") expect(older.seed).toBe(false);
  });
});
