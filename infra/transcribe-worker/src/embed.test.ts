import { describe, expect, it } from "vitest";
import { handleRequest } from "./index";
import { EMBED_DIMENSIONS, EMBED_MODEL, MAX_EMBED_TEXTS, MAX_EMBED_TEXT_CHARS, readEmbedRequest } from "./embed";
import { CALLER, SECRET, envWith, fakeAi } from "./worker/fixtures";

/**
 * `POST /embed`: a few short texts in, their meaning fingerprints out, nothing
 * kept. The icon picker's suggestion by meaning — see ./embed.ts.
 */

const vector = (fill: number) => Array<number>(EMBED_DIMENSIONS).fill(fill);

function embed(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worker.test/embed", {
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

describe("POST /embed", () => {
  it("asks the model and answers with one fingerprint per text", async () => {
    const ai = fakeAi({ shape: [2, EMBED_DIMENSIONS], data: [vector(0.1), vector(0.2)] });
    const response = await handleRequest(embed({ texts: ["taxes", "garden"] }), envWith(ai.binding));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vectors: [vector(0.1), vector(0.2)] });
    expect(ai.calls).toEqual([{ model: EMBED_MODEL, input: { text: ["taxes", "garden"] } }]);
  });

  it("refuses without the secret, before spending inference", async () => {
    const ai = fakeAi({ data: [vector(0.1)] });
    const response = await handleRequest(embed({ texts: ["taxes"] }, { authorization: "Bearer wrong" }), envWith(ai.binding));
    expect(response.status).toBe(401);
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses a request with no caller", async () => {
    const ai = fakeAi({ data: [vector(0.1)] });
    const response = await handleRequest(embed({ texts: ["taxes"] }, { "x-caller-hash": "" }), envWith(ai.binding));
    expect(response.status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("an answer of the wrong shape is a 502 that quotes nothing", async () => {
    const ai = fakeAi({ data: [vector(0.1).slice(1)] });
    const response = await handleRequest(embed({ texts: ["my secret folder"] }), envWith(ai.binding));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });

  it("a model error is a 502 that quotes nothing", async () => {
    const ai = fakeAi(new Error("could not embed: my secret folder"));
    const response = await handleRequest(embed({ texts: ["my secret folder"] }), envWith(ai.binding));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
  });

  it("only a short list of short texts is a request", () => {
    expect(readEmbedRequest({ texts: ["taxes"] })).toEqual(["taxes"]);
    expect(readEmbedRequest({ texts: [] })).toBeNull();
    expect(readEmbedRequest({ texts: [" "] })).toBeNull();
    expect(readEmbedRequest({ texts: [7] })).toBeNull();
    expect(readEmbedRequest({ texts: "taxes" })).toBeNull();
    expect(readEmbedRequest({ texts: ["x".repeat(MAX_EMBED_TEXT_CHARS + 1)] })).toBeNull();
    expect(readEmbedRequest({ texts: Array(MAX_EMBED_TEXTS + 1).fill("x") })).toBeNull();
    expect(readEmbedRequest({ texts: Array(MAX_EMBED_TEXTS).fill("x") })).toHaveLength(MAX_EMBED_TEXTS);
  });
});
