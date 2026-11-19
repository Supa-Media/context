import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const TITLE = "Compare oven vendors";
const PAGE = "projects/oven-vendors/comparison.page.md";
const REPORT = {
  title: TITLE,
  state: "done",
  texts: [`Page written: ${PAGE}. Key fact: Hearthline is $4,200 installed, cheapest of three. Present to Marisol.`],
};

export default {
  id: "present-finished-job",
  incident:
    "2026-11-19: a finished job's report reached its coordinator turn, which answered with a question about which vendor to pick and started a new job to check warranties, instead of presenting the page the job had written.",
  cause:
    "A job_report turn had no code check: nothing refused a new background job on a finished job's report, and a final answer with no page link or that opened with a question went out unchecked.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      const answered = await chat.byCode(
        `Your background job "${TITLE}" reported back to you.`,
        [
          { toolCalls: [{ name: "start_background_job", args: { title: "Check oven warranties", brief: "Compare warranties" } }] },
          { text: "Which vendor do you want?" },
          { text: `Hearthline is cheapest at $4,200 installed: ${PAGE}` },
        ],
        { event: "job_report", jobReport: REPORT, running: [] },
      );
      assert.match(answered.shown, /Not started: this turn is a finished job's report/, "the job start is refused once, with its error text");
      assert.match(answered.shown, /Before this goes: the job finished/, "the question answer is sent back once with a notice");
      assert.match(answered.answer, /\$4,200/, "the reply names the price");
      assert.ok(answered.answer.includes(PAGE), "the reply links the page");
      assert.doesNotMatch(answered.answer.trimStart(), /^(\?|which |what |do |would |should )/i, "the reply does not open with a question");
      assert.equal(answered.body.jobs, undefined, "no job was started");
    } finally {
      chat.restore();
    }
  },
};
