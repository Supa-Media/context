import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "job-starts-from-saved",
  incident:
    "2026-11-17: a timecards job's every part died in its answer checks' send-back loop, and each next part was told only the names of the steps the last one took. " +
    "Ten parts each redid the same email search, sign-in, picture and email draft, then the job failed with nothing sent.",
  cause:
    "A part that broke handed on only step names (`cutOff`): nothing it found, nothing held for the person's yes, and not the draft its checks kept sending back. Every part started over.",
  path: "1:1 job part",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("check this week's timecards and email my boss the summary", "On it: Timecards.");
      const job = {
        id: "job-replay-00003",
        title: "Timecards",
        brief: "Check this week's timecards and email the boss a summary",
        attempt: 2,
        followUps: [],
        saved: {
          calls: [
            { part: 1, step: "search mail: timecards", result: "2 emails from payroll, Nov 14 and Nov 15" },
            { part: 1, step: "browse: timecards.example.com", result: "Signed in. This week: 0 rows." },
            { part: 1, step: "send email to boss@example.com", held: true, result: "Held for their yes: the email to boss@example.com, subject Timecards" },
          ],
          draft: "No timecard rows this week; the sign-in works. The email to your boss is waiting on your yes.",
        },
      };
      const part = await chat.jobPart("check this week's timecards and email my boss the summary", job, "No timecard rows this week; the email to your boss is waiting on your yes.");
      assert.match(part.shown, /already made these calls/, "the next part is told what the last one already got");
      assert.match(part.shown, /Signed in\. This week: 0 rows\./, "with what each call returned, not only its name");
      assert.match(part.shown, /HELD for their yes/, "and the email it held for their yes");
      assert.match(part.shown, /don't make it again/, "which it is told not to make again");
      assert.match(part.shown, /wrote this draft before it ended, never sent/, "and the draft its checks never let go, to start from");
    } finally {
      chat.restore();
    }
  },
};
