/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const WORKSPACE = "w1";
const PATH = "youversion-smoke-test.md";
const LINK = "[John 3:16](https://www.bible.com/bible/1/JHN.3.16)";
const NOTE: OpenNote = {
  path: PATH,
  text: "John 3:16",
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};
const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [{
    kind: "file",
    path: PATH,
    name: PATH,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  }],
  truncated: false,
  manifestUsable: true,
};

let browser: FileBrowser;
let unmount: (() => void) | null = null;

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  unmount = () => act(() => root.unmount());
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = async () => ROOT;
  actions[name("readNote")] = async () => NOTE;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

async function openNote() {
  mount();
  await settle();
  act(() => { browser.select(PATH); });
  await settle();
}

describe("a plugin write and the open editor stay coherent", () => {
  test("the clean exact version changes on screen without another bucket write", async () => {
    await openNote();
    act(() => browser.applyPluginNoteWrite!({
      path: PATH,
      text: LINK,
      expectedEtag: "etag-1",
      etag: "etag-2",
    }));

    expect(browser.editor).toMatchObject({
      path: PATH,
      draft: LINK,
      baseline: LINK,
      etag: "etag-2",
      status: "clean",
    });
    expect(actions[name("writeNote")]).toBeUndefined();
  });

  test("typing that raced the plugin is never discarded", async () => {
    await openNote();
    act(() => browser.setDraft("John 3:16 and my unfinished thought"));
    act(() => browser.applyPluginNoteWrite!({
      path: PATH,
      text: LINK,
      expectedEtag: "etag-1",
      etag: "etag-2",
    }));

    expect(browser.editor).toMatchObject({
      draft: "John 3:16 and my unfinished thought",
      baseline: "John 3:16",
      etag: "etag-1",
      status: "dirty",
    });
  });

  test("a write for a stale version cannot replace a newer editor", async () => {
    await openNote();
    act(() => browser.applyPluginNoteWrite!({
      path: PATH,
      text: LINK,
      expectedEtag: "some-other-etag",
      etag: "etag-2",
    }));
    expect(browser.editor.draft).toBe("John 3:16");
    expect(browser.editor.etag).toBe("etag-1");
  });
});
