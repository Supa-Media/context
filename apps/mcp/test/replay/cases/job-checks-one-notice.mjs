import assert from "node:assert/strict";
import { claimCheck } from "../../../src/agent/claimCheck.js";

/** A job's part that looked things up on the web and wrote its findings out as a long wall of words, with no figures. */
const WALL = Array.from({ length: 14 }, (_, at) => `Finding ${at + 1} is that the staffing report for the week shows no rows and the sign-in still works.`).join(" ");
const web = { tools: [{ name: "search_web" }, { name: "browse" }], call: async () => ({ content: [{ type: "text", text: "results" }] }) };

export default {
  id: "job-checks-one-notice",
  incident: "2026-11-17: a background job's parts were each sent back three times in a row (make it a page, then that's an essay, then one casual line), the third send-back crashed the part, and its answer was lost ten times.",
  cause: "The code checks ran as a chain where the first to fire won and the rest waited for the rewrite, and style checks blocked a job's answer just like a false claim did, so each draft earned one more round and the notices contradicted each other.",
  path: "background job part",
  async run() {
    // A job's draft that only has shape advice goes as it is: no round for "make it a page" or "that's an essay".
    const job = claimCheck({ question: "check the timecards report", job: { id: "job-replay-0001" } });
    await job.wrapWeb(web).call("search_web", { query: "timecards" });
    assert.equal(await job.check(WALL), null, "a job's part is never held for advice alone");

    // A draft with two false things on it goes back once, with both, and the rewrite is not sent back again.
    const both = claimCheck({ question: "check the timecards report", job: { id: "job-replay-0002" } });
    await both.wrapWeb(web).call("search_web", { query: "timecards" });
    const draft = `${WALL} I've added it to your notes. Can you check the site and forward me the report?`;
    const notice = await both.check(draft);
    assert.match(String(notice), /^Before this goes, check 2 things/, "every finding in one notice");
    assert.ok(!/that's an essay/.test(notice), "never a page and an essay notice together");
    assert.equal(await both.check(draft), null, "and nothing goes back a second time");
  },
};
