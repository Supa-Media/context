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
 * **The disclosure guard, at the places that actually render.**
 *
 * `fileErrorDisclosure.test.ts` holds `toFileError` itself. This holds its
 * *callers*, and the two are not the same guarantee — which is the whole point
 * of the file.
 *
 * A well-tested pure module beside an unheld call site is worse than the
 * inline version, because it manufactures the appearance of coverage: the
 * green suite says the decision is held, and the screen never consults it.
 * Measured rather than assumed here — with `toFileError` extracted and its own
 * four tests passing, replacing one call site with
 * `String((error as { message?: unknown })?.message ?? error)` failed **zero**
 * tests out of 1500.
 *
 * So each test below mounts the real `useFileBrowser` against an action that
 * throws a raw `Error` carrying a storage marker, and asserts on the copy the
 * pane would render. Five call sites reach a person:
 *
 *  - the root listing load (`notice`);
 *  - `select` → `readNote` (`notice`);
 *  - `run`, the funnel every mutating operation goes through (`notice`);
 *  - `save` → `writeNote` (`editor.message`, via `saveFailed`);
 *  - `useTheirs` → `readNote` (`notice`).
 *
 * The sixth is `refresh`'s `FILE_NOT_FOUND` classification, which decides
 * whether a listing is dropped rather than what is shown; it is asserted
 * separately at the bottom because a raw object that merely *claims* that code
 * must not be believed either.
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
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import { useFileBrowser } from "../features/console/files/useFileBrowser";

/**
 * What an adapter throw can carry, and what must never be on the screen.
 *
 * Not invented for the test: the far side of these actions is a
 * customer-configured S3-compatible endpoint reached with a decrypted
 * credential, so a rejection out of `fetch` or the provider can hold the host,
 * the bucket, and a query string with a signature in it.
 */
const MARKER = "s3.example.invalid/bucket-9f3?X-Amz-Signature=deadbeef";
const GENERIC = "That did not work. Try again.";

const NOTE_PATH = "note.md";
const ROOT_NOTE = "renamed.md";

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: NOTE_PATH,
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

const OPEN_NOTE: OpenNote = {
  path: NOTE_PATH,
  text: "# note\n\noriginal\n",
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Assert on whatever copy a call site produced. */
function expectSafe(shown: string | null | undefined) {
  expect(shown).toBeTruthy();
  expect(shown).not.toContain("example.invalid");
  expect(shown).not.toContain("X-Amz-Signature");
  expect(shown).not.toContain("bucket-9f3");
  expect(shown).toBe(GENERIC);
}

describe("a raw storage failure at each call site that renders", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    actions[name("listFiles")] = async () => ROOT_LISTING;
    actions[name("readNote")] = async () => OPEN_NOTE;
    actions[name("writeNote")] = async () => {
      throw new Error(MARKER);
    };
    actions[name("moveEntry")] = async () => {
      throw new Error(MARKER);
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("the root listing load", async () => {
    actions[name("listFiles")] = async () => {
      throw new Error(MARKER);
    };
    unmount = mount();
    await settle();
    expectSafe(browser.notice);
  });

  test("opening a note", async () => {
    unmount = mount();
    await settle();
    actions[name("readNote")] = async () => {
      throw new Error(MARKER);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    expectSafe(browser.notice);
  });

  test("a mutating operation, which is every toolbar action", async () => {
    unmount = mount();
    await settle();
    await act(async () => {
      browser.rename(NOTE_PATH, "renamed.md");
    });
    await settle();
    expectSafe(browser.notice);
  });

  test("saving a note, which reports through the editor rather than the notice", async () => {
    unmount = mount();
    await settle();
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    act(() => browser.setDraft("# note\n\nedited\n"));
    await act(async () => {
      browser.save();
    });
    await settle();
    expect(browser.editor.status).toBe("error");
    expectSafe(browser.editor.message);
  });

  test("taking the server's version after a conflict", async () => {
    unmount = mount();
    await settle();
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    actions[name("readNote")] = async () => {
      throw new Error(MARKER);
    };
    await act(async () => {
      browser.useTheirs();
    });
    await settle();
    expectSafe(browser.notice);
  });

  test("a plain object claiming FILE_NOT_FOUND does not silently drop a listing", async () => {
    // `refresh` reads the *code* rather than the message, and that read goes
    // through the same funnel for the same reason: an unwrapped object is not
    // something the server produced, so believing its `code` would let a
    // rejection out of the transport decide that somebody's folder is gone.
    unmount = mount();
    await settle();
    expect(browser.listings[""]).toBeDefined();

    let refreshAttempted = false;
    actions[name("listFiles")] = async () => {
      refreshAttempted = true;
      throw { code: "FILE_NOT_FOUND", message: MARKER };
    };
    // A rename refreshes the folders it touched; the refresh is what throws.
    actions[name("moveEntry")] = async () => ({ path: ROOT_NOTE });
    await act(async () => {
      browser.rename(NOTE_PATH, "renamed.md");
    });
    await settle();
    // Without this the test asserts nothing: a refresh that never ran leaves
    // the listing in place for the most boring possible reason.
    expect(refreshAttempted).toBe(true);

    // Not dropped — "we could not look" is not "it does not exist".
    expect(browser.listings[""]).toBeDefined();
    expect(browser.notice ?? "").not.toContain("example.invalid");
  });
});
