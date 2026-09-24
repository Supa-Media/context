/** @jest-environment jsdom */

/**
 * The durable editor's HTTP transport against the gateway's real answers.
 *
 * The controller decides "revoked", "unavailable" and "retry" from a status,
 * and its own suite feeds it `Error("401")`. The gateway answers with a JSON
 * body — `invalid_token`, `not_found`, `collaboration_unavailable` — and the
 * transport used to throw that code instead of the status, so none of those
 * decisions ever fired against a real refusal or outage. This mounts the real
 * hook, the real grant cache and a fetch that answers the way the gateway does.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { ConsoleGrantCache, type ConsoleGrant, type GrantRefresh } from "../features/agent/consoleGrantCache";
import { createSharedDoc } from "../features/console/presence/sharedDoc";

const mockIssue = jest.fn<() => Promise<ConsoleGrant>>();
let mockCache: ConsoleGrantCache;
const mockGrant = ({ workspaceId }: { workspaceId: string }, refresh: GrantRefresh = false) =>
  mockCache.get(workspaceId, mockIssue, refresh);
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockGrant }));

import { useCollaboration } from "../features/console/collaboration/useCollaboration";
import type { DurableStatus } from "../features/console/collaboration/durable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
let statuses: DurableStatus[];
let tokens: string[];

function body(text: string) {
  const shared = createSharedDoc({});
  shared.doc.transact(() => shared.text.insert(0, text), "server");
  const result = { documentId: "doc-1", update: shared.snapshot(), text, etag: "etag-1" };
  shared.destroy();
  return result;
}

function answer(status: number, value: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function answerWith(respond: (token: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer ", "");
    tokens.push(token);
    return await respond(token);
  }) as typeof fetch;
}

async function mount() {
  const root = createRoot(document.createElement("div"));
  function Probe() {
    useCollaboration({
      workspaceId: "workspace",
      endpoint: "https://gateway.example/mcp",
      path: "notes/a.md",
      scope: "private",
      initialText: () => "",
      editable: true,
      onText: () => {},
      onState: (state) => { statuses.push(state.status); },
    });
    return null;
  }
  await act(async () => { root.render(createElement(Probe)); });
  return root;
}

async function settle(ms = 0) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  jest.useFakeTimers();
  statuses = [];
  tokens = [];
  let minted = 0;
  mockCache = new ConsoleGrantCache("transport-test");
  mockIssue.mockReset().mockImplementation(async () => {
    minted += 1;
    return { accessToken: `grant-${minted}`, expiresAt: Date.now() + 3_600_000, scopes: [] };
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.clearAllTimers();
  jest.useRealTimers();
});

test("a gateway 401 replaces the credential once and the note still opens", async () => {
  // What the gateway sends for a token another consumer's mint revoked.
  answerWith((token) => token === "grant-1"
    ? answer(401, { error: "invalid_token", error_description: "Unauthorized." })
    : answer(200, body("hello")));
  const root = await mount();
  await settle();
  expect(tokens).toEqual(["grant-1", "grant-2"]);
  expect(statuses[statuses.length - 1]).toBe("saved");
  act(() => root.unmount());
});

test("a 401 against the replacement is a revocation", async () => {
  answerWith(() => answer(401, { error: "invalid_token" }));
  const root = await mount();
  await settle();
  expect(statuses[statuses.length - 1]).toBe("revoked");
  expect(mockIssue).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});

test("the gateway's not_found is an unavailable note, not a generic error", async () => {
  answerWith(() => answer(404, { error: "not_found" }));
  const root = await mount();
  await settle();
  expect(statuses[statuses.length - 1]).toBe("unavailable");
  act(() => root.unmount());
});

test("a request that never answers is abandoned as a network failure", async () => {
  // A connection that hangs: only the transport's own deadline ends it, and a
  // browser's fetch rejects when that deadline aborts it.
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const root = await mount();
  await settle(29_000);
  expect(statuses).not.toContain("offline");
  await settle(1_000);
  // Retryable, so the note waits for a connection instead of claiming that
  // local storage failed.
  expect(statuses[statuses.length - 1]).toBe("offline");
  act(() => root.unmount());
});
