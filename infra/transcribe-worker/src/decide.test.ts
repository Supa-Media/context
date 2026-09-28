import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index";
import { JEV_MODEL, MAX_DECIDE_BODY_BYTES, readDecideRequest } from "./decide";
import { CALLER, SECRET, envWith, fakeAi } from "./worker/fixtures";

/**
 * `POST /decide`: one piece of text and a handful of typed questions in,
 * typed answers out, nothing kept. The auto-organize sweep's only way to reach
 * Jev — see docs/decisions/storage-and-credentials/inference.md.
 */

const STATE = "Status: fix-in-review. Fix: Supa-Media/context#908. The PR merged two days ago.";

const QUESTIONS = {
  shipped: {
    type: "noul",
    instructions: "Does the note say the work shipped, merged or was fixed?",
    criteria: { true: "It says so", false: "It does not" },
  },
  stage: {
    type: "choice",
    instructions: "Where is this project?",
    criteria: { active: "Work is ongoing", done: "The work is finished", unclear: "Can't tell" },
  },
};

const ANSWER = {
  model: "jev-1.13.0",
  answers: {
    shipped: { type: "noul", noul: 0.93 },
    stage: {
      type: "choice",
      choice: "done",
      confidence: 0.8,
      probabilities: { active: 0.1, done: 0.85, unclear: 0.05 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

function decide(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worker.test/decide", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "x-caller-hash": CALLER,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /decide", () => {
  it("asks Jev and answers with the typed answers only", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(ai.binding));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      answers: {
        shipped: { type: "noul", noul: 0.93 },
        stage: {
          type: "choice",
          choice: "done",
          confidence: 0.8,
          probabilities: { active: 0.1, done: 0.85, unclear: 0.05 },
        },
      },
    });
    expect(ai.calls).toEqual([{ model: JEV_MODEL, input: { state: STATE, questions: QUESTIONS } }]);
  });

  it("refuses without the secret, before reading anything or spending inference", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(
      decide({ state: STATE, questions: QUESTIONS }, { authorization: "Bearer wrong" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses a request with no caller identifier", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(
      decide({ state: STATE, questions: QUESTIONS }, { "x-caller-hash": "" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses an oversized body while it arrives", async () => {
    const ai = fakeAi(ANSWER);
    const huge = "x".repeat(MAX_DECIDE_BODY_BYTES + 1);
    const response = await handleRequest(decide({ state: huge, questions: QUESTIONS }), envWith(ai.binding));
    expect(response.status).toBe(413);
    expect(ai.calls).toHaveLength(0);
  });

  it("says Workers AI is not bound rather than throwing", async () => {
    const response = await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(undefined));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "workers ai is not bound" });
  });

  it("answers 502 when Jev fails, and never echoes the note text", async () => {
    const ai = fakeAi(new Error(`upstream said: ${STATE}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(ai.binding));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("fix-in-review");
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain("fix-in-review");
    log.mockRestore();
  });

  it("answers 502 when Jev answers a choice that was not offered", async () => {
    const ai = fakeAi({
      answers: {
        shipped: { type: "noul", noul: 0.4 },
        stage: { type: "choice", choice: "launched", confidence: 0.9, probabilities: {} },
      },
    });
    const response = await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(ai.binding));
    expect(response.status).toBe(502);
  });

  it("answers 502 when an asked question is missing from the answer", async () => {
    const ai = fakeAi({ answers: { shipped: { type: "noul", noul: 0.4 } } });
    const response = await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(ai.binding));
    expect(response.status).toBe(502);
  });

  it("never logs the note text on success", async () => {
    const ai = fakeAi(ANSWER);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleRequest(decide({ state: STATE, questions: QUESTIONS }), envWith(ai.binding));
    expect(log).toHaveBeenCalled();
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain("fix-in-review");
      expect(String(call[0])).not.toContain("Where is this project");
    }
    log.mockRestore();
  });

  it("keeps /transcribe and /health where they were", async () => {
    const health = await handleRequest(new Request("https://worker.test/health"), envWith(fakeAi(ANSWER).binding));
    expect(health.status).toBe(200);
    const unknown = await handleRequest(
      new Request("https://worker.test/decide/extra", { method: "POST" }),
      envWith(fakeAi(ANSWER).binding),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("readDecideRequest", () => {
  it("accepts the three question types", () => {
    const parsed = readDecideRequest({
      state: "text",
      questions: {
        a: { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } },
        b: { type: "choice", instructions: "Which?", criteria: { x: "X", y: "Y" } },
        c: { type: "score", instructions: "How much?", criteria: ["none", "some", "lots"] },
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["no state", { questions: QUESTIONS }],
    ["empty state", { state: "", questions: QUESTIONS }],
    ["no questions", { state: "x", questions: {} }],
    ["too many questions", { state: "x", questions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, QUESTIONS.shipped])) }],
    ["bad name", { state: "x", questions: { "Bad Name": QUESTIONS.shipped } }],
    ["unknown type", { state: "x", questions: { a: { ...QUESTIONS.shipped, type: "essay" } } }],
    ["one-option choice", { state: "x", questions: { a: { type: "choice", instructions: "?", criteria: { only: "one" } } } }],
    ["noul without false", { state: "x", questions: { a: { type: "noul", instructions: "?", criteria: { true: "y" } } } }],
    ["score with one level", { state: "x", questions: { a: { type: "score", instructions: "?", criteria: ["one"] } } }],
    ["extra top-level key", { state: "x", questions: QUESTIONS, model: "@cf/other/model" }],
  ])("refuses %s", (_label, body) => {
    expect(readDecideRequest(body).ok).toBe(false);
  });
});
