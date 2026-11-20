import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const JOB = { id: "job-replay-venues", title: "Venue shortlist", brief: "Three venues for 40 people in March, with prices.", doneWhen: "three venues priced", attempt: 1, followUps: [] };
const systemOf = (request) => JSON.stringify(request?.system ?? null);

export default {
  id: "job-part-cache-stable",
  incident: "2026-11-13 to 2026-11-20: a background job's thread note changed between 12 of 13 consecutive parts, so each new part wrote its whole history back to the prompt cache; a job report did the same on every coordinator turn.",
  cause: "The job's per-part lines (attempt, advisor's advice, follow-up texts, last draft) and the job report were said in the cached system prompt, above the history, instead of in the turn after it.",
  path: "background job parts",
  async run() {
    const chat = await oneToOne();
    try {
      const first = await chat.jobPart("find venues for the offsite", JOB, "Two venues so far: Harbor Hall and the Mill.");
      const second = await chat.jobPart(
        "find venues for the offsite",
        { ...JOB, attempt: 2, advice: "Price the third venue before reporting.", followUps: ["keep it under $3k"], draft: "Two venues so far: Harbor Hall and the Mill.", unfinished: true },
        "Three venues: Harbor Hall $2.4k, the Mill $2.8k, Pier 9 $2.9k.",
      );
      const a = first.requests[0];
      const b = second.requests[0];
      assert.ok(a && b, "each part asked the model");
      assert.match(systemOf(b), /Three venues for 40 people in March/, "the plan stays in the cached system prompt");
      assert.equal(systemOf(b), systemOf(a), "a new part sends the same system prompt as the part before it, so the cache is read, not rewritten");
      assert.match(second.shown, /Price the third venue before reporting[^]*keep it under \$3k[^]*Two venues so far/, "the advice, their later text and the last draft still reach the model, in its turn");
      assert.doesNotMatch(systemOf(b), /Price the third venue|keep it under|You already worked on this/, "none of them in the cached system prompt");
    } finally {
      chat.restore();
    }
  },
};
