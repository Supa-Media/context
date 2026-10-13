/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A local title edit made during an earlier automatic move must still name the file. */

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

const FOLDER = "1-projects";
const ROADMAP = `${FOLDER}/Roadmap.md`;
const DAILY = `${FOLDER}/2026-09-12.md`;

function fn(name: string): string {
  return `functions/files:${name}`;
}

let files: Map<string, string>;

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  const entries = [...files.keys()]
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
      ? [
          {
            kind: "folder" as unknown as "file",
            path: FOLDER,
            name: FOLDER,
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ]
      : [];
  return { path, folderDefault: "private", truncated: false, manifestUsable: true, entries: [...entries, ...folders] };
}

function read(path: string): OpenNote {
  return {
    path,
    text: files.get(path) ?? "",
    etag: `etag:${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
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

function moves(): { from: string; to: string }[] {
  return calls
    .filter((c) => c.name === fn("moveEntry"))
    .map((c) => {
      const { from, to } = c.args as { from: string; to: string };
      return { from, to };
    });
}

async function open(path: string) {
  await act(async () => {
    browser.toggleFolder(FOLDER);
  });
  await settle();
  await act(async () => {
    browser.select(path);
  });
  await settle();
}

async function type(text: string) {
  await act(async () => {
    browser.setDraft(text);
  });
  await act(async () => {
    browser.save();
  });
  await settle();
}

async function caret(inTitle: boolean) {
  await act(async () => {
    browser.setTitleCaret!(inTitle);
  });
  await settle();
}

describe("a note whose title is its name", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    files = new Map([
      [ROADMAP, "# Roadmap\n\nBody.\n"],
      [DAILY, "# Friday\n\nBody.\n"],
      [`${FOLDER}/Taken.md`, "# Taken\n"],
    ]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("writeNote")] = async (args: never) => {
      const { path, text } = args as { path: string; text: string };
      files.set(path, text);
      return { path, etag: `etag:${path}:${text.length}`, conflictCheck: "conditional" };
    };
    actions[fn("moveEntry")] = async (args: never) => {
      const { from, to } = args as { from: string; to: string };
      const text = files.get(from);
      files.delete(from);
      if (text !== undefined) files.set(to, text);
      return { path: to };
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    jest.useRealTimers();
  });

  test("a locally edited title during an automatic rename eventually becomes the filename", async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const realMove = actions[fn("moveEntry")]!;
    let first = true;
    actions[fn("moveEntry")] = (args: never) => {
      if (!first) return realMove(args);
      first = false;
      return new Promise(resolve => {
        release = () => { void realMove(args).then(resolve); };
      });
    };
    unmount = mount(); await settle(); await open(ROADMAP);
    await caret(true);
    await type("# Q4 plan\n\nBody.\n");
    await caret(false);
    expect(moves()).toEqual([{ from: ROADMAP, to: `${FOLDER}/Q4 plan.md` }]);
    await caret(true);
    await act(async () => browser.setDraft("# Q4 plan verified\n\nBody.\n"));
    await settle();
    await caret(false);
    await act(async () => release()); await settle();
    await act(async () => { jest.advanceTimersByTime(2_500); }); await settle();
    await act(async () => { jest.advanceTimersByTime(2_500); }); await settle();
    expect(browser.editor.draft).toBe("# Q4 plan verified\n\nBody.\n");
    expect(browser.editor.path).toBe(`${FOLDER}/Q4 plan verified.md`);
    expect(files.has(`${FOLDER}/Q4 plan.md`)).toBe(false);
  });
  test.each([[false, false, false], [true, false, false], [false, true, false], [true, true, false], [false, false, true], [true, false, true], [false, true, true], [true, true, true]])("outside-caret title is not adopted (local: %s, leave: %s, refusal: %s)", async (afterLocalEdit, navigateAway, refused) => {
    jest.useFakeTimers();
    let release!: () => void;
    const realMove = actions[fn("moveEntry")]!;
    let first = true;
    actions[fn("moveEntry")] = (args: never) => {
      if (!first) return realMove(args);
      first = false;
      return new Promise((resolve, reject) => { release = () => { if (refused) reject(new Error("Refused")); else void realMove(args).then(resolve); }; });
    };
    unmount = mount(); await settle(); await open(ROADMAP);
    await caret(true); await type("# Q4 plan\n\nBody.\n"); await caret(false);
    if (afterLocalEdit) {
      await caret(true);
      await act(async () => browser.setDraft("# Q4 plan local\n\nBody.\n")); await settle();
      await caret(false);
    }
    // Remote content updates do not report this person's title caret.
    await act(async () => browser.setDraft("# Collaborator title\n\nBody.\n")); await settle();
    if (navigateAway) { await act(async () => browser.select(DAILY)); await settle(); }
    await act(async () => release()); await settle();
    await act(async () => { jest.advanceTimersByTime(2_500); }); await settle();
    if (!navigateAway) expect(browser.editor.draft).toBe("# Collaborator title\n\nBody.\n");
    expect(browser.editor.path).toBe(navigateAway ? DAILY : refused ? ROADMAP : `${FOLDER}/Q4 plan.md`);
    expect(moves()).toEqual([{ from: ROADMAP, to: `${FOLDER}/Q4 plan.md` }]);
  });

  test.each([false, true])("a newer title follows the settled rename after navigating away (first refused: %s)", async refused => {
    jest.useFakeTimers();
    let release!: () => void;
    const realMove = actions[fn("moveEntry")]!;
    let first = true;
    actions[fn("moveEntry")] = (args: never) => {
      if (!first) return realMove(args);
      first = false;
      return new Promise((resolve, reject) => {
        release = () => {
          if (refused) reject(new Error("First rename refused"));
          else void realMove(args).then(resolve);
        };
      });
    };
    unmount = mount(); await settle(); await open(ROADMAP);
    await caret(true); await type("# Q4 plan\n\nBody.\n"); await caret(false);
    await caret(true);
    await act(async () => browser.setDraft("# Q4 plan verified\n\nBody.\n")); await settle();
    await caret(false);
    await act(async () => browser.select(DAILY)); await settle();
    await act(async () => release()); await settle();
    await act(async () => { jest.advanceTimersByTime(2_500); }); await settle();
    expect(browser.editor.path).toBe(DAILY);
    expect(files.get(`${FOLDER}/Q4 plan verified.md`)).toContain("# Q4 plan verified");
    expect(moves()[1]?.from).toBe(refused ? ROADMAP : `${FOLDER}/Q4 plan.md`);
  });

  test("leaving and unmounting cancels debt waiting on the first rename", async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const realMove = actions[fn("moveEntry")]!;
    actions[fn("moveEntry")] = (args: never) => new Promise(resolve => {
      release = () => { void realMove(args).then(resolve); };
    });
    unmount = mount(); await settle(); await open(ROADMAP);
    await caret(true); await type("# Q4 plan\n\nBody.\n"); await caret(false);
    await caret(true);
    await act(async () => browser.setDraft("# Q4 plan verified\n\nBody.\n")); await settle();
    await caret(false);
    await act(async () => browser.select(DAILY)); await settle();
    const readsBefore = calls.filter(call => call.name === fn("readNote")).length;
    unmount(); unmount = null; await settle();
    await act(async () => release()); await settle();
    await act(async () => { jest.advanceTimersByTime(60_000); }); await settle();
    expect(calls.filter(call => call.name === fn("readNote"))).toHaveLength(readsBefore);
    expect(moves()).toHaveLength(1);
  });

  test.each([false, true])("reopening the source reclaims pending debt (new title local: %s)", async local => {
    jest.useFakeTimers();
    let release!: () => void;
    const realMove = actions[fn("moveEntry")]!;
    let first = true;
    actions[fn("moveEntry")] = (args: never) => {
      if (!first) return realMove(args);
      first = false;
      return new Promise(resolve => { release = () => { void realMove(args).then(resolve); }; });
    };
    unmount = mount(); await settle(); await open(ROADMAP);
    await caret(true); await type("# Q4 plan\n\nBody.\n"); await caret(false);
    await caret(true);
    await act(async () => browser.setDraft("# Q4 plan verified\n\nBody.\n")); await settle();
    await caret(false);
    await act(async () => browser.select(DAILY)); await settle();
    await act(async () => browser.select(ROADMAP)); await settle();
    if (local) await caret(true);
    await act(async () => browser.setDraft("# Latest title\n\nBody.\n")); await settle();
    await caret(false);
    await act(async () => release()); await settle();
    await act(async () => { jest.advanceTimersByTime(2_500); }); await settle();
    expect(browser.editor.path).toBe(`${FOLDER}/${local ? "Latest title" : "Q4 plan"}.md`);
    expect(moves()).toHaveLength(local ? 2 : 1);
    expect(files.has(`${FOLDER}/Q4 plan verified.md`)).toBe(false);
  });

});
