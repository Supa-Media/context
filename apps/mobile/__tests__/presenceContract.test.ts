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
  updateFrame,
} from "../features/console/presence/protocol";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";

describe("what the client sends, the room accepts", () => {
  test("an edit", () => {
    const doc = createSharedDoc({ onLocalUpdate: () => {} });
    let sent = "";
    const watched = createSharedDoc({ onLocalUpdate: (u) => (sent = updateFrame(u)) });
    seedSharedDoc(watched, "a real document");
    watched.text.insert(1, "x");

    const accepted = decodeClientFrame(sent);
    expect(accepted.ok).toBe(true);
    expect(accepted.msg.t).toBe("u");
    void doc;
  });

  test("a snapshot", () => {
    const doc = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(doc, "# A note\n\nwith some words in it\n");
    const accepted = decodeClientFrame(snapshotFrame(doc.snapshot()));
    expect(accepted.ok).toBe(true);
    expect(accepted.msg.t).toBe("snap");
  });

  test("a caret and a heartbeat", () => {
    expect(decodeClientFrame(cursorFrame(3, 9)).ok).toBe(true);
    expect(decodeClientFrame(pingFrame()).ok).toBe(true);
  });

  test("a real keystroke is nowhere near the room's ceiling", () => {
    // If it were, ordinary typing would be refused as oversized and the note
    // would silently stop syncing — a failure with no error anywhere.
    const doc = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(doc, "x".repeat(20_000));
    let sent = "";
    const typed = createSharedDoc({ onLocalUpdate: (u) => (sent = u) });
    seedSharedDoc(typed, "x".repeat(20_000));
    typed.text.insert(10_000, "!");
    expect(new TextEncoder().encode(sent).length).toBeLessThan(MAX_UPDATE_BYTES / 4);
    void doc;
  });
});

describe("what the room sends, the client reads", () => {
  test("a relayed edit round-trips into another document", () => {
    // The actual path: A types, the room relays the frame verbatim, B applies
    // what it decoded. Any disagreement about the field name breaks this.
    const b = createSharedDoc({ onLocalUpdate: () => {} });
    const a = createSharedDoc({
      onLocalUpdate: (u) => {
        // Every frame, in order, the way the room relays them. Relaying only
        // the newest is what the first version of this did, and it failed —
        // correctly: edits are causally ordered, so a client that misses one
        // cannot apply the ones after it. That is a real property worth
        // stating rather than a quirk to write around, and it is why
        // `usePresence` announces a snapshot on every connect.
        const atRoom = decodeClientFrame(updateFrame(u));
        expect(atRoom.ok).toBe(true);
        const atClient = decodeServerFrame(JSON.stringify({ t: "u", d: atRoom.msg.d }));
        expect(atClient).not.toBeNull();
        if (atClient && atClient.t === "u") b.applyRemote(atClient.d);
      },
    });
    seedSharedDoc(a, "shared");
    a.text.insert(6, " text");
    expect(b.markdown()).toBe("shared text");
  });

  test("a client that missed an edit is brought back by a snapshot", () => {
    // What the snapshot-on-connect exists for: B misses a frame, so it cannot
    // apply what comes after it and silently stops updating. The snapshot is
    // what ends that, and without it B stays behind forever.
    const missed: string[] = [];
    const b = createSharedDoc({ onLocalUpdate: () => {} });
    let deliver = false;
    const a = createSharedDoc({
      onLocalUpdate: (u) => {
        if (deliver) b.applyRemote(u);
        else missed.push(u);
      },
    });
    seedSharedDoc(a, "one ");
    deliver = true;
    a.text.insert(a.text.length, "two");

    expect(missed.length).toBeGreaterThan(0);
    expect(b.markdown()).not.toBe(a.markdown());

    b.applyRemote(a.snapshot());
    expect(b.markdown()).toBe(a.markdown());
  });

  test("a replayed log lands a late joiner on the same text", () => {
    // The room stores what it received and replays it in order. This is that
    // journey end to end, through both decoders.
    const log: string[] = [];
    const author = createSharedDoc({
      onLocalUpdate: (u) => {
        const atRoom = decodeClientFrame(updateFrame(u));
        if (atRoom.ok) log.push(atRoom.msg.d);
      },
    });
    seedSharedDoc(author, "# Roadmap\n");
    author.text.insert(author.text.length, "- presence\n");
    author.text.insert(author.text.length, "- merge\n");

    const joiner = createSharedDoc({ onLocalUpdate: () => {} });
    const sync = decodeServerFrame(JSON.stringify({ t: "sync", updates: log }));
    expect(sync).not.toBeNull();
    if (sync && sync.t === "sync") for (const u of sync.updates) joiner.applyRemote(u);

    expect(joiner.markdown()).toBe(author.markdown());
    expect(joiner.markdown()).toContain("- merge");
  });

  test("the room's compaction request is one the client understands", () => {
    expect(decodeServerFrame(JSON.stringify({ t: "compact" }))).toEqual({ t: "compact" });
  });
});
