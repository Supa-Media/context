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
  cursorFrame,
  decodeServerFrame,
  pingFrame,
  snapshotFrame,
  syncFrame,
} from "../features/console/presence/protocol";
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
    const accepted = decodeClientFrame(syncFrame(encodeSyncStep1(doc.doc)));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg.t).toBe("y");
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
    expect(accepted.msg.t).toBe("y");
  });

  test("a snapshot", () => {
    const doc = createSharedDoc({});
    seedSharedDoc(doc, "# A note\n\nwith some words in it\n");
    const accepted = decodeClientFrame(snapshotFrame(doc.snapshot()));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg.t).toBe("snap");
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
      const atClient = decodeServerFrame(JSON.stringify({ t: "y", d: atRoom.msg.d }));
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
        if (atRoom.ok) log.push(atRoom.msg.d);
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
});
