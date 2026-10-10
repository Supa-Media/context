/**
 * @jest-environment jsdom
 */

/**
 * THE APP'S HALF OF AN APPROVAL: listing, deciding, and not believing a stale answer.
 *
 * `approvalsGateway.test.ts` proves the wire and `approvalsPanelRender.test.ts`
 * what a person sees. This is the hook between them, and the things it must not
 * get wrong:
 *
 *  1. **It asks with the console's grant, and re-mints once on a refusal** — the
 *     same rule as the agent (`agentEngineHook.test.ts`), never a loop.
 *  2. **A decision leaves the list only when the gateway settled it.** An
 *     approval that did not go through stays where it was, with the reason.
 *  3. **An answer for a context the console has left is dropped.** A list for
 *     one context must never show on another.
 *  4. **Nothing is asked when there is nothing to ask about** — the demo, the
 *     phone, a console with no context.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The re-mint made a loop — `while (status === 401)`.
 *     → **1 fails**: `a refusal twice is not answered by minting again`.
 *  2. `decide` removing the row before the gateway answered.
 *     → **1 fails**: `a refused approval stays on the list with the reason`.
 *  3. The epoch guard removed from `list`, so an answer for an earlier context lands.
 *     → **1 fails**: `an answer for a context the console has left is dropped`.
 *  4. `enabled` ignored, so the list is fetched on the demo.
 *     → **1 fails**: `nothing is asked when there is nothing to ask about`.
 *  5. The settled-ids filter removed, so a listing that raced a decision
 *     brings the settled approval back.
 *     → **1 fails**: `a listing that was in flight when a decision settled does not bring it back`.
 *  6. Listing the shown workspace only (Dev2, 2026-10-10: an approval held in
 *     the personal workspace never showed while another was open).
 *     → **fails**: `approvals held in any of the person's workspaces are listed`.
 *  7. A decision sent with the shown workspace's grant.
 *     → **fails**: `a decision goes back to the workspace that holds the approval`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// `mock`-prefixed so the hoisted factories may close over them.
let mockClient: object = {};
let mockMintCount = 0;
const mockMintCalls: unknown[] = [];
const mockMint = async (args: unknown) => {
  mockMintCalls.push(args);
  mockMintCount += 1;
  return { accessToken: `grant-${mockMintCount}`, expiresAt: Date.now() + 3_600_000, scopes: [] };
};
jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  useAction: () => (args: unknown) => mockMint(args),
}));
jest.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => "session-alpha" }));

import { useApprovals, type ApprovalsView } from "../features/approvals/useApprovals";
import { GONE_SENTENCE, UNREACHABLE_SENTENCE } from "../features/approvals/gateway";

const MCP = "https://mcp.context.test/@seyi/mcp";
const APPROVALS = "https://mcp.context.test/approvals";
const NOW = Date.now();

const RECORD = (id: string) => ({
  id,
  summary: `share ${id}`,
  tool: "create_link",
  args: { path: `${id}.md` },
  audience: null,
  client: "Claude Desktop",
  created_at: NOW - 60_000,
  expires_at: NOW + 600_000,
});

interface Answer {
  status: number;
  body: unknown;
}

/** Answers each request in turn; a `Promise` answer is held until resolved. */
let mockFetchCalls: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
let mockAnswers: Array<Answer | Promise<Answer> | "throw"> = [];

beforeEach(() => {
  mockClient = {};
  mockMintCount = 0;
  mockMintCalls.length = 0;
  mockFetchCalls = [];
  mockAnswers = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    mockFetchCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers.Authorization ?? "",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = mockAnswers.shift();
    if (next === undefined || next === "throw") throw new TypeError("network down");
    const answer = await next;
    return { status: answer.status, json: async () => answer.body } as Response;
  });
});

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
});

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function harness(initial: { workspaceId: string | null; endpoint: string | null; enabled: boolean; workspaceIds?: string[] }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  let latest: ApprovalsView | null = null;
  function Probe(props: typeof initial) {
    latest = useApprovals(props);
    return null;
  }
  const render = (props: typeof initial) => act(() => root.render(createElement(Probe, props)));
  render(initial);
  return {
    view: () => latest as unknown as ApprovalsView,
    rerender: (props: typeof initial) => render(props),
  };
}

