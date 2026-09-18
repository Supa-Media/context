/**
 * A COLD START WITH NO NETWORK IS THE CASE THIS WHOLE FEATURE WAS BUILT FOR.
 *
 * `features/offline` holds a note cache, drafts, a write queue and a conflict
 * resolver, and until this landed none of them were reachable unless the app
 * was *already running* with the context list *already loaded*. Both facts come
 * from `listMyWorkspaces`, a Convex subscription, so a relaunch on a train
 * produced: `(app)/_layout` waiting forever on `isLoading`, and — if it had got
 * past that — `visibilityTierForRole` answering `unknown`, which makes
 * `useOfflineNotes` refuse to serve a single cached byte.
 *
 * This file is the proof of the fix and, more importantly, of its **bounds**.
 * The dangerous version of this feature is one that serves a memory when it
 * could have had an answer, or serves one to somebody who signed out. So the
 * three conditions in `useRememberedContexts` each get a test, and the sweep,
 * purge and sign-out rules each get one, because a remembered row that outlives
 * a departure is a context named on a device its owner was removed from.
 *
 * **Sabotage record** (temporary local edits, reverted):
 *
 *  - Dropping the `reachability !== "offline"` guard in
 *    `useRememberedContexts` — 1 failure, "waits for an answer it can still
 *    get".
 *  - Making `isOwnTyping` answer `true` for `context` — 3 failures: the
 *    predicate itself, the departed purge, and the sweep. The sweep was the
 *    interesting one: it caught nothing until the assertion moved off
 *    `recallContexts` and onto the key, for the reason written above it.
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  MAX_AGE_MS,
  MAX_ENTRIES,
  forgetDeparted,
  forgetEverything,
  forgetWorkspace,
  putNote,
  recallContexts,
  rememberContexts,
  sweep,
  waitingOnDevice,
  type RememberedContext,
} from "../features/offline/cache";
import { isOwnTyping, keyFor, parseKey } from "../features/offline/keys";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import type { OpenNote } from "../features/console/files/types";

const WS = "ws_one";
const OTHER = "ws_two";

function row(overrides: Partial<RememberedContext> = {}): RememberedContext {
  return {
    workspaceId: WS,
    slug: "acme",
    displayName: "Acme",
    kind: "shared",
    role: "owner",
    ...overrides,
  };
}

function note(path: string): OpenNote {
  return { path, text: "body", etag: "e1" } as OpenNote;
}

let store: KeyValueStore;
beforeEach(() => {
  store = memoryStore();
});

describe("what is written down, and what is not", () => {
  test("a context round-trips with every field the console needs to boot", async () => {
    const full = row({
      meetingsFolder: "3-resources/meetings",
      structureTemplate: "para",
      pinned: true,
    });
    await rememberContexts(store, [full], 1_000);

    expect(await recallContexts(store, { now: 2_000 })).toEqual([full]);
  });

  /**
   * The rule that keeps this file inside non-negotiable #1. A remembered row is
   * identifiers and labels — the same class of thing `lastPlace` already holds
   * — and note text, etags and credentials each live somewhere that is not
   * here. A regression would most plausibly arrive as "just cache the note
   * bodies alongside it, they are right there", which is what `putNote` is
   * for and what its clearance-scoped key exists to govern.
   */
  test("nothing a context row holds is note content", async () => {
    await rememberContexts(store, [row()], 1_000);
    const [key] = (await store.keys()).filter((k) => parseKey(k)?.kind === "context");
    const raw = (await store.get(key!)) ?? "";

    expect(raw).not.toContain("body");
    expect(raw).not.toContain("etag");
    for (const field of Object.keys(JSON.parse(raw).value as object)) {
      expect([
        "workspaceId",
        "slug",
        "displayName",
        "kind",
        "role",
        "meetingsFolder",
        "structureTemplate",
        "pinned",
      ]).toContain(field);
    }
  });

  test("a record written in a shape this version cannot read is absent, not half-read", async () => {
    await store.set(
      keyFor("context", WS),
      JSON.stringify({ value: { workspaceId: WS, slug: 42 }, cachedAt: 1_000 }),
    );

    expect(await recallContexts(store, { now: 1_000 })).toEqual([]);
  });

  test("a record that is not JSON at all is absent rather than a throw", async () => {
    await store.set(keyFor("context", WS), "{not json");

    await expect(recallContexts(store, { now: 1_000 })).resolves.toEqual([]);
  });

  test("rememberContexts does not prune — the purge that owns that runs separately", async () => {
    await rememberContexts(store, [row(), row({ workspaceId: OTHER, slug: "beta" })], 1_000);
    await rememberContexts(store, [row()], 2_000);

    expect((await recallContexts(store, { now: 2_000 })).map((c) => c.workspaceId).sort()).toEqual([
      WS,
      OTHER,
    ]);
  });
});

