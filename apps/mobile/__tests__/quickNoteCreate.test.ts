/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { untitledStem } from "../features/console/files/untitled";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A QUICK NOTE OPENS ON THE PRESS, AND ONE LEFT EMPTY IS NEVER SAVED.**
 *
 * Dev2 (2026-10-18): *"the compose button takes more than 5 seconds to open a
 * new note"* and *"make sure that new notes created on mobile but nothing
 * written in it doesn't get saved and is discarded"*.
 *
 * Before this the press waited for the note's create in the bucket (and for
 * the folder's listing when it was not loaded) before anything opened. Now an
 * untitled note opens at once from its seed, with no version and no request,
 * its row drawn in its folder; the first save of something typed is the
 * create. A note left with nothing but its heading is never written and its
 * row goes. The owner's earlier review (2026-10-01) still holds: a second
 * press never gets a refusal about a name nobody chose — a name taken behind
 * the listing's back moves on at the first save (`unsentNotes.ts`).
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   `openUnsent` replaced by the old `createNote` (write first)          8
 *   the blank check in `performSave` removed                            1
 *   `leaveBlankNew` made a no-op                                        3
 *   no `retarget` on a taken name                                       1
 *   the listing awaited before an online note opens                     1
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

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
  return { useAction: record, useMutation: record, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => ({ query: async () => null }) };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const FOLDER = "0-inbox";
const STEM = untitledStem(new Date());
const MADE = `${FOLDER}/${STEM}.md`;
const NEXT = `${FOLDER}/${STEM}-2.md`;

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/** What the bucket holds. */
let files: Map<string, string>;
/** Paths the bucket holds that `listFiles` does not report: a listing behind the bucket. */
let unlisted: Set<string>;

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  const notes = [...files.keys()]
    .filter((key) => !unlisted.has(key))
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map((key) => ({
      kind: "file" as const,
      path: key,
      name: key.slice(prefix.length),
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    }));
  const folders =
    path === ""
      ? [{
          kind: "folder" as const,
          path: FOLDER,
          name: FOLDER,
          visibility: "private" as const,
          inherited: "private" as const,
          exception: false,
          readOnly: false,
        }]
      : [];
  return { path, folderDefault: "private", truncated: false, manifestUsable: true, entries: [...folders, ...notes] };
}

function written(): string[] {
  return calls.filter((c) => c.name === name("writeNote")).map((c) => (c.args as { path: string }).path);
}

function rows(): string[] {
  return (browser.listings[FOLDER]?.entries ?? []).map((one) => one.path);
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
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
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  });
}

/** Mount, and have the inbox listed, as the phone's Home has before anybody presses compose. */
async function ready(): Promise<() => void> {
  const unmount = mount();
  await settle();
  await act(async () => {
    browser.ensureListing(FOLDER);
  });
  await settle();
  expect(browser.listings[FOLDER]).toBeDefined();
  return unmount;
}

function held<T>(): { promise: Promise<T>; release: (value: T) => void; fail: (error: unknown) => void } {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

function taken(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "CONFLICT", message: "A file already exists at that path. Reload to see it." });
}

