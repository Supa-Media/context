/**
 * Website jobs go to the thinking model (owner, 2026-10-11).
 *
 * On a live "connect my ChatGPT" Tex on the cheap model resent its last
 * message when asked "what am I seeing here" and never checked the page. The
 * router now names jobs done on a website, and replies in the middle of one,
 * as `think`, and reads the earlier turns so a bare "done" is seen as part of
 * the job.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTier } from "../src/agent/router.js";

test("the router's question names website jobs and replies in the middle of one as think", async () => {
  let asked = null;
  await pickTier({
    decide: async (_state, questions) => {
      asked = questions;
      return { tier: { choice: "think", confidence: 0.9 } };
    },
    text: "done",
  });
  assert.match(asked.tier.instructions, /job done on a website/);
  assert.match(asked.tier.instructions, /in the middle of such a job/);
  assert.match(asked.tier.criteria.think, /job on a website/);
});

test("a mid-job reply is read with the turns before it", async () => {
  let state = "";
  const result = await pickTier({
    decide: async (s) => {
      state = s;
      return { tier: { choice: "think", confidence: 0.8 } };
    },
    text: "what am i seeing here",
    history: [
      { role: "person", text: "connect my ChatGPT" },
      { role: "assistant", text: "Open this to take over the browser on chatgpt.com" },
    ],
  });
  assert.match(state, /connect my ChatGPT/);
  assert.match(state, /Person \(now\): what am i seeing here/);
  assert.equal(result.tier, "think");
});
