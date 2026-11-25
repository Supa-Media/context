import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

/** Every string in a request as the model provider received it, so a lone surrogate anywhere is found. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

export default {
  id: "job-part-whole-characters",
  incident: "2026-11-24: every background job part in one person's chat failed with a 400 from every payer, six parts in a row, while the same job in a fresh chat ran; the failure said only \"status 400\".",
  cause: "A job's part reads its chat clipped at fixed lengths, and a clip can fall between the two halves of an emoji. The lone half went to the provider, which refuses the whole request as invalid JSON. Nothing kept why a round was refused.",
  path: "1:1 job part",
  // Sabotage (2026-11-24): sending `JSON.stringify(body)` in aiGateway.js instead of `wellFormedJson(body)` fails this case.
  async run() {
    const chat = await oneToOne();
    try {
      // Half an emoji, as a clip upstream leaves it.
      await chat.text("pick a dinner spot for friday \ud83d", "Sure, any cuisine in mind?");
      const job = { id: "job-replay-00002", title: "Friday dinner", brief: "Find two dinner spots for Friday", attempt: 1, followUps: [] };
      const part = await chat.jobPart("pick a dinner spot for friday", job, "Two spots for Friday.");
      assert.ok(part.requests.length > 0, "the job's part asked the model");
      const sent = part.requests.flatMap((request) => strings(request));
      assert.ok(sent.some((text) => text.includes("pick a dinner spot for friday")), "the chat reached the part");
      assert.ok(sent.every((text) => text.isWellFormed()), "no lone half of an emoji reaches the provider");
    } finally {
      chat.restore();
    }
  },
};
