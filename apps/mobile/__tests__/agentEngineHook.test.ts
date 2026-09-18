/**
 * @jest-environment jsdom
 */

/**
 * THE APP'S HALF OF THE TURN: a grant minted, spent, and never kept.
 *
 * `agentGateway.test.ts` proves what goes on the wire. `agentGrant.test.ts` in
 * the control plane proves the grant is an ordinary revocable one. This is the
 * part in between — the hook that holds a live credential in a browser — and
 * the three things it must not get wrong:
 *
 *  1. **The token is never written anywhere.** Not `localStorage`, not
 *     `AsyncStorage`, not `SecureStore`. Minting another costs one round trip
 *     on a session the person already holds, so persistence buys nothing and
 *     leaves a credential on the device for somebody else to find — which is
 *     the sentence non-negotiable #1 ends with.
 *  2. **A 401 re-mints once, never in a loop.** A token dies an hour in and one
 *     re-mint fixes it; a gateway refusing for some other reason would
 *     otherwise be answered by minting tokens until the rate limit caught it.
 *  3. **A live token is reused.** One mint should serve every turn in the hour,
 *     or the hook is a mint-per-question with the rate limit as its only bound.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `tokenFor` ignoring the held token and minting every time.
 *     → **1 fails**: `a live token is minted once and spent again`.
 *  2. The re-mint made a loop — `while (response.status === 401)`.
 *     → **1 fails**: `a gateway that refuses twice is not answered by minting
 *     twice more`.
 *
 *     It failed *nothing* on the first run and hung the suite instead: the stub
 *     answered 401 forever and the loop never came back, so the run was red and
 *     named nothing. The stub now gives up after four requests, which turns the
 *     loop into a thrown fetch and the hang into two failed counts. The bound
 *     is part of the test rather than a convenience — this is the second time
 *     in this change that a sabotage turned out to kill a run rather than fail
 *     a check, the first being `providerCredential.test.mjs`'s 404.
 *  3. The expiry margin removed, so a token is spent until the instant it dies.
 *     → **1 fails**: `a token about to expire is replaced before it is spent`.
 *  4. `localStorage.setItem("agent-token", …)` added beside the ref — the
 *     "so a reload does not cost a round trip" optimisation.
 *     → **1 fails**: `the token is never written to any store on the device`.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over them.
const mockMintCalls: unknown[] = [];
let mockMintAnswer: () => { accessToken: string; expiresAt: number; scopes: string[] };

jest.mock("convex/react", () => ({
  useAction: () => async (args: unknown) => {
    mockMintCalls.push(args);
    return mockMintAnswer();
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useAgentEngine } from "../features/agent/useAgentEngine";
import type { AgentEngine } from "../features/agent/engine";
import type { AgentPage } from "../features/agent/page";

const ENDPOINT = "https://mcp.context.test/mcp";
const WORKSPACE = "ws_agent";

const PLACE = {
  context: { slug: "seyi", personal: true, role: "owner" },
  note: null,
  route: "/console/@seyi",
  meetingLive: false,
  query: null,
} as AgentPage;

let requests: { url: string; init: RequestInit }[] = [];
let responder: (n: number) => { status: number; body: unknown };
const roots: (() => void)[] = [];

beforeEach(() => {
  mockMintCalls.length = 0;
  requests = [];
  let minted = 0;
  mockMintAnswer = () => ({
    accessToken: `cat_minted_${++minted}`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ["context:read"],
  });
  responder = () => ({ status: 200, body: { answer: "ok", provider: "anthropic", steps: [] } });
  /*
    A response shaped like the one `fetch` gives, built by hand: jsdom has no
    `Response` constructor, and the hook reads exactly two things off what it
    gets — `status` and `json()`. A stub that answered more would be describing
    a `fetch` this code does not use.
  */
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const { status, body } = responder(requests.length);
    return { status, json: async () => body } as unknown as Response;
  };
});

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** Mount the hook and hand back whatever it returned. */
function engine(options: { workspaceId?: string | null; endpoint?: string | null } = {}): {
  current: AgentEngine;
} {
  const held = { current: null as AgentEngine | null };
  function Probe() {
    const value = useAgentEngine({
      workspaceId: options.workspaceId === undefined ? WORKSPACE : options.workspaceId,
      endpoint: options.endpoint === undefined ? ENDPOINT : options.endpoint,
    });
    useEffect(() => {
      held.current = value;
    }, [value]);
    held.current = value;
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(Probe)));
  return held as { current: AgentEngine };
}

async function ask(held: { current: AgentEngine }, question = "what did we decide?") {
  let answer = "";
  await act(async () => {
    answer = await held.current.ask({ question, place: PLACE });
  });
  return answer;
}

