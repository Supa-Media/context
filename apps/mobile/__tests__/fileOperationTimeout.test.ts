/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A file operation that never comes back must not lock the toolbar.
 *
 * ## The trap
 *
 * `useFileBrowser.run()` is the wrapper behind rename, move, duplicate,
 * archive, delete, paste and every visibility change. It sets `busy`, awaits a
 * Convex **action**, and clears `busy` when that action settles — and
 * `ConvexReactClient.action()` has no client-side timeout, so the promise
 * settles only when the socket replies. Drop the connection mid-operation and
 * it never does.
 *
 * `busy` is what disables the whole toolbar. So the person is left with a
 * console they cannot act on and no way back but a reload. It is the same
 * defect as the note save (`saveTimeout.test.ts`) and the storage connect
 * (`connectTimeout.test.ts`), one screen over.
 *
 * ## The second bug in the same wrapper
 *
 * `run` used to await the mutation and the listing refresh inside one `try`, so
 * a rename that **succeeded** and then failed to reload its folder was reported
 * as "That did not work. Try again." — and the retry that invited then failed
 * on the duplicate name the first attempt had already created. Success and
 * stale-listing are opposite facts and are now reported as such.
 *
 * ## Why this mounts the hook
 *
 * The timer lives in `useFileBrowser`, between `setBusy(true)` and the action.
 * Nothing pure can reach it. This mounts the real hook against actions the test
 * controls, runs the clock forward, and asserts on `busy` and `notice` — the
 * two things the toolbar is drawn from.
 */

/** `useAction` returns a stable function per query reference; the mock must too. */
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
    /**
     * Sharing is not what these tests are about, and both hooks are inert here
     * — but `useFileBrowser` calls them unconditionally, so a mock that omits
     * them fails at the call rather than at an assertion. `useQuery` returns
     * `undefined`, which is what a real "skip" returns and what the browser
     * treats as "not loaded".
     */
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import {
  OPERATION_TIMEOUT_MS,
  useFileBrowser,
} from "../features/console/files/useFileBrowser";

const NOTE_PATH = "note.md";
const OTHER_PATH = "other.md";

