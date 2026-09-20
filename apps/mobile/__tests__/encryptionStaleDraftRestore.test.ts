/**
 * @jest-environment jsdom
 */

/**
 * AN ENCRYPTED NOTE NEVER RESTORES A STALE LOCAL DRAFT — REGARDLESS OF WHERE
 * IT CAME FROM.
 *
 * `encryptionLockDiscardsDraft.test.ts` closes the leak for the device that
 * actually performs a lock: `BrowsePane`'s onLock success handler discards
 * the draft and the queue for the path it just locked. That call reaches only
 * *this* device's copy of `features/offline`'s store. It cannot reach:
 *
 *  - a **different browser tab on the same device**, which shares the same
 *    `localStorage` but may have its own React state mid-edit and re-persist
 *    a debounced draft moments after this device's discard runs, and
 *  - a **different device entirely** (a phone, another laptop), whose local
 *    store this device can never see or clear.
 *
 * Both are named in the task as cases that "can leave plaintext behind" —
 * and they do, in storage, on that other tab or device, until it opens the
 * note and this file's guard runs there. What this file proves is the half
 * that *is* closable from any single device: whichever device is first to
 * reopen a note that has since become encrypted refuses to show that stale
 * plaintext, and purges its own copy of it right then, rather than restoring
 * it into the editor as "unsaved changes" over a note the console is telling
 * the same person is locked.
 *
 * Without this, `restoreFor` — which has no idea a note is encrypted, and
 * compares only text and etags — would see a plaintext draft that does not
 * equal the ciphertext envelope, at an etag the lock has always moved past,
 * and restore it as a **conflict**: the pre-lock plaintext, in a plain
 * editable buffer, with "Load theirs" / "Keep mine" controls over a note
 * whose whole promise is that nobody — including this console — can read it
 * without the passphrase. `NoteEditor`'s own `isPassphraseNote(state.draft)`
 * check would then read that plaintext instead of an envelope and render the
 * ordinary editor instead of `LockedNoteView`, compounding the leak with a
 * false "readable through a connected client" notice underneath it.
 *
 * Sabotage record (temporary local edit, reverted): removing the
 * `note.encrypted` guard in `useFileBrowser.ts`'s `openNote` — 3 failures,
 * naming the three tests below that plaintext leaks into.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const actions: Record<string, (args: never) => Promise<unknown>> = {};
// A stable reference per function name — not just per call. `useFileBrowser`
// closes several `useCallback`s over the actions this returns; a mock that
// handed back a fresh arrow function on every render would make every one of
// those look like a changed dependency on every render, which is exactly the
// shape of an infinite render loop rather than a slow test.
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const fnName = getFunctionName(ref);
      bound[fnName] ??= (args: never) => actions[fnName]!(args);
      return bound[fnName];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import * as cache from "../features/offline/cache";
import { emptyOutbox, enqueue } from "../features/offline/outbox";
import { openStore } from "../features/offline/store.web";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function name(fn: string): string {
  return `functions/files:${fn}`;
}

async function settle(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const WORKSPACE = "w1";
const PATH = "1-projects/secret.md";
const PRE_LOCK_PLAINTEXT = "the paragraph nobody but me should ever read again";
/** A stand-in for a real envelope — its exact shape does not matter here,
 * only that it is not, and never becomes, `PRE_LOCK_PLAINTEXT`. */
const ENVELOPE = [
  "---",
  "context_encryption: v1",
  "---",
  "",
  "> [!NOTE] This note is encrypted.",
  "",
  "```context-encrypted",
  '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA","aad":"context-note-v1:w1","recipients":[{"kind":"passphrase","id":"p1","alg":"A256GCM","iv":"BBBBBBBBBBBBBBBB","wrapped":"CCCC","kdf":{"id":"argon2id","v":19,"m":19456,"t":2,"p":1,"salt":"DDDDDDDDDDDDDDDD"}}]}',
  "```",
  "",
].join("\n");

function listingFor(path: string): FolderListing {
  return { path, folderDefault: "private", entries: [], truncated: false, manifestUsable: true };
}

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

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = (async () => listingFor("1-projects")) as (
    args: never,
  ) => Promise<unknown>;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/** Seed exactly what an un-cleared pre-lock draft (or queue entry) leaves
 * behind — the shape either another tab's debounce write, or a device this
 * one never talked to, would have left on this `localStorage`. */
async function seedStaleDraft(): Promise<void> {
  const seeded = openStore();
  await cache.putDraft(seeded, WORKSPACE, {
    path: PATH,
    text: PRE_LOCK_PLAINTEXT,
    baseEtag: "pre-lock-etag",
    savedAt: 1,
  });
}

async function seedStaleQueue(): Promise<void> {
  const seeded = openStore();
  await cache.putOutbox(
    seeded,
    enqueue(emptyOutbox(WORKSPACE), {
      path: PATH,
      text: PRE_LOCK_PLAINTEXT,
      baseEtag: "pre-lock-etag",
      now: 1,
    }),
  );
}

const ENCRYPTED_NOTE: OpenNote = {
  path: PATH,
  text: ENVELOPE,
  etag: "post-lock-etag",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
  encrypted: true,
};

