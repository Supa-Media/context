/**
 * @jest-environment jsdom
 */

/**
 * LOCKING A NOTE DISCARDS EVERY LOCAL COPY OF ITS PRE-LOCK PLAINTEXT.
 *
 * The residual from the adversarial review of #352: password-encrypting a
 * note wrote a real envelope over the bucket and left a plaintext copy of
 * whatever was unsaved sitting in `features/offline`'s durable draft store —
 * the same device, the same session, a note the console now calls "locked",
 * with its pre-lock plaintext still readable outside the envelope that was
 * supposed to be the only copy left. `useNoteEncryption.ts`'s own header
 * states the rule the *locking module* holds — it never touches
 * `features/offline` — but nothing on the *caller's* side ever cleared what
 * was there from before the lock. This file is the fix and the neighbours the
 * same reasoning reaches.
 *
 * Three things, in three `describe` blocks:
 *
 *  1. `BrowsePane`'s onLock success handler now calls the new
 *     `FileBrowser.discardLocalCopies`, and only on success — a failed lock must
 *     leave the draft exactly where it was, because the note is still
 *     plaintext and the person's typing is the only copy of it.
 *  2. `discardLocalCopies` itself reaches the *durable* store, not just an
 *     in-memory queue — proved across a reload (a fresh `openStore()` over
 *     the same `localStorage`, not a second read off the same object), for
 *     all three of the things that hold this note's plaintext: the draft, a
 *     queued offline write, and the **cached body**. The third was the leak
 *     the adversarial review of this change measured by enumerating the store
 *     rather than by asking it for the two keys it expected, and it is why
 *     this method is not called `discardDraft`.
 *  3. None of this touches the *ordinary* draft path: a plain note's draft
 *     still survives a reload, and opening it still restores it.
 *
 * `encryptionStaleDraftRestore.test.ts` is the sibling: what happens when a
 * *different* device or tab is the one holding the stale copy, which this
 * device's own discard can never reach directly.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: require("node:crypto").webcrypto,
    configurable: true,
  });
}

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

/**
 * `BrowsePane` has nowhere for a test to inject `useNoteEncryption`'s
 * `derive` parameter — unlike `useNoteEncryption.test.ts`, which calls the
 * hook directly, this file mounts the real console component, and the real
 * component always wants the real KDF. Real Argon2id at the shipped
 * parameters is about a second of arithmetic (`docs/decisions/encryption.md`,
 * "The KDF, per client") — correct for a person locking one note, and a tax
 * this suite has no reason to pay twice over, so `derivePassphraseKey` alone
 * is swapped for the same trivial stand-in `useNoteEncryption.test.ts` uses.
 * Everything else in the module — `newKdfDescriptor`, `kdfSupport` — stays
 * real, so the dialog's own runtime-support check is still the genuine one.
 */
jest.mock("../features/console/encryption/kdf", () => {
  const actual = jest.requireActual("../features/console/encryption/kdf") as object;
  return {
    ...actual,
    derivePassphraseKey: (passphrase: string) => {
      const key = new Uint8Array(32);
      for (let i = 0; i < passphrase.length; i += 1) {
        key[i % 32] = (key[i % 32]! + passphrase.charCodeAt(i) * (i + 1)) % 256;
      }
      return key;
    },
  };
});

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

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";
import { useFileBrowser } from "../features/console/files/useFileBrowser";
import * as cache from "../features/offline/cache";
import { emptyOutbox, enqueue } from "../features/offline/outbox";
import { openStore } from "../features/offline/store.web";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/* -------------------------------------------------------------------------- */
/*                    part 1: BrowsePane's onLock handler                     */
/* -------------------------------------------------------------------------- */

