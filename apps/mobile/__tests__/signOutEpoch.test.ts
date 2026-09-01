/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { OpenNote } from "../features/console/files/types";
import type { OfflineNotes } from "../features/offline/useOfflineNotes";
import type { WriteOutcome } from "../features/offline/sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **The sign-out clear is a barrier, not a moment.**
 *
 * `signOutHygiene.test.ts` presses the real button and asserts the device is
 * empty *at the instant `signOut` is called*. That ordering is real and is kept
 * — but it is only half of what "signing out takes the notes off the device"
 * claims. "Gone before the session ends" and "stays gone" are two statements,
 * and a point-in-time `remove()` loop only makes the first one true.
 *
 * It cannot see the second because it mocks `useLiveConsoleData`, so
 * `useOfflineNotes` never runs and nothing is ever in flight. Everything in that
 * layer that writes is fire-and-forget over an async store: `rememberNote`,
 * `rememberBody`, `rememberListing`, the debounced `rememberDraft`, the
 * debounced queue persist, and `flush` from a drain settling. None of them is
 * cancelled by sign-out, and none of them is cancelled by unmount either —
 * `readNote` and `listFiles` are Convex actions with no client-side timeout, so
 * a read started before the press can land arbitrarily long after it.
 *
 * So the window is: clear runs, session ends, console unmounts — and *then* a
 * read from the previous person's session resolves and puts a **private-tier**
 * note body back into `localStorage`, keyed by workspace and by nothing at all
 * about who read it. The queue is the same shape: a drain settling during
 * `await signOut()` calls `commit(..., true)`, which flushes the queue the
 * person was told had been discarded straight back onto the device.
 *
 * The fix these tests hold is a session epoch — a counter `forgetLocalCopies`
 * bumps *before* it clears, captured once per mount, checked by every writer. A
 * write from a session that has ended is dropped rather than landing in the gap.
 *
 * Each test here therefore does what the clear cannot: it lets the racing work
 * land **after** the clear and asserts on the device afterwards. A test that
 * asserted only at clear time would pass against the code this file was written
 * about.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useOfflineNotes } from "../features/offline/useOfflineNotes";
import { forgetLocalCopies, type ForgetResult } from "../features/offline/forget";
import { endSession } from "../features/offline/epoch";
import * as cache from "../features/offline/cache";
import { ownedKeys } from "../features/offline/keys";
import { openStore } from "../features/offline/store.web";

const WORKSPACE = "w1";
const NOTE_PATH = "1-projects/pay.md";

/** The body that must not be on the device once the session is over. */
const SECRET = "salary numbers, private tier, read by the person signing out";

const NOTE: OpenNote = {
  path: NOTE_PATH,
  text: SECRET,
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/** Every key on the origin, so a leak under any key at all is visible. */
function allKeys(): string[] {
  const found: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) found.push(key);
  }
  return found;
}

function ownedNow(): string[] {
  return ownedKeys(allKeys());
}

/** Everything on the device, as one string. A leak is a substring of this. */
function deviceHolds(): string {
  return allKeys()
    .map((key) => `${key}=${window.localStorage.getItem(key) ?? ""}`)
    // An escape, never the raw byte. `features/offline/keys.ts` makes that rule
    // for the separator it picks and gives the reason: a control character in a
    // source file makes it binary to `grep` and invisible in every diff it
    // appears in. Typed as a byte here it cost exactly that — git reported this
    // file as `Bin 0 -> 17160 bytes`, so 17KB of new test code showed a reviewer
    // nothing, and jest's own failure output came back as "binary file matches"
    // instead of the failing test names.
    .join("\u0000");
}