function listing(names: readonly string[]): FolderListing {
  return {
    path: "",
    folderDefault: "private",
    entries: names.map((name) => ({
      kind: "file" as const,
      path: name,
      name,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

function note(path: string): OpenNote {
  return {
    path,
    text: `# ${path}\n`,
    etag: "etag-1",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

/** Mount the hook and keep the latest `FileBrowser` in `browser`. */
function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", canEdit: true });
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

/** Let pending promise callbacks run without advancing the fake clock. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe("a file operation that never comes back", () => {
  let unmount: () => void;
  /** Resolvers for the operation in flight, so a test can decide what happens. */
  let pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null;
  /** How many times the listing has been refetched, and whether it should fail. */
  let listCalls: number;
  let listFails: boolean;

  beforeEach(async () => {
    jest.useFakeTimers();
    pending = null;
    listCalls = 0;
    listFails = false;

    actions[name("listFiles")] = async () => {
      listCalls += 1;
      if (listFails) {
        throw new ConvexError({
          code: "STORAGE_UNREACHABLE",
          message: "Your bucket did not answer.",
        });
      }
      return listing([NOTE_PATH, OTHER_PATH]);
    };
    actions[name("readNote")] = async (args: never) =>
      note((args as { path: string }).path);
    actions[name("duplicateEntry")] = () =>
      new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    actions[name("moveEntry")] = () =>
      new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });

    unmount = mount();
    await settle();
    expect(browser.listings[""]).toBeDefined();
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test("disables the whole toolbar while it is in flight — the state that must not be permanent", () => {
    act(() => browser.duplicate(NOTE_PATH));
    // `busy` is the single flag every toolbar control is disabled from. With no
    // timeout there was nothing that could ever turn it back off.
    expect(browser.busy).toBe(true);
  });

  test("times out, gives the toolbar back, and does not claim it failed", async () => {
    act(() => browser.duplicate(NOTE_PATH));
    expect(browser.busy).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(OPERATION_TIMEOUT_MS);
    });
    await settle();

    expect(browser.busy).toBe(false);
    // Honest about not knowing: the request may have landed and only the answer
    // was lost, so "try again" would be an invitation to create a duplicate.
    expect(browser.notice).toMatch(/stopped waiting/);
    expect(browser.notice).not.toMatch(/That did not work/);
    // And the person really can act again.
    act(() => browser.duplicate(OTHER_PATH));
    expect(browser.busy).toBe(true);
  });

  test("a reply that lands after we stopped waiting cannot disturb the next operation", async () => {
    act(() => browser.duplicate(NOTE_PATH));
    const abandoned = pending!;

    await act(async () => {
      jest.advanceTimersByTime(OPERATION_TIMEOUT_MS);
    });
    await settle();
    expect(browser.busy).toBe(false);

    // The person moves on and archives something else, successfully.
    act(() => browser.duplicate(OTHER_PATH));
    act(() => pending!.resolve({ to: "other copy.md" }));
    await settle();
    expect(browser.busy).toBe(false);
    expect(browser.notice).toBeNull();

    // Now the first operation finally answers, a minute late.
    act(() => abandoned.resolve({ to: "note copy.md" }));
    await settle();

    // It owns nothing any more: no notice of its own, no busy flag.
    expect(browser.busy).toBe(false);
    expect(browser.notice).toBeNull();
  });

  test("an operation that answers in time is unaffected, and its timer cannot fire later", async () => {
    act(() => browser.duplicate(NOTE_PATH));
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    act(() => pending!.resolve({ to: "note copy.md" }));
    await settle();

    expect(browser.busy).toBe(false);
    expect(browser.notice).toBeNull();
    expect(listCalls).toBeGreaterThan(1);

    // The timer it cancelled must not fire later and put a timeout message on
    // an operation that already succeeded.
    await act(async () => {
      jest.advanceTimersByTime(OPERATION_TIMEOUT_MS * 2);
    });
    expect(browser.busy).toBe(false);
    expect(browser.notice).toBeNull();
  });

  test("a real failure is still reported as a failure", async () => {
    act(() => browser.duplicate(NOTE_PATH));
    act(() =>
      pending!.reject(
        new ConvexError({ code: "FILE_EXISTS", message: "There is already a copy." }),
      ),
    );
    await settle();

    expect(browser.busy).toBe(false);
    expect(browser.notice).toBe("There is already a copy.");
  });
});

describe("a file operation that worked but whose listing did not reload", () => {
  let unmount: () => void;
  let listFails: boolean;

  beforeEach(async () => {
    jest.useFakeTimers();
    listFails = false;

    actions[name("listFiles")] = async () => {
      if (listFails) {
        throw new ConvexError({
          code: "STORAGE_UNREACHABLE",
          message: "Your bucket did not answer.",
        });
      }
      return listing([NOTE_PATH, OTHER_PATH]);
    };
    actions[name("readNote")] = async (args: never) =>
      note((args as { path: string }).path);
    actions[name("duplicateEntry")] = async () => ({ to: "note copy.md" });
    actions[name("moveEntry")] = async () => ({});

    unmount = mount();
    await settle();
    expect(browser.listings[""]).toBeDefined();
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test("is not reported to the person as a failure", async () => {
    listFails = true;
    act(() => browser.duplicate(NOTE_PATH));
    await settle();

    expect(browser.busy).toBe(false);
    // The old wrapper awaited the mutation and the refresh in one `try`, so
    // this said "That did not work. Try again." about a copy that exists.
    expect(browser.notice).not.toMatch(/That did not work/);
    expect(browser.notice).toMatch(/did not reload/);
  });

  test("still counts as a success to the caller, so the rename follows the file", async () => {
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    expect(browser.selectedPath).toBe(NOTE_PATH);

    listFails = true;
    act(() => browser.rename(NOTE_PATH, "renamed.md"));
    await settle();

    // `rename` re-selects the new path only when `run` reports success. Told
    // the rename failed, the console would sit on a path that no longer exists
    // and invite a retry that collides with the name it just created.
    expect(browser.selectedPath).toBe("renamed.md");
  });
});