function pointerWidth(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const NOTE = "1-projects/plan.md";
const PLAINTEXT = "the paragraph nobody but me should ever read again";

const LISTING: FolderListing = {
  path: "1-projects",
  folderDefault: "team",
  entries: [
    {
      kind: "file",
      path: NOTE,
      name: "plan.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function dataWith(files: Partial<FileBrowser>): ConsoleData {
  const base = {
    canEdit: true,
    contextId: "w1",
    loading: false,
    busy: false,
    listings: { "": LISTING },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: NOTE,
    opening: null,
    select: () => true,
    editor: { ...emptyEditor, status: "clean", path: NOTE, baseline: PLAINTEXT, draft: PLAINTEXT, etag: "e0" },
    setDraft: () => {},
    save: () => {},
    discardLocalCopies: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    copyTo: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
    resetPrivacy: () => {},
    canResetPrivacy: false,
    canSetVisibility: true,
    canShare: true,
    shares: [],
    share: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    ...files,
  } as unknown as FileBrowser;

  return {
    loading: false,
    contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    storage: { status: "connected" },
    files: base,
    members: { rows: [], invitations: [] },
  } as unknown as ConsoleData;
}

function mount(data: ConsoleData): HTMLElement {
  pointerWidth();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(BrowsePane, { data }));
  });
  return container;
}

