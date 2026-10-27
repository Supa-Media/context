/** @jest-environment jsdom */

/**
 * **"After i rename a note i have to wait about 5 seconds before i can start
 * actually typing in it"** (Dev2, 2026-10-27).
 *
 * A note made in this console is saved by full-text writes until something
 * reads it back, and the read after its rename is usually the first: it comes
 * back with a `c2.` version, the note turns shared under the person typing,
 * and a collaboration controller starts for it. That controller used to hold
 * the note read-only while it read the note and then sent the words typed
 * during the rename (two gateway round trips and a grant), and nothing typed
 * in that window was taken. Now the typing the editor holds is a draft from
 * the controller's first moment (`draftFromLegacy`), and the note goes on
 * taking typing while it is sent.
 *
 * Mounted the way the console route mounts it: the file browser, its tabs and
 * the note room, against a gateway that holds one document under whatever name
 * the note has.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as Y from "yjs";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
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
const FROM = `${FOLDER}/draft.md`;
const TO = `${FOLDER}/Launch plan.md`;
const fn = (name: string) => `functions/files:${name}`;

/** The gateway and the bucket: one note, one document, whatever its name. */
let server: { doc: Y.Doc; revision: number; path: string; shared: boolean; delayMs: number };
const serverText = () => server.doc.getText("note").toString();
const snapshot = () => Buffer.from(Y.encodeStateAsUpdate(server.doc)).toString("base64");
const version = () => `c2.doc-1.r${server.revision}`;
function replaceServerText(text: string) {
  const note = server.doc.getText("note");
  server.doc.transact(() => {
    note.delete(0, note.length);
    note.insert(0, text);
  });
  server.revision += 1;
}

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  const entry = (key: string, kind: "file" | "folder") => ({
    kind: kind as "file", path: key, name: key.slice(prefix.length),
    visibility: "private" as const, inherited: "private" as const, exception: false, readOnly: false,
  });
  const files = [server.path].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"));
  return {
    path, folderDefault: "private", truncated: false, manifestUsable: true,
    entries: [...files.map((key) => entry(key, "file")), ...(path === "" ? [entry(FOLDER, "folder")] : [])],
  };
}

function read(path: string): OpenNote {
  if (path !== server.path) throw new Error("That file does not exist.");
  // Not shared yet: the version is the bucket object's, and the editor keeps its full-text saves.
  if (!server.shared) return { path, text: serverText(), etag: `raw-${server.revision}`, visibility: "private", inherited: "private", exception: false, readOnly: false };
  return { path, text: serverText(), etag: version(), visibility: "private", inherited: "private", exception: false, readOnly: false };
}

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

describe("renaming the open note it turns shared", () => {
  let unmount: () => void;
  let land: (() => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    // The device's kept records (`collaboration/durable.ts`): each test is a device that never opened the note.
    localStorage.clear();
    typable = [];
    land = null;
    server = { doc: new Y.Doc(), revision: 1, path: FROM, shared: false, delayMs: 0 };
    server.doc.getText("note").insert(0, "# draft\n\nbody\n");
    (globalThis as { WebSocket?: unknown }).WebSocket = QuietSocket;
    let minted = 0;
    mockCache = new ConsoleGrantCache(`rename-handover-${Math.random()}`);
    mockIssue.mockReset().mockImplementation(async () => {
      minted += 1;
      return { accessToken: `grant-${minted}`, expiresAt: Date.now() + 3_600_000, scopes: [] };
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path: string; update?: string; replacement?: { expectedEtag: string; text: string } };
      if (server.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.delayMs));
      if (body.path !== server.path) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) } as Response;
      // The exact-base replacement, merged as the engine merges it (`replaceText`): here, nobody else wrote.
      if (body.replacement !== undefined) replaceServerText(body.replacement.text);
      if (body.update !== undefined) {
        Y.applyUpdate(server.doc, Buffer.from(body.update, "base64"));
        server.revision += 1;
      }
      return { ok: true, status: 200, json: async () => ({ documentId: "doc-1", update: snapshot(), text: serverText(), etag: version() }) } as Response;
    }) as typeof fetch;
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("writeNote")] = async (args: never) => {
      const { path, text } = args as { path: string; text: string };
      replaceServerText(text);
      return { path, etag: `raw-${server.revision}`, conflictCheck: "conditional" };
    };
    // The move answers once the test lets it; the first read of the note at its new name
    // is the one that comes back shared.
    actions[fn("moveEntry")] = (args: never) =>
      new Promise((resolve) => {
        const { to } = args as { to: string };
        land = () => {
          server.path = to;
          server.shared = true;
          resolve({ path: to });
        };
      });
    unmount = mount();
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  async function openAndRetitle() {
    await settle(10);
    await act(async () => browser.toggleFolder(FOLDER));
    await settle(10);
    await act(async () => browser.select(FROM));
    await settle(100);
    expect(room.presence.collaboration).toBeUndefined();
    await act(async () => browser.setTitleCaret!(true));
    await type("# Launch plan\n\nbody\n");
    await settle(3_000);
    typable = [];
    // Enter: the caret leaves the title, and the rename is asked for.
    await act(async () => browser.setTitleCaret!(false));
    await settle(10);
    expect(land).not.toBeNull();
  }

  test("words typed during the rename are kept, and the note never stops taking typing", async () => {
    await openAndRetitle();
    await type("# Launch plan\n\nbody, typed while it moved\n");
    await settle(500);
    await act(async () => land!());
    await settle(5_000);

    expect(browser.editor.path).toBe(TO);
    expect(room.presence.collaboration?.ready).toBe(true);
    expect(typable.filter((one) => !one.typable)).toEqual([]);
    expect(serverText()).toBe("# Launch plan\n\nbody, typed while it moved\n");
    expect(browser.editor.draft).toBe("# Launch plan\n\nbody, typed while it moved\n");
  });

  test("on a slow connection, typing after it lands is taken at once and sent", async () => {
    await openAndRetitle();
    await type("# Launch plan\n\nbody, typed while it moved\n");
    server.delayMs = 2_000;
    await act(async () => land!());
    await settle(300);
    // The controller is up, and still waiting for its first answer.
    expect(room.presence.collaboration).toBeDefined();
    expect(room.presence.collaboration!.ready).toBe(false);
    await type("# Launch plan\n\nbody, typed while it moved, and after\n");
    await settle(10_000);

    expect(typable.filter((one) => !one.typable)).toEqual([]);
    expect(room.presence.collaboration?.ready).toBe(true);
    expect(serverText()).toBe("# Launch plan\n\nbody, typed while it moved, and after\n");
    expect(browser.editor.draft).toBe("# Launch plan\n\nbody, typed while it moved, and after\n");
  });

  test("with nothing typed during the rename, the note takes typing the moment it lands", async () => {
    await openAndRetitle();
    server.delayMs = 2_000;
    await act(async () => land!());
    await settle(300);
    expect(room.presence.collaboration?.ready).toBe(false);
    await type("# Launch plan\n\nbody, and after\n");
    await settle(10_000);

    expect(typable.filter((one) => !one.typable)).toEqual([]);
    expect(serverText()).toBe("# Launch plan\n\nbody, and after\n");
    expect(browser.editor.draft).toBe("# Launch plan\n\nbody, and after\n");
  });
});