describe("listing", () => {
  test("it lists on mount, with the console's grant, and reads what came back", async () => {
    mockAnswers = [{ status: 200, body: { approvals: [RECORD("a"), RECORD("b")] } }];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    expect(mockFetchCalls).toEqual([
      { url: APPROVALS, method: "GET", auth: "Bearer grant-1", body: undefined },
    ]);
    expect(h.view().phase).toBe("listed");
    expect(h.view().items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("nothing is asked when there is nothing to ask about", async () => {
    for (const props of [
      { workspaceId: "ws_1", endpoint: MCP, enabled: false },
      { workspaceId: null, endpoint: MCP, enabled: true },
      { workspaceId: "ws_1", endpoint: null, enabled: true },
    ]) {
      const h = harness(props);
      await flush();
      expect(h.view().available).toBe(false);
    }
    expect(mockFetchCalls).toEqual([]);
  });

  /**
   * A token the gateway refused is replaced once. Asking a second time for the
   * same refusal would mint tokens until the rate limit caught it.
   */
  test("a refused token is replaced once, and then the refusal stands", async () => {
    mockAnswers = [{ status: 401, body: null }, { status: 401, body: null }];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    expect(mockFetchCalls).toHaveLength(2);
    expect(mockMintCalls).toHaveLength(2);
    expect(h.view().phase).toBe("failed");
    expect(h.view().error).toContain("Reload");
  });

  test("a refused token is replaced, and the retry's list is what is shown", async () => {
    mockAnswers = [{ status: 401, body: null }, { status: 200, body: { approvals: [RECORD("a")] } }];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    expect(mockFetchCalls.map((call) => call.auth)).toEqual(["Bearer grant-1", "Bearer grant-2"]);
    expect(h.view().items).toHaveLength(1);
  });

  test("a network failure is a sentence, not a crash", async () => {
    mockAnswers = ["throw"];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    expect(h.view().phase).toBe("failed");
    expect(h.view().error).toBe(UNREACHABLE_SENTENCE);
  });

  test("a body that is not the documented shape fails the listing", async () => {
    mockAnswers = [{ status: 200, body: { approvals: [{ id: "a" }] } }];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    expect(h.view().phase).toBe("failed");
    expect(h.view().items).toEqual([]);
  });

  /**
   * The console changed context while a listing was in flight. The answer is
   * for a list the person has left, so it is not shown on this one.
   */
  test("an answer for a context the console has left is dropped", async () => {
    let answerFirst!: (answer: Answer) => void;
    mockAnswers = [new Promise<Answer>((resolve) => (answerFirst = resolve))];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    mockAnswers.push({ status: 200, body: { approvals: [RECORD("second")] } });
    h.rerender({ workspaceId: "ws_2", endpoint: MCP, enabled: true });
    await flush();

    await act(async () => answerFirst({ status: 200, body: { approvals: [RECORD("first")] } }));
    await flush();

    expect(h.view().items.map((item) => item.id)).toEqual(["second"]);
  });
});

describe("deciding", () => {
  test("an approval the gateway ran comes off the list, with what happened", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a"), RECORD("b")] } },
      { status: 200, body: { status: "approved", summary: "share a", result: "Shared.", ok: true } },
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    await act(async () => h.view().decide("a", "approve"));
    await flush();

    const post = mockFetchCalls[1]!;
    expect(post).toMatchObject({ url: APPROVALS, method: "POST", body: { id: "a", action: "approve" } });
    expect(h.view().items.map((item) => item.id)).toEqual(["b"]);
    expect(h.view().notice).toEqual({ tone: "ok", text: "Approved. It ran as asked." });
  });

  test("a denial comes off the list and says nothing ran", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a")] } },
      { status: 200, body: { status: "denied", summary: "share a" } },
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    await act(async () => h.view().decide("a", "deny"));
    await flush();

    expect(mockFetchCalls[1]?.body).toEqual({ id: "a", action: "deny" });
    expect(h.view().items).toEqual([]);
    expect(h.view().notice?.text).toBe("Denied. Nothing ran.");
  });

  test("an approval that was refused stays on the list, with the reason", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a")] } },
      { status: 400, body: { error: "invalid_request" } },
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    await act(async () => h.view().decide("a", "approve"));
    await flush();

    expect(h.view().items.map((item) => item.id)).toEqual(["a"]);
    expect(h.view().notice?.tone).toBe("warn");
    expect(h.view().busyId).toBeNull();
  });

  test("an approval already settled elsewhere leaves the list and says why", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a")] } },
      { status: 404, body: { error: "not_found" } },
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    await act(async () => h.view().decide("a", "approve"));
    await flush();

    expect(h.view().items).toEqual([]);
    expect(h.view().notice).toEqual({ tone: "warn", text: GONE_SENTENCE });
  });

  /**
   * A listing requested before a decision can answer after it. Its copy of the
   * approval is older than the decision, so it must not put the approval back
   * on the list as if it were still waiting.
   */
  test("a listing that was in flight when a decision settled does not bring it back", async () => {
    let answerRefresh!: (answer: Answer) => void;
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a")] } },
      new Promise<Answer>((resolve) => (answerRefresh = resolve)),
      { status: 200, body: { status: "approved", summary: "share a", result: "Shared.", ok: true } },
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    act(() => h.view().refresh());
    await flush();
    await act(async () => h.view().decide("a", "approve"));
    await flush();
    expect(h.view().items).toEqual([]);

    await act(async () =>
      answerRefresh({ status: 200, body: { approvals: [RECORD("a"), RECORD("b")] } }),
    );
    await flush();

    expect(h.view().items.map((item) => item.id)).toEqual(["b"]);
  });

  test("one decision at a time: a second press while one is in flight is ignored", async () => {
    let answerFirst!: (answer: Answer) => void;
    mockAnswers = [
      { status: 200, body: { approvals: [RECORD("a"), RECORD("b")] } },
      new Promise<Answer>((resolve) => (answerFirst = resolve)),
    ];
    const h = harness({ workspaceId: "ws_1", endpoint: MCP, enabled: true });
    await flush();

    act(() => {
      h.view().decide("a", "approve");
      h.view().decide("b", "approve");
    });
    await flush();

    expect(mockFetchCalls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => answerFirst({ status: 200, body: { status: "denied", summary: null } }));
    await flush();
  });
});

