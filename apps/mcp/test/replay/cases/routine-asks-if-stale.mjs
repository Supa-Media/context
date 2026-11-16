import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "routine-asks-if-stale",
  incident: "2026-11-16: Dev2 saw routines go through Tex as if they were texts the person had sent, so a routine nobody answered any more kept texting, with nothing telling the Front door it was a routine or that its texts went unanswered.",
  cause: "A routine's run went through the Door as a text and was told nothing of its own past runs or whether the person still answered them, so it could not judge whether it was stale or ask whether to keep it.",
  path: "1:1 routine",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("remind me to water the ferns every morning", "Will do, every morning.");
      const day = 24 * 60 * 60_000;
      // Live Tex's config: the routine still goes through the door, told nothing of its standing, word for word as before.
      chat.wait(day);
      const live = await chat.routine("routines/daily/brief.md", "Water the ferns.");
      assert.match(live.shown, /This is a scheduled routine, not a text from a person/);
      assert.doesNotMatch(live.shown, /gone stale/, "live Tex is unchanged until the draft is promoted");
      // Its runs go on texting, unanswered, still told nothing of it on live Tex's config.
      for (let i = 0; i < 3; i += 1) {
        chat.wait(day);
        assert.doesNotMatch((await chat.routine("routines/daily/brief.md", "Water the ferns.")).shown, /still want this routine/);
      }
      // On the simpler graph's draft, as a Lab test chat runs it, the run is told its standing and asks whether to keep
      // it: `routineAsRoutine.test.mjs` (the routine's node and wires) and `routineEngagement.test.mjs` (the question it
      // reads, from the real `routineRunQuestion`). A test chat's gate refuses this fixture's tokens, so it is not run here.
    } finally {
      chat.restore();
    }
  },
};
