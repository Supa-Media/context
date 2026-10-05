import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index";
import { DEFAULT_WRITING_MODEL, MAX_EXTRACT_BODY_BYTES, WRITING_MODELS, readExtractRequest, readOutput } from "./extract";
import { CALLER, SECRET, envWith, fakeAi } from "./worker/fixtures";

/**
 * `POST /extract`: instructions, one piece of text and the shape of the
 * answer in, an answer of that shape out, nothing kept. "What changed" reads
 * the inbox with it — see docs/decisions/storage-and-credentials/inference.md.
 */

const TEXT = "Meeting, Friday. We parted ways with Dana Reyes. Sam takes over the onboarding emails.";
const INSTRUCTIONS = "List what changed in this business. Quote the sentence that says so.";
const SCHEMA = {
  type: "object",
  properties: { changes: { type: "array", items: { type: "object", properties: { headline: { type: "string" } } } } },
  required: ["changes"],
};
const OUTPUT = { changes: [{ headline: "Dana Reyes has left" }] };

const ANSWER = {
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(OUTPUT) } }],
  usage: { prompt_tokens: 410, completion_tokens: 96, total_tokens: 506 },
};

function extract(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worker.test/extract", {
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

const BODY = { instructions: INSTRUCTIONS, text: TEXT, schema: SCHEMA };

describe("POST /extract", () => {
  it("asks the writing model for an answer of the given shape, and returns it with the token counts", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(extract(BODY), envWith(ai.binding));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: OUTPUT, usage: { input: 410, output: 96 } });
    expect(ai.calls).toHaveLength(1);
    const call = ai.calls[0] as { model: string; input: Record<string, unknown> };
    expect(call.model).toBe(WRITING_MODELS[DEFAULT_WRITING_MODEL]);
    expect(call.input.messages).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: TEXT },
    ]);
    expect(call.input.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: SCHEMA, strict: true },
    });
  });

  it("uses the other allowed model only when asked by its short name", async () => {
    const ai = fakeAi(ANSWER);
    await handleRequest(extract({ ...BODY, model: "glm" }), envWith(ai.binding));
    expect(ai.calls[0]?.model).toBe(WRITING_MODELS.glm);
  });

  it("refuses a model that is not on the list, before spending anything", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(extract({ ...BODY, model: "@cf/meta/llama-2-7b-chat-fp16" }), envWith(ai.binding));
    expect(response.status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses without the secret, before reading anything or spending inference", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(extract(BODY, { authorization: "Bearer wrong" }), envWith(ai.binding));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses a request with no caller identifier", async () => {
    const ai = fakeAi(ANSWER);
    const response = await handleRequest(extract(BODY, { "x-caller-hash": "" }), envWith(ai.binding));
    expect(response.status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses an oversized body while it arrives", async () => {
    const ai = fakeAi(ANSWER);
    const huge = "x".repeat(MAX_EXTRACT_BODY_BYTES + 1);
    const response = await handleRequest(extract({ ...BODY, text: huge }), envWith(ai.binding));
    expect(response.status).toBe(413);
    expect(ai.calls).toHaveLength(0);
  });

  it("says Workers AI is not bound rather than throwing", async () => {
    const response = await handleRequest(extract(BODY), envWith(undefined));
    expect(response.status).toBe(500);
  });

  it("answers 502 when the model fails, and never echoes the text", async () => {
    const ai = fakeAi(new Error(`upstream said: ${TEXT}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handleRequest(extract(BODY), envWith(ai.binding));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Dana");
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain("Dana");
    log.mockRestore();
  });

  it("answers 502 when the model's answer is not a JSON object, and never echoes it", async () => {
    const ai = fakeAi({ choices: [{ message: { content: "Dana Reyes left, I think." } }] });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handleRequest(extract(BODY), envWith(ai.binding));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Dana");
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain("Dana");
    log.mockRestore();
  });

  it("never logs the text, the instructions or the answer on success", async () => {
    const ai = fakeAi(ANSWER);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleRequest(extract(BODY), envWith(ai.binding));
    expect(log).toHaveBeenCalled();
    for (const call of log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain("Dana");
      expect(line).not.toContain("Quote the sentence");
    }
    log.mockRestore();
  });

  it("is an exact path", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/extract/more", { method: "POST" }),
      envWith(fakeAi(ANSWER).binding),
    );
    expect(response.status).toBe(404);
  });
});

describe("readExtractRequest", () => {
  it("accepts instructions, text and an object schema, with an optional model", () => {
    expect(readExtractRequest(BODY).ok).toBe(true);
    expect(readExtractRequest({ ...BODY, model: "gemma" }).ok).toBe(true);
  });

  it.each([
    ["no text", { instructions: INSTRUCTIONS, schema: SCHEMA }],
    ["empty text", { ...BODY, text: "" }],
    ["no instructions", { text: TEXT, schema: SCHEMA }],
    ["a schema that is not an object type", { ...BODY, schema: { type: "string" } }],
    ["a schema that is an array", { ...BODY, schema: [] }],
    ["an extra key", { ...BODY, temperature: 2 }],
    ["an unknown model", { ...BODY, model: "llama" }],
  ])("refuses %s", (_label, body) => {
    expect(readExtractRequest(body).ok).toBe(false);
  });
});

describe("readOutput", () => {
  it("reads the chat shape, the older `response` shape, and a fenced answer", () => {
    expect(readOutput(ANSWER)).toEqual({ output: OUTPUT, usage: { input: 410, output: 96 } });
    expect(readOutput({ response: OUTPUT })).toEqual({ output: OUTPUT, usage: { input: 0, output: 0 } });
    expect(readOutput({ response: JSON.stringify(OUTPUT) })?.output).toEqual(OUTPUT);
    const fenced = { choices: [{ message: { content: "```json\n" + JSON.stringify(OUTPUT) + "\n```" } }] };
    expect(readOutput(fenced)?.output).toEqual(OUTPUT);
  });

  it("reads nothing from a list, a string, or nothing", () => {
    expect(readOutput({ choices: [{ message: { content: "[1,2]" } }] })).toBeNull();
    expect(readOutput({ choices: [{ message: { content: "" } }] })).toBeNull();
    expect(readOutput(null)).toBeNull();
    expect(readOutput({ choices: [] })).toBeNull();
  });
});

describe("readOutput, for models that think out loud", () => {
  it("reads the answer after a thinking block, or from inside prose", () => {
    const thought = { choices: [{ message: { content: `<think>Dana left, so…</think>\n${JSON.stringify(OUTPUT)}` } }] };
    expect(readOutput(thought)?.output).toEqual(OUTPUT);
    const wrapped = { choices: [{ message: { content: `Here is the answer: ${JSON.stringify(OUTPUT)} Hope that helps.` } }] };
    expect(readOutput(wrapped)?.output).toEqual(OUTPUT);
  });
});
