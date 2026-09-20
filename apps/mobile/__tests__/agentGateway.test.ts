import { describe, expect, test } from "@jest/globals";
import {
  agentEndpoint,
  agentRequest,
  providerLabel,
  readAnswer,
  refusalSentence,
} from "../features/agent/gateway";
import type { AgentPage } from "../features/agent/page";

/**
 * WHAT LEAVES THE DEVICE WHEN SOMEBODY ASKS A QUESTION.
 *
 * `agentPage.test.ts` next door proves the console's *page* carries references
 * and never note text. This proves the same thing one layer out, at the wire —
 * and the two are not the same claim, which is the reason both exist.
 *
 * `page.ts` decides what the console knows about the room. This decides what
 * is sent. A field added to `AgentPage` for a purpose that never leaves the
 * device — a cached body for an offline read, the draft for a local diff —
 * would be carried onto the wire by a single `...place` and stopped by a build
 * that names every field it sends. So the test below plants a body on the page
 * and checks the request does not grow one.
 *
 * ## The other half: every failure is a sentence
 *
 * A panel with somebody waiting at it cannot throw. The gateway's refusals are
 * deliberately opaque — `model_unavailable` carries no reason, because a
 * provider's error body quotes the request that produced it — so this maps
 * status and code to something a person can act on, and everything else to one
 * honest sentence rather than an invented cause.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `agentRequest` built as `{ question, place: { ...place } }`, which is
 *     what somebody writes when the field list looks like ceremony.
 *     → **2 fail**: `nothing from the page rides along uninvited` and
 *     `a body on the page never reaches the wire`.
 *  2. `readAnswer` returning `body.answer` without the status check.
 *     → **1 fails**: `a refusal is never read as an answer`.
 *  3. `agentEndpoint` keeping the endpoint's path — `endpoint.replace("/mcp",
 *     "/agent")` — which is the obvious one-liner.
 *     → **1 fails**: `the context in the endpoint's path is dropped`.
 *  4. `providerLabel` defaulting to "Claude" rather than to a neutral word.
 *     → **1 fails**: `an unknown provider is not named`.
 */

const SENTINEL = "zarquon-plumbago-9471-the-note-body-and-never-the-wire";

function page(over: Partial<AgentPage> = {}): AgentPage {
  return {
    context: { slug: "seyi", personal: true, role: "owner" },
    note: {
      path: "1-projects/pricing.md",
      etag: "abc123",
      visibility: "team",
      readable: true,
      unsaved: true,
    },
    route: "/console/@seyi",
    meetingLive: false,
    query: null,
    ...over,
  } as AgentPage;
}

describe("what goes on the wire", () => {
  test("the place the gateway reads is the place that is sent", () => {
    const sent = agentRequest("what did we decide about pricing?", page());

    expect(sent.question).toBe("what did we decide about pricing?");
    expect(sent.place.context).toBe("seyi");
    expect(sent.place.note).toEqual({
      path: "1-projects/pricing.md",
      visibility: "team",
      readable: true,
      unsaved: true,
    });
    expect(sent.place.meetingLive).toBe(false);
  });

  /**
   * The build that stops a spread. Every field on the wire is named in
   * `agentRequest`, so a field added to the page for a local purpose stays
   * local until somebody decides otherwise in a diff a reviewer reads.
   */
  test("nothing from the page rides along uninvited", () => {
    const sent = agentRequest("hi", page({ route: "/console/@seyi" } as never));

    expect(Object.keys(sent).sort()).toEqual(["place", "question"]);
    expect(Object.keys(sent.place).sort()).toEqual(["context", "meetingLive", "note"]);
    expect(Object.keys(sent.place.note!).sort()).toEqual([
      "path",
      "readable",
      "unsaved",
      "visibility",
    ]);
    // The route is a fact about this app's navigation, not about the context,
    // and the gateway has no use for it.
    expect(JSON.stringify(sent)).not.toContain("/console/");
  });

  /**
   * The optimisation that must never land, tested the way `agentPage.test.ts`
   * tests it: a sentinel planted anywhere in the page, searched for at any
   * depth under any field name in what is sent.
   */
  test("a body on the page never reaches the wire", () => {
    const withBody = page({
      note: {
        path: "1-projects/pricing.md",
        etag: "abc123",
        visibility: "team",
        readable: true,
        unsaved: true,
        // The field a well-meaning optimisation adds.
        body: SENTINEL,
      },
      draft: SENTINEL,
      cached: { text: SENTINEL },
    } as never);

    expect(JSON.stringify(agentRequest("hi", withBody))).not.toContain(SENTINEL);
  });

  test("an empty room is still a valid question", () => {
    const sent = agentRequest("hi", null);
    expect(sent.place).toEqual({ context: null, note: null, meetingLive: false });
  });

  test("a live meeting is carried, because it changes what a good answer is", () => {
    expect(agentRequest("hi", page({ meetingLive: true })).place.meetingLive).toBe(true);
  });
});