describe("spending the grant", () => {
  test("a turn presents the minted token and the built body", async () => {
    const held = engine();
    expect(await ask(held)).toBe("ok");

    expect(mockMintCalls).toEqual([{ workspaceId: WORKSPACE }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://mcp.context.test/agent");
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer cat_minted_1",
    );
    const sent = JSON.parse(requests[0]!.init.body as string);
    expect(sent.question).toBe("what did we decide?");
    expect(sent.place.context).toBe("seyi");
  });

  test("a live token is minted once and spent again", async () => {
    const held = engine();
    await ask(held, "first");
    await ask(held, "second");

    expect(mockMintCalls).toHaveLength(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect((request.init.headers as Record<string, string>).Authorization).toBe(
        "Bearer cat_minted_1",
      );
    }
  });

  test("a token about to expire is replaced before it is spent", async () => {
    let minted = 0;
    mockMintAnswer = () => ({
      accessToken: `cat_minted_${++minted}`,
      // Inside the margin: alive, and not alive long enough to survive a turn.
      expiresAt: Date.now() + 30_000,
      scopes: ["context:read"],
    });

    const held = engine();
    await ask(held, "first");
    await ask(held, "second");

    expect(mockMintCalls).toHaveLength(2);
    expect((requests[1]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer cat_minted_2",
    );
  });
});

describe("when the gateway refuses", () => {
  test("a 401 is answered by minting once and asking again", async () => {
    responder = (n) =>
      n === 1
        ? { status: 401, body: { error: "invalid_token" } }
        : { status: 200, body: { answer: "second time", provider: "anthropic", steps: [] } };

    const held = engine();
    expect(await ask(held)).toBe("second time");

    expect(mockMintCalls).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect((requests[1]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer cat_minted_2",
    );
  });

  test("a gateway that refuses twice is not answered by minting twice more", async () => {
    /*
      The stub gives up after four, and that bound is the test rather than a
      convenience. Sabotaging the re-mint into a `while` loop against a stub
      that answers 401 forever does not fail this suite — it **hangs it**,
      which is a red run that names nothing. The ceiling turns the loop into a
      thrown fetch, which `ask` catches, which makes the two assertions below
      fail with the count that is wrong. See the sabotage record.
    */
    responder = (n) => {
      if (n > 4) throw new Error("the hook is looping");
      return { status: 401, body: { error: "invalid_token" } };
    };

    const held = engine();
    const answer = await ask(held);

    // Exactly two requests and two mints. A loop would run until the rate
    // limit refused, and the person would wait for all of it.
    expect(requests).toHaveLength(2);
    expect(mockMintCalls).toHaveLength(2);
    expect(answer).toContain("Reload");
  });

  test("a model that did not answer is a sentence, not a throw", async () => {
    responder = () => ({ status: 502, body: { error: "model_unavailable" } });
    expect(await ask(engine())).toContain("did not answer");
  });

  test("no model connected points at the screen that connects one", async () => {
    responder = () => ({ status: 409, body: { error: "no_provider" } });
    expect(await ask(engine())).toContain("Settings");
  });

  test("a network failure is a sentence and never the URL it failed at", async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => {
      throw new TypeError("Failed to fetch https://mcp.context.test/agent");
    };
    const answer = await ask(engine());
    expect(answer).not.toContain("mcp.context.test");
    expect(answer.length).toBeGreaterThan(0);
  });
});

describe("what the panel is told it is talking to", () => {
  /**
   * `AgentPanel`'s header renders this, and its own docstring says why that
   * matters: which model answered decides what it cost and whose machine saw
   * the question. It was a ref in the first draft — for the same reason the
   * token is one — and a ref means no re-render, so the header said "Your
   * model" forever. This is that finding, pinned.
   */
  test("the header names the provider once one has answered", async () => {
    const held = engine();
    expect(held.current.provider).toBe("Your model");

    await ask(held);

    expect(held.current.provider).toBe("Claude");
  });

  test("a turn that never answered leaves it unnamed rather than guessing", async () => {
    responder = () => ({ status: 502, body: { error: "model_unavailable" } });
    const held = engine();
    await ask(held);
    expect(held.current.provider).toBe("Your model");
  });
});

describe("where a turn can be sent at all", () => {
  test("no context and no endpoint means nothing is asked", async () => {
    const noWorkspace = engine({ workspaceId: null });
    expect(noWorkspace.current.available).toBe(false);
    await ask(noWorkspace);

    const noEndpoint = engine({ endpoint: null });
    expect(noEndpoint.current.available).toBe(false);
    await ask(noEndpoint);

    // Neither minted a grant, and neither sent anything.
    expect(mockMintCalls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("an endpoint that is not a URL is nowhere to send a turn", () => {
    expect(engine({ endpoint: "not a url" }).current.available).toBe(false);
  });
});

describe("what is never kept", () => {
  /**
   * A source check, and it is the right shape for this rule: the failure it
   * guards against is a line somebody adds next year to save a round trip, and
   * no behavioural test of a hook that currently keeps nothing can see one
   * arrive. `structure.test.ts` in the control plane makes the same kind of
   * claim about credential fields for the same reason.
   */
  test("the token is never written to any store on the device", () => {
    const source = readFileSync(
      join(__dirname, "..", "features", "agent", "useAgentEngine.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const store of [
      "localStorage",
      "sessionStorage",
      "AsyncStorage",
      "SecureStore",
      "setItem",
      "indexedDB",
      "document.cookie",
    ]) {
      expect(code.includes(store) ? `the token reaches ${store}` : "").toBe("");
    }
  });
});
