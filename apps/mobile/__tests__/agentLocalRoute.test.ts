/**
 * Choosing the road a question takes.
 *
 * Two roads answer the same question: the gateway, which spends the API key the
 * customer pasted into Settings → Model, and the `claude` on this machine,
 * which spends the subscription they already pay for. This file is about which
 * one is taken and what crosses to it — never about what either one answers.
 *
 * The property that matters most here is the one that is easiest to lose: both
 * roads build their payload with the **same** `agentRequest`, so the rule that
 * note text never leaves the device is held in one place. A second shape for
 * the local road would be a second leak, reachable only on machines that happen
 * to have a CLI installed — the worst distribution a bug of that kind could
 * have.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing checks:
 *
 *   `localRouteFrom` checking the bridge instead of the `agent` member         2
 *   the local road spreading the page instead of calling `agentRequest`        1
 *   `preferLocal` returning false when a CLI is there                          1
 *   `providerLabel("claude-code")` falling through to "Your model"             1
 *
 * All four predictions held.
 *
 * ## The rule that was a comment
 *
 * *A failed local ask must not fall through to the gateway.* It lived inside
 * `useAgentEngine`'s `ask` as control flow, where nothing could reach it, and
 * this file said so rather than pretending otherwise. It is `afterLocal` now —
 * pure, and checked below — for `capabilities.ts`'s reason: every guard
 * expressed inside a component in this app was held by nothing.
 *
 *   a local refusal falling through to the gateway                             1
 *   a thrown ask stopping the turn instead of falling through                  1
 *   `ok: true` with an empty answer being returned as the answer               1
 *
 * The first was predicted to fail 2 and fails 1. The counts in the desktop
 * suite are per *check*, and Jest's are per `it` — two assertions inside one
 * `it` are one failure. Corrected rather than the test split to match the
 * prediction, because the two assertions really are one rule.
 *
 */

import { describe, expect, it } from "@jest/globals";
import { EMPTY_LOCAL_ANSWER, afterLocal, localRouteFrom, preferLocal } from "../features/agent/local";
import { providerLabel } from "../features/agent/gateway";

const PAGE = {
  context: { slug: "seyi" },
  note: {
    path: "1-projects/pricing.md",
    visibility: "private",
    readable: true,
    unsaved: true,
    // Planted. `page.ts` promises this never exists; if it ever does, this
    // check is what stops it reaching a model through the local road.
    body: "SENTINEL-NOTE-TEXT",
  },
  meetingLive: false,
} as never;

describe("which road a question takes", () => {
  it("is the local one when the shell offers an agent", () => {
    const route = localRouteFrom({ agent: { ask: async () => ({ ok: true }) } } as never);
    expect(route).not.toBeNull();
    expect(preferLocal(route)).toBe(true);
  });

  it("is the gateway in a browser, where there is no bridge at all", () => {
    expect(localRouteFrom(null)).toBeNull();
    expect(preferLocal(null)).toBe(false);
  });

  it("is the gateway on a shell older than the agent member", () => {
    // MIN_BRIDGE_VERSION is 1: a shell from before this shipped is valid and
    // simply has no `agent`. That is the fallback, not an error.
    expect(localRouteFrom({ meetings: { write: async () => ({}) } } as never)).toBeNull();
  });

  it("is the gateway when the member is there but is not callable", () => {
    expect(localRouteFrom({ agent: { ask: "not a function" } } as never)).toBeNull();
  });

  it("sends the local road the same body the gateway gets, and no note text", async () => {
    let sent: unknown = null;
    const route = localRouteFrom({
      agent: {
        ask: async (request: unknown) => {
          sent = request;
          return { ok: true, answer: "ok", provider: "claude-code", steps: [] };
        },
      },
    } as never);

    await route!.ask({ question: "what did I decide about pricing?", place: PAGE });

    expect(JSON.stringify(sent)).not.toContain("SENTINEL-NOTE-TEXT");
    expect(sent).toEqual({
      question: "what did I decide about pricing?",
      place: {
        context: "seyi",
        note: { path: "1-projects/pricing.md", visibility: "private", readable: true, unsaved: true },
        meetingLive: false,
      },
    });
  });

  it("stops the turn on a local refusal, rather than spending the API key", () => {
    // The sentence names a fix on this machine. Falling through would spend
    // their key silently, moments after telling them the free road needed a
    // two-second fix — the one outcome this road exists to avoid.
    const next = afterLocal({ ok: false, message: "Claude Code is installed but not signed in." });
    expect(next.road).toBe("stop");
    expect(next).toHaveProperty("sentence", "Claude Code is installed but not signed in.");
  });

  it("falls through only when the shell went away, because nothing was spent or said", () => {
    expect(afterLocal(null)).toEqual({ road: "gateway" });
  });

  it("answers when there is one", () => {
    expect(afterLocal({ ok: true, answer: "usage-based", provider: "claude-code", steps: [] })).toEqual({
      road: "answer",
      answer: "usage-based",
      provider: "claude-code",
    });
  });

  it("stops on an ok with nothing in it, rather than paying twice for one turn", () => {
    const next = afterLocal({ ok: true, answer: "  ", provider: "claude-code", steps: [] });
    expect(next).toEqual({ road: "stop", sentence: EMPTY_LOCAL_ANSWER });
  });

  it("names the local road in the header, because which one answered matters", () => {
    expect(providerLabel("claude-code")).toBe("Claude Code");
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("")).toBe("Your model");
  });
});
