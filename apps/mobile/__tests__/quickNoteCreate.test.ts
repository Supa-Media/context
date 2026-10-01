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
 * **A QUICK NOTE OPENS ONE ROUND TRIP AFTER THE PRESS, AND A SECOND ONE IS
 * NEVER REFUSED.**
 *
 * The owner's review of the phone Home (2026-10-01): *"there is some lag when
 * adding a quick note"* and *"I tried adding another quick note but got a 'A
 * file already exists at that path' error"*. One cause, two symptoms:
 *
 *  - The press waited for **three** round trips in a row before the note was
 *    on screen: the `writeNote`, then a `listFiles` of the folder (`run`'s
 *    refresh), then a `readNote` of the note it had just written (`select`).
 *  - Nothing was drawn until all three were back, so the folder still read as
 *    not having the note. A second press inside that window — the obvious
 *    thing to do when the first one seems not to have worked — picked its
 *    name against that listing, picked the *same* name, and the server's
 *    create refused it. A listing that is simply behind the bucket (another
 *    device made a quick note today) did the same.
 *
 * Now: the row is drawn on the press, the note opens from the write's own
 * answer, and a create refused because the name is taken moves on to the next
 * untitled name rather than surfacing a refusal about a name nobody chose.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   the row not drawn before the write                                  2
 *   opened by `select` (a read) instead of from the write's answer       1
 *   no retry on a taken name                                             1
 *   the drawn row left behind when the write is refused                  1
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
  return { useAction: record, useMutation: record, useQuery: () => undefined };
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

  test("is drawn in its folder on the press, before the bucket answers", async () => {
    unmount = await ready();
    const write = held<unknown>();
    const real = actions[name("writeNote")]!;
    actions[name("writeNote")] = () => write.promise;

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();
    expect(rows()).toContain(MADE);

    actions[name("writeNote")] = real;
  });

  test("a second press while the first is still being written gets the next name", async () => {
    unmount = await ready();
    const first = held<unknown>();
    const real = actions[name("writeNote")]!;
    let n = 0;
    actions[name("writeNote")] = (args: never) => {
      n += 1;
      if (n === 1) return first.promise.then(() => real(args));
      return real(args);
    };

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();
    await act(async () => {
      first.release(undefined);
    });
    await settle();

    expect(written()).toEqual([MADE, NEXT]);
    expect(browser.notice).toBeNull();
    expect(files.has(MADE) && files.has(NEXT)).toBe(true);
  });

  test("a name the listing did not know was taken is skipped, not refused", async () => {
    files.set(MADE, "# made on another device\n");
    unlisted.add(MADE);
    unmount = await ready();

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    expect(written()).toEqual([MADE, NEXT]);
    expect(browser.notice).toBeNull();
    expect(browser.editor.path).toBe(NEXT);
    expect(files.get(MADE)).toBe("# made on another device\n");
    expect(rows()).toContain(NEXT);
  });

  test("opens from the write's own answer, without reading it back or waiting for the list", async () => {
    unmount = await ready();
    // The listing after the write never comes back: the note must not wait for it.
    actions[name("listFiles")] = () => new Promise(() => {});

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    expect(browser.selectedPath).toBe(MADE);
    expect(browser.editor.path).toBe(MADE);
    expect(browser.editor.status).toBe("clean");
    expect(browser.editor.etag).toBe(`etag:${MADE}:${files.get(MADE)!.length}`);
    expect(browser.editor.draft).toBe(files.get(MADE));
    expect(browser.opening).toBeNull();
    expect(calls.filter((c) => c.name === name("readNote"))).toEqual([]);
  });

  test("a refused write takes the drawn row back and opens nothing", async () => {
    unmount = await ready();
    actions[name("writeNote")] = async () => {
      throw new ConvexError({ code: "FORBIDDEN", message: "You cannot write here." });
    };

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    expect(rows()).not.toContain(MADE);
    expect(browser.notice).toBe("You cannot write here.");
    expect(browser.selectedPath).toBeNull();
  });
});
