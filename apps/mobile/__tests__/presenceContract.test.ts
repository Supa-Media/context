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
  agentCursorFrame,
  agentPointerFrame,
  askFrame,
  cursorFrame,
  decodeServerFrame,
  drawFrame,
  drawSnapshotFrame,
  pingFrame,
  pointerFrame,
  savedFrame,
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
  answerStateVector,
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
    /*
      Nothing else rides along: this is not a second channel for scene data.
      `agent` is on the list and is *false* here — the room reads it to decide
      whose pointer this is, and a frame that did not claim to be the tool's
      must never be able to arrive as one by leaving the field off.
    */
    expect(Object.keys(accepted.msg!).sort()).toEqual(["agent", "s", "t", "x", "y"]);
    expect(accepted.msg!.agent).toBe(false);

    const relayed = decodeServerFrame(
      JSON.stringify({ t: "pointer", id: "m1", x: 12.5, y: -3, s: ["el1"] }),
    );
    expect(relayed).toEqual({ t: "pointer", id: "m1", x: 12.5, y: -3, selected: ["el1"] });
  });

  test("an ask can be answered and can never apply, whatever it carries", () => {
    /*
      THE HOLE THIS CLOSES WAS IN THE SEAM, NOT IN ANY ONE DECISION.

      Every call was right on its own: the room leaves `ask` past the write
      gate (asking is a read), the gateway holds no Yjs (the bytes are opaque
      by design), a peer reads a sync message with the protocol's own reader.
      The defect was that the room relayed an `ask` *as a `y`* — and that
      reader chooses between answering and **applying** on a type byte inside
      the payload, which the sender supplies.

      So a read-only member could put an ordinary update on the frame the write
      gate had just waved through, and every peer would apply it and the
      elected writer would flush it to the bucket. Non-negotiable #4 says write
      access is never implied by read.

      ## The attacker is synced first, and that is the whole test

      The first version of this built the forged update from an independently
      seeded document — and Yjs correctly buffered it as depending on history
      the victim had never seen, so the victim's text was unchanged *whatever
      read it*. The refusal was being proved against an inert payload: it would
      have passed a fix that did nothing. (It reported `applied` and changed
      nothing, which is exactly how that hides.)

      A member of a room is not in that position. They hold the document,
      because the room gave it to them — that is what read access is. So the
      attacker is synced from the victim the way joining a room syncs you, and
      the forged bytes are then genuinely applicable. `landsOn` below proves it
      by applying the same bytes through the edit reader and watching the note
      change.
    */
    const victim = createSharedDoc({});
    seedSharedDoc(victim, "somebody's real work");

    /** A client that has joined the room and been handed the document. */
    const joined = (onLocalUpdateBytes?: (bytes: Uint8Array) => void) => {
      const peer = createSharedDoc(onLocalUpdateBytes ? { onLocalUpdateBytes } : {});
      const asked = readSyncMessage(encodeSyncStep1(peer.doc), victim.doc, "remote");
      expect(asked.kind).toBe("reply");
      if (asked.kind === "reply") readSyncMessage(asked.payload, peer.doc, "remote");
      expect(peer.markdown()).toBe("somebody's real work");
      return peer;
    };

    // What a read-only member would smuggle: not a state vector, an edit —
    // made against history they legitimately hold.
    let update: Uint8Array | null = null;
    const attacker = joined((bytes) => {
      update = bytes;
    });
    attacker.text.insert(0, "INJECTED ");
    expect(update).not.toBeNull();
    const smuggled = encodeUpdate(update!);

    // The room would accept this frame — asking needs no write authority.
    expect(decodeClientFrame(askFrame(smuggled)).ok).toBe(true);

    /*
      Non-vacuity, and the reason this test is worth anything: the same bytes,
      read as an edit, *do* rewrite the note. Against a second client in the
      same room, so the victim itself is left for the refusal below.
    */
    const landsOn = joined();
    readSyncMessage(smuggled, landsOn.doc, "remote");
    expect(landsOn.markdown()).toBe("INJECTED somebody's real work");

    // And the reader on the ask frame refuses to apply them. The *text* is
    // asserted first on purpose: that is the property, and a reader that
    // reports the wrong outcome while leaving the note alone is a smaller
    // problem than one that reports the right outcome and rewrites it.
    const outcome = answerStateVector(smuggled, victim.doc);
    expect(victim.markdown()).toBe("somebody's real work");
    expect(outcome.kind).toBe("ignored");

    // The other half: a genuine question is still answered, so a read-only
    // member can still sync. A refusal that refused everything would pass the
    // check above and break the feature.
    const empty = createSharedDoc({});
    const answer = answerStateVector(encodeSyncStep1(empty.doc), victim.doc);
    expect(answer.kind).toBe("reply");
    if (answer.kind === "reply") {
      readSyncMessage(answer.payload, empty.doc, "remote");
      expect(empty.markdown()).toBe("somebody's real work");
    }
  });

  test("a save announces a version, and the version is what comes back", () => {
    /*
      The console saves through the control plane rather than through the
      gateway's `write_note`, so this frame is the room's only way to learn the
      bucket moved. Both halves are checked across the seam, because the frame
      a client builds and the frame the room sends back are different shapes
      and a rename of either is invisible to one side's suite.
    */
    const accepted = decodeClientFrame(savedFrame("abc123"));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("saved");
    // An etag and nothing else: this is not a second channel for note text.
    expect(Object.keys(accepted.msg!).sort()).toEqual(["t", "v"]);

    expect(decodeServerFrame(JSON.stringify({ t: "etag", v: "abc123" }))).toEqual({
      t: "etag",
      etag: "abc123",
    });
    // Absent or empty is not a version, and adopting one would point the next
    // conditional write at nothing.
    expect(decodeServerFrame(JSON.stringify({ t: "etag", v: "" }))).toBeNull();
    expect(decodeServerFrame(JSON.stringify({ t: "etag" }))).toBeNull();
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

  /*
    A TOOL'S CARET IS REPORTED BY A CLIENT AND NAMED BY THE ROOM.

    A tool holds no socket, so somebody has to say where its caret went, and
    the only party that knows is the client the room asked to merge its write.
    That client says **that** the caret is the tool's; it must never be able to
    say **which** member any caret belongs to, or presence stops being a
    server-vouched identity and becomes a claim — which is the spoof `admit`
    exists to prevent, arriving through the back door.

    The boolean is the whole security argument, so it is asserted from both
    sides: the client cannot put an id on the frame, and the room reads the
    flag it actually sent.
  */
  test("a caret reported on the tool's behalf carries a flag and no id", () => {
    const accepted = decodeClientFrame(agentCursorFrame("QUJD", "QUJE"));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("cursor");
    expect(accepted.msg!.agent).toBe(true);
    // No `id`, and no room for one: the field the room stamps is not on the
    // list of fields a client can fill in.
    expect(Object.keys(accepted.msg!).sort()).toEqual(["a", "agent", "h", "t"]);
  });

  test("a client's own caret is not the tool's, and cannot become one", () => {
    // The ordinary caret frame reads as `agent: false`, so the room's branch
    // is taken only by a frame that asked for it.
    expect(decodeClientFrame(cursorFrame("QUJD", "QUJD")).msg!.agent).toBe(false);
    // And a client that puts something *truthy* there is still not the tool:
    // the gateway compares against `true` and nothing else.
    for (const forged of ["true", 1, {}, ["yes"]]) {
      const sneaky = decodeClientFrame(JSON.stringify({ t: "cursor", a: null, h: null, agent: forged }));
      expect([JSON.stringify(forged), sneaky.msg!.agent]).toEqual([JSON.stringify(forged), false]);
    }
  });

  test("a pointer reported on the tool's behalf is the same bargain", () => {
    const accepted = decodeClientFrame(agentPointerFrame(110, -4.5));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg?.t).toBe("pointer");
    expect([accepted.msg!.agent, accepted.msg!.x, accepted.msg!.y]).toEqual([true, 110, -4.5]);
    expect(Object.keys(accepted.msg!).sort()).toEqual(["agent", "s", "t", "x", "y"]);
  });

  test("the roster tells a tool apart from a colleague", () => {
    /*
      `g` on the wire, `isAgent` in the app. A person watching their note
      change should be able to tell which of the carets in it is not a
      colleague — and the flag is the room's, never a name a client asserted.

      Absent reads as a person, which is the safe way to be wrong: a tool drawn
      as a colleague is a cosmetic error, and a colleague drawn as a tool is
      the app telling somebody their teammate is a robot.
    */
    const tool = { id: "a:9f", name: "Some Client", color: "#3b82f6", a: null, h: null, w: false, g: true };
    const person = { id: "m1", name: "@ana", color: "#3b82f6", a: null, h: null, w: true };

    const joined = decodeServerFrame(JSON.stringify({ t: "join", member: tool }));
    expect(joined).not.toBeNull();
    if (joined && joined.t === "join") {
      expect(joined.member.isAgent).toBe(true);
      // And never elected to save: it has no socket to accept an edit from.
      expect(joined.member.canWrite).toBe(false);
    }

    const welcome = decodeServerFrame(
      JSON.stringify({ t: "welcome", v: 1, you: "m1", members: [person, tool], seed: false }),
    );
    if (welcome && welcome.t === "welcome") {
      expect(welcome.members.map((one) => one.isAgent)).toEqual([false, true]);
    }

    // Truthy is not `true`, here as everywhere else on this wire.
    const fuzzy = decodeServerFrame(JSON.stringify({ t: "join", member: { ...tool, g: "yes" } }));
    if (fuzzy && fuzzy.t === "join") expect(fuzzy.member.isAgent).toBe(false);
  });
});
