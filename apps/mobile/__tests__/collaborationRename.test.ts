/** @jest-environment jsdom */

/**
 * **"I rename and start typing … it deletes everything i typed already,
 * renames the file, and takes 1 billion years to load"** (owner, 2026-10-14).
 *
 * The note's path changed under its controller, so the hook stopped it — with
 * the typing it had not sent yet — and started a new one cold at the new name,
 * whose first read put the bucket's older text over the editor while the note
 * sat read-only. A rename this console made now keeps the controller and its
 * document; any other path change is a different note and starts afresh.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ConsoleGrantCache, type ConsoleGrant, type GrantRefresh } from "../features/agent/consoleGrantCache";
import { createSharedDoc } from "../features/console/presence/sharedDoc";

const mockIssue = jest.fn<() => Promise<ConsoleGrant>>();
let mockCache: ConsoleGrantCache;
const mockGrant = ({ workspaceId }: { workspaceId: string }, refresh: GrantRefresh = false) =>
  mockCache.get(workspaceId, mockIssue, refresh);
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockGrant }));

import { useCollaboration } from "../features/console/collaboration/useCollaboration";
import type { DurableCollaboration } from "../features/console/collaboration/durable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const TEXT = "# Plan\n\nBody.";
let requests: { path: string; update?: string }[];

/** The gateway's copy: one document, so every answer names the same characters. */
const serverCopy = (() => {
  let made: ReturnType<typeof make> | null = null;
  return () => (made ??= make());
})();

function make() {
  const shared = createSharedDoc({});
  shared.doc.transact(() => shared.text.insert(0, TEXT), "server");
  const result = { documentId: "doc-1", update: shared.snapshot(), text: TEXT, etag: "c2.1" };
  shared.destroy();
  return result;
}

type Rename = { id: number; from: string; to: string } | null;
let seen: DurableCollaboration | undefined;
let root: Root;

let props: { path: string; rename: Rename } = { path: "", rename: null };

/** One component for the whole test, so a re-render is a re-render and not a new mount. */
function Probe() {
  seen = useCollaboration({
    workspaceId: "workspace",
    endpoint: "https://gateway.example/mcp",
    path: props.path,
    scope: "private",
    initialText: () => "",
    editable: true,
    onText: () => {},
    rename: props.rename,
  });
  return null;
}

function render(path: string, rename: Rename) {
  props = { path, rename };
  return act(async () => {
    root.render(createElement(Probe, { key: "probe", ...props }));
  });
}

async function settle(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  requests = [];
  let minted = 0;
  mockCache = new ConsoleGrantCache("rename-test");
  mockIssue.mockReset().mockImplementation(async () => {
    minted += 1;
    return { accessToken: `grant-${minted}`, expiresAt: Date.now() + 3_600_000, scopes: [] };
  });
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; update?: string };
    requests.push(body);
    return { ok: true, status: 200, json: async () => serverCopy() } as Response;
  }) as typeof fetch;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

describe("renaming the open note", () => {
  test("keeps its document, holds typing while the rename is on its way, then sends it to the new name", async () => {
    await render("notes/plan.md", null);
    await settle(10);
    const shared = seen!.shared;
    expect(seen!.ready).toBe(true);

    // The press: the rename is on its way.
    await render("notes/plan.md", { id: 1, from: "notes/plan.md", to: "notes/Roadmap.md" });
    requests = [];
    await act(async () => {
      seen!.onChange(`${TEXT} Typed during the rename.`);
    });
    await settle(1_000);
    expect(requests.filter((one) => one.update !== undefined)).toEqual([]);

    // It landed: the editor is on the new name.
    await render("notes/Roadmap.md", { id: 1, from: "notes/plan.md", to: "notes/Roadmap.md" });
    await settle(10);
    expect(seen!.shared).toBe(shared);
    expect(seen!.ready).toBe(true);
    expect(seen!.text).toBe(`${TEXT} Typed during the rename.`);
    const writes = requests.filter((one) => one.update !== undefined);
    expect(writes.map((one) => one.path)).toEqual(["notes/Roadmap.md"]);
  });

  test("a different note at another path still gets its own document", async () => {
    await render("notes/plan.md", null);
    await settle(10);
    const shared = seen!.shared;
    await render("notes/other.md", { id: 1, from: "notes/plan.md", to: "notes/Roadmap.md" });
    await settle(10);
    expect(seen!.shared).not.toBe(shared);
  });
});