async function settle(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A promise somebody else decides the moment of. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = async () => ({
    path: "",
    folderDefault: "private",
    entries: [],
    truncated: false,
    manifestUsable: true,
  });
  actions[name("readNote")] = async () => NOTE;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/* -------------------------------------------------------------------------- */

let browser: FileBrowser;

function mountBrowser(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("a read that lands after the session ended", () => {
  test("does not put the note body back on the device", async () => {
    /*
      The reviewer's probe, exactly. `readNote` is held open, the console is
      signed out underneath it, the console is unmounted, and only then does the
      bucket answer. `openNote`'s `offline.rememberNote(note)` is the write; it
      is closed over a store handle that is still perfectly usable, and neither
      the clear nor the unmount has any way to reach it.
    */
    const held = deferred<OpenNote>();
    actions[name("readNote")] = () => held.promise;

    unmount = mountBrowser();
    await settle();

    // The read starts and does not finish.
    act(() => {
      browser.select(NOTE_PATH);
    });
    await settle(1);

    // Sign-out, as the layout performs it: clear, then end the session.
    const verdict = await forgetLocalCopies();
    expect(verdict.verdict).toBe("cleared");
    expect(ownedNow()).toEqual([]);

    // The console goes with the session.
    unmount();
    unmount = null;

    // And now the bucket answers the previous person's read.
    await act(async () => {
      held.resolve(NOTE);
      await held.promise;
    });
    await settle();

    expect(deviceHolds()).not.toContain(SECRET);
    expect(ownedNow()).toEqual([]);
  });

  test("and one that lands *during* the clear is dropped too", async () => {
    /*
      Why the epoch is bumped **before** the removals rather than after, which
      is the half the test above cannot see: it lets the read land after the
      clear has finished, so a bump at either end of the clear would stop it.

      Here the read resolves and the clear starts in the same tick, so the
      continuation that calls `rememberNote` interleaves with the clear's own
      awaits — and lands *after* `forgetEverything` has taken its snapshot of
      what to remove. A bump at the end of the clear therefore arrives too late
      to stop the write and too late to remove it: the note body is on the
      device and the verdict says so. This is the gap the ordering exists for,
      and it is exactly one line of source apart from the version that has it.
    */
    const held = deferred<OpenNote>();
    actions[name("readNote")] = () => held.promise;

    unmount = mountBrowser();
    await settle();

    act(() => {
      browser.select(NOTE_PATH);
    });
    await settle(1);

    let verdict: ForgetResult | null = null;
    await act(async () => {
      // No `await` between these two: the point is that they race.
      held.resolve(NOTE);
      verdict = await forgetLocalCopies();
    });
    await settle();

    expect(deviceHolds()).not.toContain(SECRET);
    expect(verdict!.verdict).toBe("cleared");
  });

  test("and a fresh console after the sign-out caches normally again", async () => {
    /*
      The anti-vacuity witness. An epoch that never re-arms would pass the test
      above by breaking the feature: caching is the whole point of this layer,
      and a barrier that outlives the session it closed would leave every
      subsequent sign-in reading from the bucket forever with nothing kept.
    */
    await forgetLocalCopies();

    unmount = mountBrowser();
    await settle();
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(deviceHolds()).toContain(SECRET);
  });
});

/* -------------------------------------------------------------------------- */

let offline: OfflineNotes;

function mountOffline(write: (pending: { path: string }) => Promise<WriteOutcome>): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    offline = useOfflineNotes({
      workspaceId: WORKSPACE,
      tier: "private",
      write: write as never,
    });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("a drain that settles after the session ended", () => {
  test("does not write the discarded queue back to the device", async () => {
    /*
      The queue half of the same window, and the one the person was explicitly
      warned about: `signOutWarning` tells them the edits are about to stop
      existing, and they pressed "Sign out and discard". A drain in flight
      settles a moment later, `commit(..., true)` flushes, and the queue is back
      on the machine the next person signs in on.

      The write comes back `conflict` so the entry survives the drain — a queue
      that emptied would be removed rather than re-written, which is the one
      outcome that cannot demonstrate this.
    */
    const held = deferred<WriteOutcome>();
    unmount = mountOffline(() => held.promise);
    await settle();

    act(() => {
      offline.queueSave({ path: NOTE_PATH, text: SECRET, baseEtag: "etag-1" });
    });
    // The debounced persist is what puts it on the device in the first place.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(ownedNow().length).toBeGreaterThan(0);

    act(() => {
      offline.drain();
    });
    await settle(1);

    await forgetLocalCopies();
    expect(ownedNow()).toEqual([]);

    unmount();
    unmount = null;

    await act(async () => {
      held.resolve({ kind: "conflict", currentEtag: "etag-2", message: "moved on" });
      await held.promise;
    });
    await settle();

    expect(deviceHolds()).not.toContain(SECRET);
    expect(ownedNow()).toEqual([]);
  });

  test("a debounced draft does not land in the gap either", async () => {
    /*
      `rememberDraft` is trailing-debounced by a second, so the most ordinary
      sequence in the product — type, press sign out — has a timer holding
      somebody's text with nothing between it and the store. The timer is
      cleared on unmount, but sign-out does not unmount anything synchronously
      and the console stays live through `await signOut()`.
    */
    unmount = mountOffline(async () => ({ kind: "failed", message: "unused" }));
    await settle();

    act(() => {
      offline.rememberDraft({
        path: NOTE_PATH,
        text: SECRET,
        baseEtag: "etag-1",
        savedAt: 1,
      });
    });

    await forgetLocalCopies();
    expect(ownedNow()).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    expect(deviceHolds()).not.toContain(SECRET);
    expect(ownedNow()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Each writer against the barrier, one at a time.
 *
 * The tests above go through the whole press and are the ones that show the
 * bug; these are the per-guard witnesses, because the epoch is only worth what
 * its least-guarded writer is worth and a leak through one of them looks
 * identical to a leak through any other from the outside.
 *
 * `endSession()` is called directly rather than through `forgetLocalCopies`, so
 * what is under test is the writer's own check and not the clear that usually
 * runs beside it. `rememberBody` in particular can only be seen this way: after
 * a clear there is no cached note for it to move, so it is a no-op whether it
 * is guarded or not — the case that matters is a clear that left something
 * behind, which is a verdict this module already knows how to return.
 */
describe("every writer drops a write from a session that has ended", () => {
  test("including one whose session ends after its read and before its write", async () => {
    /*
      The test below calls `endSession()` first, so it only ever exercises a
      writer's entry gate. `rememberBody` is the one writer where that is not
      the whole story: it awaits `getNote` and writes in the continuation, so
      the session can end in between — and the entry gate has already passed
      by then.

      Ending it synchronously in the same block is what opens that window
      here: the read resolves in a microtask, so the continuation runs after
      this `act` returns and therefore after the session is over. On a device
      the window is far wider — `AsyncStorage.getItem` is a queued bridge
      call, so the read that started before a sign-out press can resolve well
      after the clear has walked past that key.
    */
    const seeded = { ...NOTE, text: "the version already on the device" };
    await cache.putNote(openStore(), "private", WORKSPACE, seeded, Date.now());

    unmount = mountOffline(async () => ({ kind: "failed", message: "unused" }));
    await settle();

    act(() => {
      offline.rememberBody({ path: NOTE_PATH, text: SECRET, etag: "etag-2" });
      endSession();
    });
    await settle();

    expect(deviceHolds()).not.toContain(SECRET);
  });

  test("the four cache writers, and the queue", async () => {
    const seeded = { ...NOTE, text: "the version already on the device" };
    await cache.putNote(openStore(), "private", WORKSPACE, seeded, Date.now());

    unmount = mountOffline(async () => ({ kind: "failed", message: "unused" }));
    await settle();

    endSession();

    act(() => {
      offline.rememberNote({ ...NOTE, path: "1-projects/other.md" });
      offline.rememberBody({ path: NOTE_PATH, text: SECRET, etag: "etag-2" });
      offline.rememberListing({
        path: "1-projects",
        folderDefault: "private",
        entries: [
          {
            kind: "file",
            path: "1-projects/quiet.md",
            name: "quiet.md",
            visibility: "private",
            inherited: "private",
            exception: false,
            readOnly: false,
          },
        ],
        truncated: false,
        manifestUsable: true,
      });
      offline.rememberDraft({ path: NOTE_PATH, text: SECRET, baseEtag: "etag-1", savedAt: 1 });
      offline.queueSave({ path: NOTE_PATH, text: SECRET, baseEtag: "etag-1" });
    });

    // Past both debounce timers, so nothing is merely still pending.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await settle();

    const held = deviceHolds();
    expect(held).not.toContain(SECRET);
    // The listing is note *names*, which disclose on their own.
    expect(held).not.toContain("quiet.md");
    expect(held).not.toContain("1-projects/other.md");
    // The one record that was already there is untouched, not rewritten: the
    // barrier drops writes, it does not corrupt what the clear will remove.
    expect(held).toContain("the version already on the device");
  });
});

describe("the drain, after the session has ended", () => {
  test("does not send the discarded queue to the bucket", async () => {
    /*
      Not a write to the device, and gated on the same epoch. The console is
      still mounted through `await signOut()`, and the drain effect fires the
      moment a queue and a connection exist — so a reconnection inside that
      window sends the writes the person pressed "discard" on. It is a smaller
      window than the device one and a worse outcome: this reaches the bucket.
    */
    const sent: string[] = [];
    unmount = mountOffline(async (pending) => {
      sent.push(pending.path);
      return { kind: "written", etag: "e2", conflictCheck: "conditional" };
    });
    await settle();

    act(() => {
      offline.queueSave({ path: NOTE_PATH, text: SECRET, baseEtag: "etag-1" });
    });
    await settle();

    endSession();
    act(() => {
      offline.drain();
    });
    await settle();

    expect(sent).toEqual([]);
  });

  test("and it does send while the session is the current one", async () => {
    // Anti-vacuity: a `drain` that never sent anything would pass the test
    // above by turning the whole offline queue off.
    const sent: string[] = [];
    unmount = mountOffline(async (pending) => {
      sent.push(pending.path);
      return { kind: "written", etag: "e2", conflictCheck: "conditional" };
    });
    await settle();

    act(() => {
      offline.queueSave({ path: NOTE_PATH, text: SECRET, baseEtag: "etag-1" });
    });
    await settle();

    act(() => {
      offline.drain();
    });
    await settle();

    expect(sent).toEqual([NOTE_PATH]);
  });
});

