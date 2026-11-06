/** @jest-environment jsdom */

/**
 * **"When i create a new note and i start typing to add a title it adds the
 * 'untitled-x-x' despite me creating the title already"** (Dev2, 2026-11-05).
 *
 * The folder had not finished loading when the note opened, so its untitled
 * name was one the bucket already had; the first save was refused and the
 * note moved to the next name (`UnsentCreate.retarget`). That used to rewrite
 * the note's heading when it still began with the old name, select the title
 * again over what had been typed, and forget the title had been typed here, so
 * the note never took its title as its name.
 *
 * SABOTAGE: dropping `retargeted` from `useLinkedTitle` fails both tests (the
 * note stays `untitled-…-2`, and its title is selected again).
 *
 * Mounted as `renameCollabFreeze.test.ts` mounts the console: the file
 * browser, its tabs and the note room.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as Y from "yjs";
import type { FileBrowser } from "../features/console/files/browser";
import { ConsoleGrantCache, type ConsoleGrant, type GrantRefresh } from "../features/agent/consoleGrantCache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => actions[name]!(args);
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => ({ query: async () => null }) };
});
const mockIssue = jest.fn<() => Promise<ConsoleGrant>>();
let mockCache: ConsoleGrantCache;
const mockGrant = ({ workspaceId }: { workspaceId: string }, refresh: GrantRefresh = false) =>
  mockCache.get(workspaceId, mockIssue, refresh);
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockGrant }));

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useTabs } from "../features/console/files/useTabs";
import { useNoteRoom } from "../features/console/presence/useNoteRoom";
import { roomPathOf } from "../features/console/files/noteEditor/trashed";
import { legacyDraftFor } from "../features/console/collaboration/legacyDraft";

const FOLDER = "1-projects";
const FROM = `${FOLDER}/untitled-2026-11-04.md`;
const fn = (name: string) => `functions/files:${name}`;

/** The note's document, for the room the harness mounts; nothing here shares the note. */
let server: { doc: Y.Doc; revision: number; path: string; shared: boolean; delayMs: number };

let browser: FileBrowser;
let room: ReturnType<typeof useNoteRoom>;
/** Whether the note took typing, on every render: a freeze between two checks cannot hide. */
let typable: { path: string | null; typable: boolean }[];

