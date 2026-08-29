/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **The four `useFileBrowser` guards that nothing held.**
 *
 * Row 117 of the security register: in this console every guard expressed as a
 * pure module is caught by a test (13 of 13) and every guard living inside a
 * hook is not (0 of 8). `#102` and `#106` took the ones that could be moved
 * out. These four cannot be — they are decisions about *when to call the
 * server*, which only exist in the hook — so they get a mounted-hook harness
 * instead, the same one `saveTimeout.test.ts` and `fileErrorCallSites.test.ts`
 * use.
 *
 * The reason to bother, from `#110`: an untested guard is not merely unproven,
 * it is where a wrong constant hides. Testing the share cap turned up an
 * off-by-one it had been carrying since the day it was written.
 *
 * **Every test here asserts on whether an action was CALLED, not on what came
 * back.** That is the anti-vacuity rule row 132 exists for: a guard that
 * refuses and a server that would have refused anyway produce the same visible
 * outcome, so a test that reads the outcome proves nothing about the guard.
 * Each also carries its own positive control — the same call with the guard's
 * condition inverted, which must reach the server.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
/** Every call, in order, so a test can assert on absence as well as presence. */
const calls: { name: string; args: unknown }[] = [];

/**
 * `useAction` and `useMutation` both record; `useQuery` returns undefined.
 *
 * The hook reads `listShares` through `useQuery` as of the share work, and a
 * query that never resolves is the honest stand-in here — every assertion below
 * is about what the console *sends*, and `undefined` is what a real console
 * shows before the subscription lands.
 */
jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const NOTE = "1-projects/note.md";
const FOLDER = "1-projects";
const PRIVACY = "privacy.md";

function entry(path: string, kind: "file" | "folder", readOnly = false) {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [entry(NOTE, "file"), entry(FOLDER, "folder"), entry(PRIVACY, "file", true)],
  truncated: false,
  manifestUsable: true,
};

function openNote(path: string, readOnly: boolean): OpenNote {
  return {
    path,
    text: "# original\n",
    etag: "etag-1",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly,
  };
}

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

function mount(options: { canEdit: boolean; isOwner?: boolean }): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", ...options });
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function called(fn: string): { name: string; args: unknown }[] {
  return calls.filter((c) => c.name === name(fn));
}

describe("the guards that decide whether the server is called at all", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("readNote")] = async (args: never) =>
      openNote((args as { path: string }).path, (args as { path: string }).path === PRIVACY);
    actions[name("writeNote")] = async () => ({
      path: NOTE,
      etag: "etag-2",
      conflictCheck: "conditional",
    });
    actions[name("deleteEntry")] = async () => ({ path: NOTE });
    actions[name("moveEntry")] = async () => ({ path: NOTE });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("a console that cannot edit reaches no mutating action at all", async () => {
    unmount = mount({ canEdit: false });
    await settle();

    await act(async () => {
      browser.destroy(NOTE);
      browser.rename(NOTE, "renamed.md");
    });
    await settle();

    // The interface carries every mutating method on a read-only browser and
    // they are inert — `browser.ts` says so in its own header.
    //
    // **Who is actually behind `canEdit: false` here**, since an earlier
    // version of this comment guessed and guessed wrong: not a landing-page
    // visitor. `useFileBrowser` has exactly one non-test call site
    // (`useLiveConsoleData.ts`), and the marketing console runs
    // `useDemoFileBrowser` instead. It is a signed-in workspace **member**,
    // who does hold a credential — and `deleteEntry` would refuse them at
    // `minimum: "editor"`. So the server backstop exists, and the reason this
    // guard is worth holding is narrower and true: a request that cannot
    // succeed surfaces as "that did not work", which reads as a broken console
    // rather than as a permission they do not have.
    expect(called("deleteEntry")).toHaveLength(0);
    expect(called("moveEntry")).toHaveLength(0);
  });

  test("…and the same calls on an editable console do reach it", async () => {
    // The positive control. Without it the test above passes on a hook that
    // never calls anything, which is exactly how a mocked action goes stale.
    // Both calls, because the test above asserts on both — a control that
    // exercised only `destroy` would leave the `moveEntry` assertion able to
    // rot without anything noticing.
    unmount = mount({ canEdit: true });
    await settle();

    await act(async () => {
      browser.destroy(NOTE);
      browser.rename(NOTE, "renamed.md");
    });
    await settle();
    expect(called("deleteEntry")).toHaveLength(1);
    expect(called("moveEntry")).toHaveLength(1);
  });

  test("the delete confirmation is the literal the backend demands", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    await act(async () => {
      browser.destroy(NOTE);
    });
    await settle();

    // `deleteEntry` refuses anything but this exact string, and the console is
    // the only caller that supplies it, so a typo turns every delete into a
    // refusal the UI reports as "that did not work".
    //
    // **What this pins, exactly**, because the first version of this comment
    // claimed more: it pins the *hook's* literal, and nothing here pins it to
    // the server's. Measured — changing `DELETE_CONFIRMATION` in
    // `functions/lib/fileOps.ts` leaves the whole mobile suite green. The
    // server's own copy is pinned incidentally, by a hardcoded literal in
    // `shareRead.test.ts`, so a one-sided rename does turn CI red — but on an
    // unrelated share test, and a deliberate rename updating both would break
    // the console silently.
    //
    // Importing the server constant here is the obvious fix and does not work:
    // `functions/files.ts` pulls `@convex-dev/auth/server`, which does not
    // resolve under this file's jsdom environment (`consoleVisibility.test.ts`
    // gets away with the same import because it runs under node). Closing it
    // properly means moving the literal somewhere both sides can reach, which
    // is a change to production layout and not this test's to make.
    expect(called("deleteEntry")[0].args).toMatchObject({
      path: NOTE,
      confirmation: "permanently delete",
    });
  });

  test("saving a read-only note never reaches writeNote", async () => {
    unmount = mount({ canEdit: true });
    await settle();

    await act(async () => {
      browser.select(PRIVACY);
    });
    await settle();
    expect(browser.editor.readOnly).toBe(true);

    act(() => browser.setDraft("# rewritten access map\n"));
    await act(async () => {
      browser.save();
    });
    await settle();

    // `privacy.md` is the access map. The server refuses it too — that is the
    // outer layer — but the console must not send it: `writeFile` answers
    // PRIVACY_MANIFEST_READ_ONLY, and an owner watching their own manifest
    // bounce off five layers deep is a worse story than a Save that was never
    // armed.
    expect(called("writeNote")).toHaveLength(0);
  });

  test("…and saving an ordinary note does reach it", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    act(() => browser.setDraft("# edited\n"));
    await act(async () => {
      browser.save();
    });
    await settle();
    expect(called("writeNote")).toHaveLength(1);
  });

  test("selecting a folder does not try to read it as a note", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    const before = called("readNote").length;

    await act(async () => {
      browser.select(FOLDER);
    });
    await settle();

    // A folder has no body. Reading one comes back FILE_NOT_FOUND, so without
    // this the console tells somebody their own folder does not exist every
    // time they click it — and the refusal is indistinguishable from the one a
    // note they may not see produces, which is the shape of an oracle.
    expect(called("readNote")).toHaveLength(before);
    expect(browser.editor.path).toBeNull();
  });

  test("…and selecting a note does read it", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    expect(called("readNote")).toHaveLength(1);
    expect(browser.editor.path).toBe(NOTE);
  });
});