function press(scope: ParentNode, testID: string): void {
  const node = scope.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no element with testID ${testID}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function pressLabel(label: string): void {
  const node = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (node === null) throw new Error(`no control labelled ${label}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function type(label: string, value: string): void {
  const field = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (field === null) throw new Error(`no field labelled ${label}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Fills and submits `LockNoteDialog` with a passphrase that clears every bar. */
function lockWith(passphrase: string): void {
  press(document.body, "browse-share");
  press(document.body, "share-lock-note");
  type("Passphrase", passphrase);
  type("Passphrase again", passphrase);
  type("Type I understand to confirm", "I understand");
  pressLabel("Lock this note");
}

describe("BrowsePane's onLock handler", () => {
  beforeEach(() => {
    actions[name("writeNote")] = (async (args: { path: string; text: string }) => {
      writeCalls.push(args);
      return { etag: "e1", conflictCheck: "conditional" };
    }) as (args: never) => Promise<unknown>;
  });

  let writeCalls: { path: string; text: string }[];
  beforeEach(() => {
    writeCalls = [];
  });

  test("discards the draft, and only after the lock actually succeeds", async () => {
    const calls: string[] = [];
    const discardLocalCopies = jest.fn((path: string) => calls.push(`discard:${path}`));
    const select = jest.fn((path: string) => {
      calls.push(`select:${path}`);
      return true;
    });

    mount(dataWith({ discardLocalCopies, select }));
    lockWith("a genuinely long passphrase");
    await settle();

    expect(writeCalls).toHaveLength(1);
    expect(discardLocalCopies).toHaveBeenCalledTimes(1);
    expect(discardLocalCopies).toHaveBeenCalledWith(NOTE);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(NOTE);
    // Discard before reopening — the note this session just wrote is what a
    // reopen recomputes `editor.encrypted` from; nothing about `openNote`'s
    // own guard makes that ordering matter (it purges an encrypted note's
    // stale local copy either way), but the caller that actually knows a
    // *lock*, not a mere reopen, happened is this one, and it should not
    // depend on that second guard to get the sequencing right.
    expect(calls).toEqual([`discard:${NOTE}`, `select:${NOTE}`]);
  });

  test("never discards a draft over a lock that failed", async () => {
    actions[name("writeNote")] = (async () => {
      throw new ConvexError({ code: "UNKNOWN", message: "the bucket refused this write" });
    }) as (args: never) => Promise<unknown>;

    const discardLocalCopies = jest.fn();
    const select = jest.fn(() => true);

    const container = mount(dataWith({ discardLocalCopies, select }));
    lockWith("a genuinely long passphrase");
    await settle();

    expect(discardLocalCopies).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    // And the person is told, rather than left to wonder whether it worked.
    expect(container.ownerDocument.body.textContent).toContain("the bucket refused this write");
  });
});

/* -------------------------------------------------------------------------- */
/*         part 2: discardLocalCopies reaches the durable store, not just RAM       */
/* -------------------------------------------------------------------------- */

const WORKSPACE = "w1";
const PATH = "1-projects/secret.md";

function openNote(path: string, text: string, etag: string, encrypted = false): OpenNote {
  return {
    path,
    text,
    etag,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    encrypted,
  };
}

function folderListing(path: string, entries: OpenNote[] = []): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: entries.map((note) => ({
      kind: "file",
      path: note.path,
      name: note.path.split("/").pop()!,
      visibility: note.visibility,
      inherited: note.inherited,
      exception: note.exception,
      readOnly: note.readOnly,
    })),
    truncated: false,
    manifestUsable: true,
  };
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

let unmountBrowser: (() => void) | null = null;

describe("discardLocalCopies, against the real offline layer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    actions[name("listFiles")] = async () => folderListing("1-projects");
    actions[name("readNote")] = async () => {
      throw new Error("offline in this suite — reads go to the cache");
    };
  });

  afterEach(() => {
    unmountBrowser?.();
    unmountBrowser = null;
  });

  test("a draft and a queued write for the same path both survive in storage until discardLocalCopies runs, and neither comes back after", async () => {
    const seeded = openStore();
    await cache.putDraft(seeded, WORKSPACE, {
      path: PATH,
      text: PLAINTEXT,
      baseEtag: "e0",
      savedAt: 1,
    });
    await cache.putOutbox(
      seeded,
      enqueue(emptyOutbox(WORKSPACE), { path: PATH, text: PLAINTEXT, baseEtag: "e0", now: 1 }),
    );

    // Sanity: what a reload sees before anything runs — proves the fixture,
    // not the fix, so a failure lower down cannot be blamed on an empty seed.
    const before = openStore();
    expect(await cache.getDraft(before, WORKSPACE, PATH)).not.toBeNull();
    expect((await cache.getOutbox(before, WORKSPACE)).writes).toHaveLength(1);

    unmountBrowser = mountBrowser();
    await settle();
    act(() => {
      browser.discardLocalCopies(PATH);
    });
    await settle();

    // Not the same store handle `discardLocalCopies` wrote through, and not the
    // hook's own in-memory state — a fresh open of the same `localStorage`,
    // which is what a reload actually re-reads.
    const after = openStore();
    expect(await cache.getDraft(after, WORKSPACE, PATH)).toBeNull();
    expect((await cache.getOutbox(after, WORKSPACE)).writes).toHaveLength(0);
  });

  /*
    The store is enumerated rather than probed key by key. Three of the four
    kinds `keys.ts` defines held this note's plaintext at some point in the
    sequence below, and the one this file originally checked — the draft — was
    the only one anybody had looked for. A test that asks
    `getDraft(...) === null` cannot see the other two; a test that reads every
    value in `localStorage` and greps it can, and is the only shape of this
    assertion that keeps working when a fifth kind is added.
  */
  function plaintextHolders(): string[] {
    const found: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)!;
      if ((window.localStorage.getItem(key) ?? "").includes(PLAINTEXT)) {
        // Rendered readable: the separator is a control character, so a
        // failure message would otherwise print keys that look identical.
        found.push(key.replace(/\u001f/g, "|"));
      }
    }
    return found;
  }

  test("the cached body goes too — a reopen that never lands cannot serve the pre-lock plaintext back", async () => {
    /*
      The leak the adversarial review of this PR measured, and the reason
      `discardDraft` became `discardLocalCopies`.

      Opening a note caches its body (`rememberNote`), so the plaintext is in
      `localStorage` under a *third* key before the lock — not the draft, not
      the queue. Dropping only the first two left the fix resting on the
      reopen `BrowsePane` makes after a lock overwriting that record with the
      envelope. It does, right up until the read that reopen makes fails: the
      connection drops, the tab is closed, the app is killed. What stays then
      is the pre-lock plaintext, it survives every reload, and `openNote`'s own
      encrypted guard never fires on it because a copy taken before the lock
      says `encrypted: false`.

      So the reopen here fails on purpose, which is the only version of this
      sequence that can tell the fix from the coincidence.
    */
    actions[name("readNote")] = async () => openNote(PATH, PLAINTEXT, "e0");
    actions[name("listFiles")] = async () =>
      folderListing("1-projects", [openNote(PATH, PLAINTEXT, "e0")]);

    unmountBrowser = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();
    expect(browser.editor.path).toBe(PATH);

    // The fixture, before the fix can be credited with anything: the body is
    // on the device, under a key nothing in this file used to look at.
    expect(plaintextHolders()).toEqual([
      `context.lc.offline|v2|note|private|${WORKSPACE}|${PATH}`,
    ]);

    // The lock lands on the bucket; the reopen it triggers does not.
    actions[name("readNote")] = async () => {
      throw new Error("the connection went while this was reopening");
    };
    act(() => {
      browser.discardLocalCopies(PATH);
    });
    act(() => {
      browser.select(PATH);
    });
    await settle();

    expect(plaintextHolders()).toEqual([]);
    // And across a reload, which is the whole point of it being durable.
    const after = openStore();
    expect(await cache.getNote(after, "private", WORKSPACE, PATH)).toBeNull();
    expect(await cache.getNote(after, "team", WORKSPACE, PATH)).toBeNull();
  });

  test("a copy filed under a clearance this session cannot even read goes too", async () => {
    /*
      `putNote` keys a copy by the clearance that read it and `getNote` widens
      (`readableAt`), so clearing only "the one this session would read" leaves
      a copy no read from this session can see — and the direction that matters
      is the one where the leftover is *plaintext*. Seeded at `team` while the
      session below reads at `private`.
    */
    const seeded = openStore();
    /*
      Stamped now, not at a fixed `1`, and that is not tidiness: the first
      mount runs `sweep`, `MAX_AGE_MS` is thirty days, and a record stamped in
      1970 is deleted by the sweep before the call under test runs. Written
      that way first, this test passed with the fix removed — which is the
      whole of what `docs/decisions/testing.md` means by a guard nobody has
      checked. The assertion below the mount is the other half of the same
      lesson.
    */
    await cache.putNote(seeded, "team", WORKSPACE, openNote(PATH, PLAINTEXT, "e0"), Date.now());

    unmountBrowser = mountBrowser();
    await settle();
    expect(await cache.getNote(openStore(), "team", WORKSPACE, PATH)).not.toBeNull();
    act(() => {
      browser.discardLocalCopies(PATH);
    });
    await settle();

    expect(await cache.getNote(openStore(), "team", WORKSPACE, PATH)).toBeNull();
  });

  test("discardLocalCopies leaves a different path's draft and queued write alone", async () => {
    const other = "1-projects/unrelated.md";
    const seeded = openStore();
    await cache.putDraft(seeded, WORKSPACE, { path: PATH, text: PLAINTEXT, baseEtag: "e0", savedAt: 1 });
    await cache.putDraft(seeded, WORKSPACE, { path: other, text: "keep me", baseEtag: "e0", savedAt: 1 });
    await cache.putOutbox(
      seeded,
      enqueue(
        enqueue(emptyOutbox(WORKSPACE), { path: PATH, text: PLAINTEXT, baseEtag: "e0", now: 1 }),
        { path: other, text: "keep me too", baseEtag: "e0", now: 1 },
      ),
    );

    unmountBrowser = mountBrowser();
    await settle();
    act(() => {
      browser.discardLocalCopies(PATH);
    });
    await settle();

    const after = openStore();
    expect(await cache.getDraft(after, WORKSPACE, PATH)).toBeNull();
    expect(await cache.getDraft(after, WORKSPACE, other)).not.toBeNull();
    const outbox = await cache.getOutbox(after, WORKSPACE);
    expect(outbox.writes.map((w) => w.path)).toEqual([other]);
  });
});