describe("every workspace", () => {
  test("approvals held in any of the person's workspaces are listed", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [] } },
      { status: 200, body: { approvals: [RECORD("held-in-personal")] } },
    ];
    const h = harness({ workspaceId: "ws_supa", workspaceIds: ["ws_supa", "ws_personal"], endpoint: MCP, enabled: true });
    await flush();

    expect(mockMintCalls.map((call) => (call as { workspaceId: string }).workspaceId)).toEqual(["ws_supa", "ws_personal"]);
    expect(h.view().phase).toBe("listed");
    expect(h.view().items.map((item) => item.id)).toEqual(["held-in-personal"]);
  });

  test("one workspace that cannot be read leaves the others' approvals showing", async () => {
    mockAnswers = ["throw", { status: 200, body: { approvals: [RECORD("a")] } }];
    const h = harness({ workspaceId: "ws_supa", workspaceIds: ["ws_personal"], endpoint: MCP, enabled: true });
    await flush();

    expect(h.view().phase).toBe("listed");
    expect(h.view().items.map((item) => item.id)).toEqual(["a"]);
  });

  test("a decision goes back to the workspace that holds the approval", async () => {
    mockAnswers = [
      { status: 200, body: { approvals: [] } },
      { status: 200, body: { approvals: [RECORD("a")] } },
      { status: 200, body: { status: "approved", summary: "share a", result: "Shared.", ok: true } },
    ];
    const h = harness({ workspaceId: "ws_supa", workspaceIds: ["ws_supa", "ws_personal"], endpoint: MCP, enabled: true });
    await flush();

    // The listing minted grant-1 for ws_supa and grant-2 for ws_personal.
    const personalGrant = mockFetchCalls[mockMintCalls.findIndex((call) => (call as { workspaceId: string }).workspaceId === "ws_personal")]!.auth;
    await act(async () => h.view().decide("a", "approve"));
    await flush();

    const post = mockFetchCalls.find((call) => call.method === "POST")!;
    expect(post.auth).toBe(personalGrant);
    expect(mockFetchCalls.filter((call) => call.auth === personalGrant)).toHaveLength(2);
    expect(h.view().items).toEqual([]);
  });
});
