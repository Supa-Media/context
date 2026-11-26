import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const INVITE = {
  address: "ada@example.invalid",
  id: "invite-1",
  date: "Thu, 26 Nov 2026 16:35:00 +0000",
  from: "Rowan at Lantern Hall <rowan@example.invalid>",
  to: "ada@example.invalid",
  subject: "Lead our winter concert on Dec 6?",
  snippet: "We would love your choir to lead the concert at 4 PM. Could we talk Friday or Saturday morning?",
};

const FOUND = "- [today] Lantern Hall asks Ada's choir to lead its Dec 6 concert at 4 PM and wants a call Friday or Saturday morning · her email, 11:35 AM · offer to reply proposing Friday";
const placeholder = { toolCalls: [{ name: "say_nothing", args: { why: "placeholder" } }] };
const verdict = (speak, why) => ({ toolCalls: [{ name: "verdict", args: { speak, why } }] });

/** The words of the request whose system prompt is the Quiet check's. */
const quietShown = (ran) => ran.requests.map((body) => JSON.stringify(body?.messages ?? [])).find((_, i) => JSON.stringify(ran.requests[i]?.system ?? "").includes("You are the Quiet check in Tex")) ?? "";

export default {
  id: "checkin-muted-not-silence",
  incident:
    "2026-11-26, a Lab check-in: the look found an invite worth a text and planned one, but first called say_nothing with the reason \"placeholder\" for a topic they had muted. " +
    "That call ends the look, and the Quiet check let the silence stand, judging mail the person had muted and never the invite.",
  cause:
    "The muted line said \"for anything about them, call send with action say_nothing\", which read as one call per muted item, and the call ends the turn. " +
    "The Quiet check was shown the whole look question cut from its start, so the research's findings at its end were cut off.",
  path: "a check-in with a muted topic and a research finding",
  async run() {
    const chat = await oneToOne();
    try {
      chat.world.bucket.set("tex/attention.md", { body: "---\nmute: [payroll]\n---\nThey said: never text me about payroll.\n", etag: "m1" });
      const said = "Lantern Hall wants your choir to lead its Dec 6 concert at 4 PM and asked for a call Friday or Saturday morning. Want me to reply proposing Friday?";
      const ran = await chat.checkIn([placeholder, verdict(true, "Lantern Hall's concert invite needs an answer about a call."), { text: said }], { mail: [INVITE], research: [{ text: FOUND }] });

      const look = ran.shown;
      assert.match(look, /They asked never to be texted about these unless they ask: payroll\./, "the look is told what they muted, as a fact");
      assert.doesNotMatch(look, /for anything about them, call send/, "the muted line never asks for a say_nothing call");

      const judged = quietShown(ran);
      assert.match(judged, /Lantern Hall asks Ada's choir to lead/, "the Quiet check is shown the research's findings");
      assert.match(judged, /## This look/, "and this look's facts");
      assert.doesNotMatch(judged, /Answer with the brief only/, "never the research step's own words");
      assert.ok(judged.indexOf("Lantern Hall asks") < judged.indexOf("## This look"), "the findings come first, so a long look never cuts them");

      assert.equal(ran.answer, said, "the speak verdict holds the placeholder silence, and the look texts the invite");
    } finally {
      chat.restore();
    }
  },
};