/* -------------------------------------------------------------------------- */
/*             part 3: none of this touches the ordinary draft                */
/* -------------------------------------------------------------------------- */

describe("an ordinary (unencrypted) note's draft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    actions[name("listFiles")] = async () => folderListing("1-projects", [openNote(PATH, "old body", "e0")]);
    actions[name("readNote")] = async () => openNote(PATH, "old body", "e0");
  });

  afterEach(() => {
    unmountBrowser?.();
    unmountBrowser = null;
  });

  test("survives a reload and is restored as unsaved changes on reopen", async () => {
    const seeded = openStore();
    await cache.putDraft(seeded, WORKSPACE, {
      path: PATH,
      text: "typed and never saved",
      baseEtag: "e0",
      savedAt: 1,
    });

    unmountBrowser = mountBrowser();
    await settle();
    act(() => {
      browser.select(PATH);
    });
    await settle();

    expect(browser.editor.status).toBe("dirty");
    expect(browser.editor.draft).toBe("typed and never saved");

    // Reopening does not consume it — `restoreFor` only ever *reads* the
    // draft; only a save or an explicit discard clears it. Reload again and
    // it is still there.
    const after = openStore();
    expect(await cache.getDraft(after, WORKSPACE, PATH)).not.toBeNull();
  });
});