describe("where the turn is sent", () => {
  test("the route is derived from the endpoint the console already shows", () => {
    expect(agentEndpoint("https://mcp.context.test/mcp")).toBe(
      "https://mcp.context.test/agent",
    );
  });

  /**
   * The console's grant is minted for one workspace, so the token names the
   * context. A slug in the path would be a second answer to the same question,
   * and the gateway would have to pick — which is the shape `openStorageBinding`
   * refuses for a workspace id.
   */
  test("the context in the endpoint's path is dropped", () => {
    expect(agentEndpoint("https://mcp.context.test/@seyi/mcp")).toBe(
      "https://mcp.context.test/agent",
    );
    expect(agentEndpoint("https://mcp.context.test/t/cat_token/mcp")).toBe(
      "https://mcp.context.test/agent",
    );
  });

  test("a port is kept, because a self-hoster's gateway has one", () => {
    expect(agentEndpoint("http://localhost:8787/mcp")).toBe("http://localhost:8787/agent");
  });

  test("something that is not a URL is nowhere to send a turn", () => {
    expect(agentEndpoint("")).toBeNull();
    expect(agentEndpoint("mcp.context.test/mcp")).toBeNull();
    expect(agentEndpoint("javascript:alert(1)")).toBeNull();
  });
});

describe("what comes back", () => {
  test("an answer is read, with the tools that ran", () => {
    const read = readAnswer(200, {
      answer: "You moved to $5 on 12 September.",
      provider: "anthropic",
      steps: [
        { tool: "search_notes", ok: true },
        { tool: "read_note", ok: false },
      ],
    });

    expect(typeof read).not.toBe("string");
    expect((read as { answer: string }).answer).toContain("12 September");
    expect((read as { steps: unknown[] }).steps).toEqual([
      { tool: "search_notes", ok: true },
      { tool: "read_note", ok: false },
    ]);
  });

  test("a refusal is never read as an answer", () => {
    // A 502 whose body happens to carry an `answer` key — a proxy's error
    // page, a gateway on a build that answers differently. The status decides.
    const read = readAnswer(502, { answer: "here you go", error: "model_unavailable" });
    expect(typeof read).toBe("string");
    expect(read).toContain("did not answer");
  });

  test("an answer that is not a string is a failure, not an empty panel", () => {
    for (const body of [{}, { answer: "" }, { answer: "   " }, { answer: 7 }, null, []]) {
      expect(typeof readAnswer(200, body)).toBe("string");
    }
  });

  test("a step that is not a step is dropped rather than rendered", () => {
    const read = readAnswer(200, {
      answer: "ok",
      steps: [{ tool: "read_note" }, { name: "nope" }, "read_note", null],
    });
    expect((read as { steps: unknown[] }).steps).toEqual([{ tool: "read_note", ok: true }]);
  });
});

describe("what somebody is told when it does not work", () => {
  test("no model connected says where to connect one", () => {
    expect(refusalSentence(409, "no_provider")).toContain("Settings");
    expect(refusalSentence(409, "no_provider")).toContain("Anthropic");
  });

  test("an expired connection says to reload rather than blaming the model", () => {
    expect(refusalSentence(401, null)).toContain("Reload");
    expect(refusalSentence(403, null)).toContain("Reload");
  });

  /**
   * The gateway's own refusals carry no reason on purpose. Inventing one here
   * would be inventing it, so everything unmapped gets one honest sentence.
   */
  test("everything else is one honest sentence and never a guess", () => {
    for (const status of [418, 500, 504, 0]) {
      const sentence = refusalSentence(status, null);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.toLowerCase()).not.toContain("anthropic");
      expect(sentence.toLowerCase()).not.toContain("openai");
    }
  });

  test("no refusal names a status code or an error code at somebody", () => {
    for (const [status, code] of [
      [401, null],
      [409, "no_provider"],
      [502, "model_unavailable"],
      [500, "server_error"],
    ] as [number, string | null][]) {
      const sentence = refusalSentence(status, code);
      expect(sentence).not.toContain(String(status));
      if (code !== null) expect(sentence).not.toContain(code);
    }
  });
});

describe("what the panel calls it", () => {
  test("a connected provider is named the way a person names it", () => {
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("openai")).toBe("GPT");
  });

  /**
   * Before a turn has answered, the console does not know which provider is
   * connected. A header that guesses is wrong for half the people reading it.
   */
  test("an unknown provider is not named", () => {
    expect(providerLabel("")).toBe("Your model");
    expect(providerLabel("ollama")).toBe("Your model");
  });
});
