import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const PORTAL = "https://portal.example.com/Default.aspx";

export default {
  id: "job-sees-chat",
  incident:
    "2026-11-12: a job planned an outing from its brief alone and dropped the person's own \"maybe karaoke, something fun\" from the texts before the ask (#3193); a job's part read nothing of the chat (one record per chat, step 3, 2026-11-13). " +
    "2026-11-16: a job on an old vendor portal read a page as \"(no text)\" with nothing to press, though its menus were all there a minute later, and wandered the menus. " +
    "2026-11-17: a timecards job's every part died in its answer checks' send-back loop, and ten parts each redid the same email search, sign-in, picture and email draft.",
  cause:
    "A job's part was shown only its brief and the texts that started it, never the chat it was started from. Its browser waited at most 3 s for a page to settle, so a slow page was read blank and shown as empty. " +
    "A part that broke handed on only step names (`cutOff`): nothing it found, nothing held for the person's yes, and not its draft.",
  path: "1:1 job part",
  async run() {
    const chat = await oneToOne();
    const restoreBrowser = chat.world.env.SITE_SHOTS;
    try {
      await chat.text("for saturday i'm thinking bowling, or maybe a cooking class", "Both fun. Want me to look into options?");
      await chat.text("yes find a couple near me", "On it: Saturday plans.");
      const job = { id: "job-replay-00001", title: "Saturday plans", brief: "Find a couple of Saturday activities near them", attempt: 1, followUps: [] };
      const part = await chat.jobPart("yes find a couple near me", job, "Two options for Saturday.");
      assert.match(part.shown, /bowling, or maybe a cooking class/, "the job's part is shown the chat it was started from, their own earlier words included");
      assert.match(part.shown, /Find a couple of Saturday activities near them/, "beside its brief");

      // A job's browser asks the screenshot Worker to wait long for a page that reads blank, and a page still blank is loading, not empty.
      const asked = [];
      chat.world.env.SITE_SHOTS = {
        async fetch(_url, init) {
          const body = JSON.parse(init.body);
          asked.push(body);
          if (body.provider === "browserbase") return new Response(JSON.stringify({ error: "no key" }), { status: 501 });
          return Response.json({ session: "cf-replay-0001", ran: body.steps.map((s) => ({ do: s.do, ok: true })), page: { url: PORTAL, title: "Portal", text: "", elements: [], loading: 75 } });
        },
      };
      const report = { id: "job-replay-00002", title: "Weekly report", brief: `Get last week's report from ${PORTAL}`, attempt: 1, followUps: [] };
      const slow = await chat.jobPart(`get last week's report from ${PORTAL}`, report, [
        { toolCalls: [{ name: "browse", args: { steps: [{ do: "goto", url: PORTAL }] } }] },
        { text: "The portal is still loading; I'll wait and read it again." },
      ]);
      const opened = asked.find((body) => Array.isArray(body.steps) && body.steps.some((s) => s.do === "goto"));
      assert.ok(opened, "the job opened the portal in its browser");
      assert.ok(opened.waitMs >= 60_000, "a job's browser waits a minute or more for a blank page");
      assert.match(slow.shown, /still loading after 75 seconds/, "a page still blank is said to be loading");
      assert.doesNotMatch(slow.shown, /\(no text\)/, "never read as an empty page");

      // A part after one that broke starts from what it saved: each call's return, what waits on their yes, its last draft (`jobSaved.js`).
      const timecards = {
        id: "job-replay-00003",
        title: "Timecards",
        brief: "Check this week's timecards and email the boss a summary",
        attempt: 2,
        followUps: [],
        saved: {
          calls: [
            { part: 1, step: "browse: timecards.example.com", result: "Signed in. This week: 0 rows." },
            { part: 1, step: "send email to boss@example.com", held: true, result: "Held for their yes: the email to boss@example.com" },
          ],
          draft: "No timecard rows this week; the sign-in works.",
        },
      };
      chat.world.env.SITE_SHOTS = restoreBrowser;
      const resumed = await chat.jobPart("check this week's timecards and email my boss", timecards, "No timecard rows this week; the email waits on your yes.");
      assert.match(resumed.shown, /already made these calls/, "the next part is told what the last one already got");
      assert.match(resumed.shown, /Signed in\. This week: 0 rows\./, "with what each call returned, not only its name");
      assert.match(resumed.shown, /HELD for their yes[\s\S]*don't make it again/, "and not to make the held email again");
      assert.match(resumed.shown, /wrote this draft before it ended, never sent/, "and the draft its checks never let go, to start from");
    } finally {
      chat.world.env.SITE_SHOTS = restoreBrowser;
      chat.restore();
    }
  },
};
