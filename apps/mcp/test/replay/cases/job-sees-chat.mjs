import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const PORTAL = "https://portal.example.com/Default.aspx";

export default {
  id: "job-sees-chat",
  incident:
    "2026-11-12: a job planned an outing from its brief alone and dropped the person's own \"maybe karaoke, something fun\" from the texts before the ask (#3193); a job's part read nothing of the chat (one record per chat, step 3, 2026-11-13). " +
    "2026-11-16: a job on an old vendor portal read a page as \"(no text)\" with nothing to press, though its menus were all there a minute later, and wandered the menus.",
  cause:
    "A job's part was shown only its brief and the texts that started it, never the chat it was started from. Its browser waited at most 3 s for a page to settle, so a slow page was read blank and shown as empty.",
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
    } finally {
      chat.world.env.SITE_SHOTS = restoreBrowser;
      chat.restore();
    }
  },
};
