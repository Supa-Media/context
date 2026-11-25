import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { groupChat } from "../chats.mjs";

const require = createRequire(import.meta.url);
const { chatLookQuestion } = require("../../../../../packages/shared/src/groupRunQuestions.cjs");

// `running`: the jobs the Worker says are running in the chat, as it sends on every turn; none here.
const checkIn = { group: { people: ["ada", "bo"], cause: "check_in" }, body: { running: [] } };
const started = {
  toolCalls: [
    {
      name: "start_background_job",
      args: { title: "Look at the shared calendars", brief: "Read Bo's calendar for the week and hold it against the chat's plans.", say: "My lookups keep timing out, so I've set a job to check them fresh." },
    },
  ],
};

export default {
  id: "checkin-job-unasked-quiet",
  incident:
    "2026-11-25 10:00 AM ET, Tex Devs: the chat's own check-in tried a mail search a chat with no shared mail is never given, told the chat \"my mail and calendar lookups keep timing out, so I've set a job\", and the job then posted \"I couldn't search Seyi's Gmail\". Nobody had asked for anything.",
  cause:
    "The check-in's words always asked for a mail search, shared mail or not; a job started from any turn texted its start line; and an ended job's report was always texted, so a look nobody asked for spoke twice.",
  path: "a group check-in that starts a background job",
  async run() {
    // A chat with no mail shared is never asked to search mail.
    const none = chatLookQuestion(1_790_000_000_000, "Sep 21, 2:13 PM UTC", { mail: false });
    assert.doesNotMatch(none, /mail shared with this chat|after:/, "no mail search when none is shared");
    assert.match(chatLookQuestion(1_790_000_000_000, "Sep 21, 2:13 PM UTC", { mail: true }), /mail shared with this chat \(search it with after:1790000000\)/);

    const chat = await groupChat();
    try {
      // The check-in hands work to a job: the chat is told nothing, and the job carries that nobody asked.
      const look = await chat.tag("ada", none, [started], [], checkIn);
      assert.equal(look.answer, "", "the start line is never texted from a check-in");
      assert.equal(look.body.quiet, true, "the turn says quiet as a flag");
      assert.equal(look.body.jobs?.[0]?.unasked, true, "the Worker is told the job came from a look nobody asked for");

      // Its report, with nothing anyone here needs, stays quiet.
      const report = { title: "Look at the shared calendars", state: "done", texts: ["Couldn't search Seyi's Gmail; calendars look clear."], unasked: true };
      const quiet = await chat.tag("ada", none, [{ toolCalls: [{ name: "say_nothing", args: { why: "nothing needs the chat" } }] }], [], {
        group: { people: ["ada", "bo"], cause: "job_report" },
        body: { event: "job_report", jobReport: report, running: [] },
      });
      assert.equal(quiet.answer, "", "an unasked job's empty report is never texted");
      assert.match(quiet.shown, /Nobody asked for this job/, "the report's turn is told nobody asked for it");

      // A job somebody asked for still says its start line, and its ended report still always reaches them.
      const asked = await chat.tag("ada", "Tex check Bo's calendar this week", [started], [], { tagged: true, group: { people: ["ada", "bo"], cause: "tagged" }, body: { running: [] } });
      assert.match(asked.answer, /set a job/, "a job they asked for still says it started");
      assert.notEqual(asked.body.jobs?.[0]?.unasked, true);
    } finally {
      chat.restore();
    }
  },
};