/** A presence socket that never opens: this is about the durable controller. */
class QuietSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function mount() {
  const root = createRoot(document.createElement("div"), { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    useTabs(browser, "w1");
    // As `app/(app)/console/[slug]/index.tsx` passes it.
    room = useNoteRoom({
      workspaceId: "w1",
      endpoint: "https://gateway.example/mcp",
      notePath: roomPathOf(browser),
      conflicted: browser.editor.status === "conflict",
      textForSeed: () => browser.editor.draft,
      etagForSeed: () => browser.editor.etag,
      legacyDraft: () => legacyDraftFor(browser.editor),
      onExternalWrite: browser.onExternalWrite,
      onSaved: browser.onSaved,
      durable: browser.editor.etag?.startsWith("c2.") === true,
      canEdit: true,
      scope: "private",
      onCollaborationOwned: browser.setCollaborationOwned,
      renamed: browser.renamed,
      onCollaborationText: browser.setCollaborationDraft,
      onCollaborationState: browser.setCollaborationState,
    });
    // `durableReady` in `NoteEditor.tsx`.
    const shared = room.presence.collaboration;
    typable.push({ path: browser.editor.path, typable: shared === undefined || shared.ready !== false || shared.drafting === true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => act(() => root.unmount());
}

async function settle(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** What the editor's own keystroke does: the shared document's when there is one, the draft's otherwise. */
async function type(text: string) {
  await act(async () => {
    const shared = room.presence.collaboration;
    if (shared !== undefined) shared.onChange(text);
    else browser.setDraft(text);
  });
}


describe("a new note whose untitled name was taken", () => {
  let unmount: () => void;
  const files = new Map<string, string>();
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 10, 4, 22, 0, 0));
    localStorage.clear();
    typable = [];
    server = { doc: new Y.Doc(), revision: 1, path: FROM, shared: false, delayMs: 0 };
    server.doc.getText("note").insert(0, "# untitled-2026-11-04\n\nolder\n");
    files.clear();
    files.set(FROM, "# untitled-2026-11-04\n\nolder\n");
    (globalThis as { WebSocket?: unknown }).WebSocket = QuietSocket;
    let minted = 0;
    mockCache = new ConsoleGrantCache(`probe-${Math.random()}`);
    mockIssue.mockReset().mockImplementation(async () => { minted += 1; return { accessToken: `grant-${minted}`, expiresAt: Date.now() + 3_600_000, scopes: [] }; });
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({ error: "not_found" }) } as Response)) as typeof fetch;
    actions[fn("listFiles")] = async (args: never) => {
      const { path } = args as { path: string };
      if (path === FOLDER) await new Promise((r) => setTimeout(r, 2000));
      const prefix = path === "" ? "" : `${path}/`;
      const entries = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((key) => ({ kind: "file" as const, path: key, name: key.slice(prefix.length), visibility: "private" as const, inherited: "private" as const, exception: false, readOnly: false }));
      if (path === "") entries.push({ kind: "folder" as never, path: FOLDER, name: FOLDER, visibility: "private", inherited: "private", exception: false, readOnly: false });
      return { path, folderDefault: "private", truncated: false, manifestUsable: true, entries };
    };
    actions[fn("readNote")] = async (args: never) => {
      const { path } = args as { path: string };
      const text = files.get(path);
      if (text === undefined) throw new Error("missing");
      return { path, text, etag: `raw-${path}-${text.length}`, visibility: "private", inherited: "private", exception: false, readOnly: false };
    };
    actions[fn("writeNote")] = async (args: never) => {
      const { path, text, expectedEtag } = args as { path: string; text: string; expectedEtag?: string };
      if (expectedEtag === undefined && files.has(path)) {
        const { ConvexError } = require("convex/values");
        throw new ConvexError({ code: "CONFLICT", message: "taken" });
      }
      files.set(path, text);
      return { path, etag: `raw-${path}-${text.length}`, conflictCheck: "conditional" };
    };
    actions[fn("moveEntry")] = async (args: never) => {
      const { from, to } = args as { from: string; to: string };
      const full = to.includes("/") ? to : `${FOLDER}/${to}`;
      files.set(full, files.get(from)!); files.delete(from);
      return { path: full };
    };
    unmount = mount();
  });
  afterEach(() => { unmount(); jest.useRealTimers(); });

  async function openAndTitle() {
    await settle(10);
    await act(async () => browser.toggleFolder(FOLDER));
    await act(async () => browser.createUntitled(FOLDER, "note"));
    await settle(10);
    // Named before the folder listed its first untitled note of the day.
    expect(browser.editor.path).toBe(FROM);
    // Its made-up name is the file's, never the note's text.
    expect(browser.editor.draft).toBe("# \n\n");
    await act(async () => browser.setTitleCaret!(true));
    await type("# Shopping\n\n");
    await settle(5000);
  }

  test("it moves to the next name with the title as typed, and takes the title as its name", async () => {
    await openAndTitle();
    expect(browser.editor.path).toBe(`${FOLDER}/untitled-2026-11-04-2.md`);
    expect(browser.editor.draft).toBe("# Shopping\n\n");
    await act(async () => browser.setTitleCaret!(false));
    await settle(5000);
    expect(browser.editor.path).toBe(`${FOLDER}/Shopping.md`);
    expect(files.get(`${FOLDER}/Shopping.md`)).toBe("# Shopping\n\n");
    expect(files.get(FROM)).toBe("# untitled-2026-11-04\n\nolder\n");
  });

  test("the title is not selected again over what was typed", async () => {
    await settle(10);
    await act(async () => browser.toggleFolder(FOLDER));
    await act(async () => browser.createUntitled(FOLDER, "note"));
    await settle(10);
    const opened = browser.titleFocus;
    expect(opened?.path).toBe(FROM);
    await act(async () => browser.setTitleCaret!(true));
    await type("# Shopping\n\n");
    await settle(5000);
    expect(browser.editor.path).toBe(`${FOLDER}/untitled-2026-11-04-2.md`);
    expect(browser.titleFocus).toEqual(opened);
  });
});
