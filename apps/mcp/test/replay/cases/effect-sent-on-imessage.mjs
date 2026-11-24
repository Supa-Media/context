import assert from "node:assert/strict";
import { groupLineFor } from "../../../../../packages/tex/worker/groupLine.ts";
import { capabilitiesFor } from "../../../../../packages/tex/gateway/agent/capabilities.js";

const LINE = "+15555550199";
const GROUP = `photon-group:${btoa("iMessage;+;chat-ink").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

export default {
  id: "effect-sent-on-imessage",
  incident: "2026-11-23: Dev asked for iMessage effects. Tex read a text sent with Slam or Invisible Ink but could only answer in plain words, so a reply about hidden words had to repeat them where everyone could see.",
  cause: "Tex had no way to send an effect: its words went to Photon's send/text with no effect, though the bridge already took one.",
  path: "group text",
  // Sabotage (2026-11-24): drop the effect from sendPhotonWords in photonLine.ts, and the text goes with its
  // "(sent with Invisible Ink)" mark as plain words and no effect.
  async run() {
    assert.match(capabilitiesFor("group"), /starting it \\?"\(sent with Slam\)/, "the turn is told how to send an effect");
    const calls = [];
    const photon = {
      fetch: async (url, init) => {
        calls.push({ op: new URL(url).pathname.slice(1), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, guid: "g-1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const line = groupLineFor({ fetch: globalThis.fetch, photon }, GROUP);
    await line.sendText({ line: LINE, groupId: GROUP }, "(sent with Invisible Ink) yes, Friday at 8");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "send/text");
    assert.equal(calls[0].body.text, "yes, Friday at 8", "the mark never reaches the chat");
    assert.equal(calls[0].body.effect, "invisible", "the words go hidden under Invisible Ink");
  },
};
