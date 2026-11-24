import assert from "node:assert/strict";
import { groupLineFor } from "../../../../../packages/tex/worker/groupLine.ts";
import { capabilitiesFor } from "../../../../../packages/tex/gateway/agent/capabilities.js";

const LINE = "+15555550199";
const GROUP = `photon-group:${btoa("iMessage;+;chat-poll").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

export default {
  id: "poll-started-on-imessage",
  incident: "2026-11-23: Dev asked for real iMessage polls. A group choosing a restaurant got Tex's list of options as a text, and everyone answered in a thread of replies Tex had to count.",
  cause: "Tex had no way to start a poll: the Photon bridge had no poll op, and a list of options went as words.",
  path: "group text",
  // Sabotage (2026-11-24): drop the pollOf branch in photonLine.ts sendPhotonWords, and the text goes as send/text
  // with its "(poll)" mark showing.
  async run() {
    assert.match(capabilitiesFor("group"), /first line is \\?"\(poll\) <the question>/, "the turn is told how to start a poll");
    const calls = [];
    const photon = {
      fetch: async (url, init) => {
        calls.push({ op: new URL(url).pathname.slice(1), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, guid: "poll-1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const line = groupLineFor({ fetch: globalThis.fetch, photon }, GROUP);
    const handle = await line.sendText({ line: LINE, groupId: GROUP }, "(poll) Where Friday?\n- Lugo's\n- Blend LIC\n- Thai Diner");
    assert.equal(handle, "poll-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "poll/create");
    assert.equal(calls[0].body.title, "Where Friday?");
    assert.deepEqual(calls[0].body.choices, ["Lugo's", "Blend LIC", "Thai Diner"]);
  },
};
