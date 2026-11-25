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
 * **A NEW SHEET OPENS ON THE PRESS, THE WAY A NEW NOTE DOES.**
 *
 * Dev (2026-11-25): *"when I create a new sheet, it does not open up in the
 * page the way a note does"*. A sheet was written first and opened only from
 * the write's answer, so the page stayed on whatever it showed for a round
 * trip, and a press elsewhere meanwhile left the sheet in the tree unopened.
 * Now it opens at once from its header row, like an untitled note
 * (`unsentNotes.ts`), and is written straight after as the editor's own first
 * save: an empty sheet is still a file, one Tex can be asked to fill.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   `createUntitled` sending a sheet to `createNote` again (write first)   3
 *   the first write sent in the press's tick, not from the effect         1
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
const MADE = `${FOLDER}/${STEM}.csv`;
const NEXT = `${FOLDER}/${STEM}-2.csv`;
const SEED = "name,notes\n";

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

function taken(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "CONFLICT", message: "A file already exists at that path. Reload to see it." });
}

describe("a new sheet", () => {
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

  test("opens on the press, drawn in its folder, before any answer", async () => {
    unmount = await ready();
    calls.length = 0;
    // The create never answers: the sheet must be open anyway.
    actions[name("writeNote")] = () => new Promise(() => {});

    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });

    expect(browser.selectedPath).toBe(MADE);
    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.draft).toBe(SEED);
    expect(browser.opening).toBeNull();
    expect(rows()).toContain(MADE);
    expect(calls.filter((c) => c.name === name("readNote"))).toEqual([]);
  });

  test("does not wait for a folder nobody has listed yet", async () => {
    unmount = mount();
    await settle();
    const real = actions[name("listFiles")]!;
    actions[name("listFiles")] = (args: never) =>
      (args as { path: string }).path === FOLDER ? new Promise(() => {}) : real(args);

    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });

    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.draft).toBe(SEED);
  });

  test("is written at once, behind the open, as a create", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });
    await settle();

    const write = calls.find((c) => c.name === name("writeNote"))?.args as { path: string; expectedEtag?: string };
    expect(write.path).toBe(MADE);
    // A create: no version, so the server refuses it over a sheet already there.
    expect(write.expectedEtag).toBeUndefined();
    expect(files.get(MADE)).toBe(SEED);
    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.etag).toBe(`etag:${MADE}:${SEED.length}`);
  });

  test("an edit made while the create is out goes next, on top of its version", async () => {
    unmount = await ready();
    const real = actions[name("writeNote")]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    actions[name("writeNote")] = async (args: never) => {
      await gate;
      return real(args);
    };
    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });
    const text = "name,notes\nmilk,2 litres\n";
    await act(async () => {
      browser.setDraft(text);
    });
    await act(async () => {
      browser.save();
    });
    await act(async () => {
      release();
    });
    await settle();
    await settle();

    const writes = calls.filter((c) => c.name === name("writeNote")).map((c) => c.args as { path: string; text: string; expectedEtag?: string });
    expect(writes.map((w) => w.path)).toEqual([MADE, MADE]);
    expect(writes[1]!.expectedEtag).toBe(`etag:${MADE}:${SEED.length}`);
    expect(files.get(MADE)).toBe(text);
  });

  test("a name taken behind the listing's back moves on to the next one", async () => {
    files.set(MADE, "a,b\n");
    unlisted.add(MADE);
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });
    await settle();
    await settle();

    expect(files.get(MADE)).toBe("a,b\n");
    expect(files.get(NEXT)).toBe(SEED);
    expect(browser.editor.path).toBe(NEXT);
    expect(browser.selectedPath).toBe(NEXT);
  });

  test("left without an edit, it stays: an empty sheet is still a file", async () => {
    unmount = await ready();
    await act(async () => {
      browser.createUntitled(FOLDER, "sheet");
    });
    await settle();
    await act(async () => {
      browser.select("index.md");
    });
    await settle();

    expect(files.get(MADE)).toBe(SEED);
    expect(rows()).toContain(MADE);
  });
});
