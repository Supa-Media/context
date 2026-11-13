import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "job-sees-chat",
  incident: "2026-11-12: a job planned an outing from its brief alone and dropped the person's own \"maybe karaoke, something fun\" from the texts before the ask (#3193); a job's part read nothing of the chat (one record per chat, step 3, 2026-11-13).",
  cause: "A job's part was shown only its brief and the texts that started it, never the chat it was started from.",
  path: "1:1 job part",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("for saturday i'm thinking bowling, or maybe a cooking class", "Both fun. Want me to look into options?");
      await chat.text("yes find a couple near me", "On it: Saturday plans.");
      const job = { id: "job-replay-00001", title: "Saturday plans", brief: "Find a couple of Saturday activities near them", attempt: 1, followUps: [] };
      const part = await chat.jobPart("yes find a couple near me", job, "Two options for Saturday.");
      assert.match(part.shown, /bowling, or maybe a cooking class/, "the job's part is shown the chat it was started from, their own earlier words included");
      assert.match(part.shown, /Find a couple of Saturday activities near them/, "beside its brief");
    } finally {
      chat.restore();
    }
  },
};