describe("the bounds a remembered row lives under", () => {
  test("it expires on the same age bound as a cached note", async () => {
    await rememberContexts(store, [row()], 1_000);

    expect(await recallContexts(store, { now: 1_000 + MAX_AGE_MS })).toEqual([row()]);
    expect(await recallContexts(store, { now: 1_000 + MAX_AGE_MS + 1 })).toEqual([]);
  });

  /**
   * Asserted on the **key**, not through `recallContexts`.
   *
   * Written the obvious way — sweep, then recall, then expect nothing — this
   * passed whether or not the sweep touched the row at all, because the reader
   * applies the same age bound on the way out. The bytes would have stayed on
   * the device and the test would have said they were gone, which is the exact
   * shape of false green the age bound exists to prevent.
   */
  test("the sweep takes an expired row off the device", async () => {
    await rememberContexts(store, [row()], 1_000);
    const held = async () => (await store.keys()).filter((k) => parseKey(k)?.kind === "context");
    expect(await held()).toHaveLength(1);

    await sweep(store, { now: 1_000 + MAX_AGE_MS + 1 });

    expect(await held()).toHaveLength(0);
  });

  /**
   * The count bound is about note bodies filling a 5MB bucket, so a context row
   * must not be evictable by it: losing one to make room for a note would cost
   * the boot the rest of this feature now depends on, invisibly, to reclaim a
   * few hundred bytes.
   */
  test("the count bound evicts notes and never a context row", async () => {
    await rememberContexts(store, [row()], 1_000);
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      await putNote(store, "private", WS, note(`1-projects/n${i}.md`), 1_000 + i);
    }

    const { removed } = await sweep(store, { now: 2_000 });

    expect(removed).toBe(5);
    expect(await recallContexts(store, { now: 2_000 })).toEqual([row()]);
  });

  /**
   * The sign-out warning counts everything on the device a person typed, so a
   * new key kind that it miscounts is a dialog saying "you have unsent work"
   * to somebody who has none — and the answer to that dialog is a button that
   * throws away the queue. It is not counted because `waitingOnDevice` falls
   * through anything that is neither a `draft` nor an `outbox`, which is worth
   * a test rather than a reading of the control flow.
   */
  test("a remembered row is not counted as unsent work at sign-out", async () => {
    await rememberContexts(store, [row(), row({ workspaceId: OTHER, slug: "beta" })], 1_000);

    expect(await waitingOnDevice(store, null)).toEqual({
      pending: 0,
      conflicted: 0,
      rejected: 0,
    });
  });

  test("a context row is not somebody's typing, and a draft still is", () => {
    expect(isOwnTyping("context")).toBe(false);
    expect(isOwnTyping("draft")).toBe(true);
    expect(isOwnTyping("outbox")).toBe(true);
  });
});

describe("a row never outlives the reach it describes", () => {
  test("leaving a context takes its row with its notes", async () => {
    await rememberContexts(store, [row(), row({ workspaceId: OTHER, slug: "beta" })], 1_000);

    await forgetWorkspace(store, WS);

    expect((await recallContexts(store, { now: 1_000 })).map((c) => c.workspaceId)).toEqual([OTHER]);
  });

  /**
   * The ending this device never sees: removed by an owner, a shared context
   * deleted, a grant revoked. Before `isOwnTyping` existed the purge was
   * spelled "scoped kinds only", which would have taken the notes and left the
   * row — a context still named on the rail of somebody who cannot reach it.
   */
  test("a membership that ended elsewhere takes the row too", async () => {
    await rememberContexts(store, [row(), row({ workspaceId: OTHER, slug: "beta" })], 1_000);
    await putNote(store, "private", OTHER, note("1-projects/a.md"), 1_000);

    await forgetDeparted(store, [WS]);

    expect((await recallContexts(store, { now: 1_000 })).map((c) => c.workspaceId)).toEqual([WS]);
  });

  test("a draft in a departed context is still not taken", async () => {
    await store.set(keyFor("draft", OTHER, "1-projects/a.md"), JSON.stringify({ text: "typed" }));

    await forgetDeparted(store, [WS]);

    expect(await store.get(keyFor("draft", OTHER, "1-projects/a.md"))).not.toBeNull();
  });

  /**
   * The security property the boot gate rests on: the *presence* of a row is
   * the evidence that a session got far enough to write one, so a sign-out has
   * to destroy it. Without this, `resolveProtectedRoute` would render the app
   * offline for somebody who signed out on this device.
   */
  test("sign-out takes every row", async () => {
    await rememberContexts(store, [row(), row({ workspaceId: OTHER, slug: "beta" })], 1_000);

    await forgetEverything(store);

    expect(await recallContexts(store, { now: 1_000 })).toEqual([]);
  });
});