describe("opening a note that is now encrypted, with a stale local draft", () => {
  test("does not restore the pre-lock plaintext into the editor", async () => {
    await seedStaleDraft();
    actions[name("readNote")] = (async () => ENCRYPTED_NOTE) as (args: never) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();

    expect(browser.editor.draft).not.toContain(PRE_LOCK_PLAINTEXT);
    expect(browser.editor.draft).toBe(ENVELOPE);
    // Not shown as an unsaved conflict over a locked note — the ordinary
    // editor's own baseline for "nothing to resolve".
    expect(browser.editor.status).not.toBe("conflict");
    expect(browser.editor.status).not.toBe("dirty");
    expect(browser.editor.encrypted).toBe(true);
  });

  test("purges the stale draft from durable storage the first time it notices", async () => {
    await seedStaleDraft();
    actions[name("readNote")] = (async () => ENCRYPTED_NOTE) as (args: never) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();

    const after = openStore();
    expect(await cache.getDraft(after, WORKSPACE, PATH)).toBeNull();
  });

  test("purges a stale queued write too, rather than leaving it to be refused later", async () => {
    await seedStaleQueue();
    actions[name("readNote")] = (async () => ENCRYPTED_NOTE) as (args: never) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();

    const after = openStore();
    expect((await cache.getOutbox(after, WORKSPACE)).writes).toHaveLength(0);
  });
});

describe("the same guard leaves an unencrypted note's draft alone", () => {
  /** Anti-vacuity: a guard that discarded every draft regardless of
   * `encrypted` would pass every test above and delete the ordinary draft
   * feature `encryptionLockDiscardsDraft.test.ts` already covers — this is
   * the other half, kept here because it is the same code path branching. */
  test("an ordinary note's stale draft still restores and still survives", async () => {
    const plainNote: OpenNote = {
      path: PATH,
      text: "old body",
      etag: "pre-lock-etag",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
      encrypted: false,
    };
    await seedStaleDraft();
    actions[name("readNote")] = (async () => plainNote) as (args: never) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();

    expect(browser.editor.draft).toBe(PRE_LOCK_PLAINTEXT);
    expect(browser.editor.status).toBe("dirty");

    const after = openStore();
    expect(await cache.getDraft(after, WORKSPACE, PATH)).not.toBeNull();
  });
});

describe("a live notification that another console encrypted the open note", () => {
  test("cancels autosave, clears plaintext immediately, and reopens the ciphertext", async () => {
    let reads = 0;
    let releaseEncrypted!: (note: OpenNote) => void;
    const encryptedRead = new Promise<OpenNote>((resolve) => { releaseEncrypted = resolve; });
    const plainNote: OpenNote = {
      path: PATH,
      text: "old body",
      etag: "pre-lock-etag",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
      encrypted: false,
    };
    actions[name("readNote")] = (async () => {
      reads += 1;
      return reads === 1 ? plainNote : await encryptedRead;
    }) as (args: never) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => browser.select(PATH));
    await settle();
    act(() => browser.setDraft(PRE_LOCK_PLAINTEXT));

    act(() => browser.encryptedElsewhere(PATH));
    expect(browser.editor.path).toBeNull();
    expect(browser.editor.draft).toBe("");
    expect(browser.flushAutosave(PATH)).toBe(false);

    await act(async () => releaseEncrypted(ENCRYPTED_NOTE));
    await settle();
    expect(browser.editor.path).toBe(PATH);
    expect(browser.editor.draft).toBe(ENVELOPE);
    expect(browser.editor.encrypted).toBe(true);
  });

  test("an in-flight plaintext save cannot repopulate local state after the notification", async () => {
    const plainNote: OpenNote = {
      path: PATH,
      text: "old body",
      etag: "pre-lock-etag",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
      encrypted: false,
    };
    let reads = 0;
    actions[name("readNote")] = (async () => {
      reads += 1;
      return reads === 1 ? plainNote : ENCRYPTED_NOTE;
    }) as (args: never) => Promise<unknown>;
    let rejectSave!: (error: Error) => void;
    actions[name("writeNote")] = (() => new Promise((_, reject) => { rejectSave = reject; })) as (
      args: never,
    ) => Promise<unknown>;

    unmount = mountBrowser();
    await settle();
    act(() => browser.select(PATH));
    await settle();
    act(() => browser.setDraft(PRE_LOCK_PLAINTEXT));
    act(() => browser.save());
    expect(browser.editor.status).toBe("saving");

    act(() => browser.encryptedElsewhere(PATH));
    await settle();
    expect(browser.editor.encrypted).toBe(true);
    await act(async () => rejectSave(new Error("encrypted note refuses plaintext")));
    await settle();

    expect(browser.editor.draft).toBe(ENVELOPE);
    expect(browser.editor.status).toBe("clean");
    expect(await cache.getDraft(openStore(), WORKSPACE, PATH)).toBeNull();
    expect((await cache.getOutbox(openStore(), WORKSPACE)).writes).toHaveLength(0);
  });
});