describe("a quick note", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    files = new Map([["index.md", "# index\n"]]);
    unlisted = new Set();
    actions[name("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[name("readNote")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return {
        path,
        text: files.get(path) ?? "",
        etag: `etag:${path}`,
        visibility: "private",
        inherited: "private",
        exception: false,
        readOnly: false,
      };
    };
    actions[name("writeNote")] = async (args: never) => {
      const { path, text, expectedEtag } = args as { path: string; text: string; expectedEtag?: string };
      if (expectedEtag === undefined && files.has(path)) throw taken();
      files.set(path, text);
      return { kind: "written", path, etag: `etag:${path}:${text.length}`, bytes: text.length, conflictCheck: "conditional", forms: [] };
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("opens on the press, drawn in its folder, with nothing written or read", async () => {
    unmount = await ready();
    calls.length = 0;

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });

    expect(browser.selectedPath).toBe(MADE);
    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.etag).toBeNull();
    expect(browser.editor.draft).toBe(`# ${STEM}\n\n`);
    expect(browser.opening).toBeNull();
    expect(rows()).toContain(MADE);
    expect(calls.filter((c) => c.name === name("writeNote") || c.name === name("readNote"))).toEqual([]);
  });

  test("does not wait for a folder nobody has listed yet", async () => {
    unmount = mount();
    await settle();
    // The inbox's listing never answers: the note must open anyway.
    const real = actions[name("listFiles")]!;
    actions[name("listFiles")] = (args: never) =>
      (args as { path: string }).path === FOLDER ? new Promise(() => {}) : real(args);

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });

    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.etag).toBeNull();
  });

  test("the first save of something typed is the create", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    const text = `# ${STEM}\n\nBuy milk\n`;
    await act(async () => {
      browser.setDraft(text);
    });
    await act(async () => {
      browser.save();
    });
    await settle();

    const write = calls.find((c) => c.name === name("writeNote"))?.args as { path: string; expectedEtag?: string };
    expect(write.path).toBe(MADE);
    // A create: no version, so the server refuses it over a note already there.
    expect(write.expectedEtag).toBeUndefined();
    expect(files.get(MADE)).toBe(text);
    expect(browser.editor.etag).toBe(`etag:${MADE}:${text.length}`);
    expect(rows()).toContain(MADE);
  });

  test("left with nothing written, it is not saved and its row goes", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.deselect();
    });
    await settle();

    expect(written()).toEqual([]);
    expect(files.has(MADE)).toBe(false);
    expect(rows()).not.toContain(MADE);
  });

  test("emptied, even of its heading, it is still not saved", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.setDraft("  \n");
    });
    await act(async () => {
      browser.save();
    });
    await act(async () => {
      browser.select("index.md");
    });
    await settle();

    expect(written()).toEqual([]);
    expect(rows()).not.toContain(MADE);
    expect(browser.editor.path).toBe("index.md");
  });

  test("a second press from an empty one replaces it rather than adding another", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    // One empty note on screen, not two: the first went when the second opened.
    const made = rows().filter((path) => path.includes(STEM));
    expect(made).toHaveLength(1);
    expect(browser.editor.path).toBe(made[0]);
    expect(written()).toEqual([]);
  });

  test("a second press while the first is still being written gets the next name", async () => {
    unmount = await ready();
    const first = held<unknown>();
    const real = actions[name("writeNote")]!;
    actions[name("writeNote")] = (args: never) => first.promise.then(() => real(args));

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.setDraft(`# ${STEM}\n\nFirst\n`);
    });
    // Leaving writes what was typed; the second note is made while that is on its way.
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    expect(browser.editor.path).toBe(NEXT);
    actions[name("writeNote")] = real;
    await act(async () => {
      first.release(undefined);
    });
    await settle();

    expect(written()).toEqual([MADE]);
    expect(files.get(MADE)).toBe(`# ${STEM}\n\nFirst\n`);
    expect(browser.notice).toBeNull();
  });

  test("a name the listing did not know was taken moves on at the first save, not refused", async () => {
    files.set(MADE, "# made on another device\n");
    unlisted.add(MADE);
    unmount = await ready();

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.setDraft(`# ${STEM}\n\nMine\n`);
    });
    await act(async () => {
      browser.save();
    });
    await settle();

    expect(written()).toEqual([MADE, NEXT]);
    expect(browser.notice).toBeNull();
    expect(browser.editor.path).toBe(NEXT);
    expect(browser.selectedPath).toBe(NEXT);
    expect(files.get(MADE)).toBe("# made on another device\n");
    expect(files.get(NEXT)).toBe(`# ${STEM}-2\n\nMine\n`);
    expect(rows()).toContain(NEXT);
  });

  /*
    The server answers a write into a folder this person may not see exactly
    as it answers a missing file. For a note nobody has named yet that read
    as nonsense (the owner's team on a phone, 2026-10-02).
  */
  test("a create refused as missing says the folder is not theirs to add to", async () => {
    unmount = await ready();
    actions[name("writeNote")] = async () => {
      throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
    };

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await act(async () => {
      browser.setDraft(`# ${STEM}\n\nHello\n`);
    });
    await act(async () => {
      browser.save();
    });
    await settle();

    expect(browser.editor.message ?? browser.notice).toBe("You can't add notes to inbox. Pick a folder that is shared with you.");
  });
});
