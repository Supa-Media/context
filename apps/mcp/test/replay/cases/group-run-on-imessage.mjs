import assert from "node:assert/strict";
import { groupLineFor } from "../../../../../packages/tex/worker/groupLine.ts";
import { runTheGroup } from "../../../../../packages/tex/worker/groupRunTurn.ts";
import { capabilitiesFor } from "../../../../../packages/tex/gateway/agent/capabilities.js";

const LINE = "+15555550199";
const GROUP = `photon-group:${btoa("iMessage;+;chat-run").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
const PHOTO = { url: "https://agent.example/photon/attachment/att-42?e=1&s=x", mimeType: "image/jpeg", filename: "IMG_2.jpg", size: 2000 };

export default {
  id: "group-run-on-imessage",
  incident: "2026-11-23: Dev asked for running the group. \"Tex call this chat Lisbon trip and make this the photo\" got words back and the chat kept its old name and photo.",
  cause: "Tex had no way to change a group: the Photon bridge had no op for a name, a photo or a new person, and the turn had nothing to read them from.",
  path: "group text",
  // Sabotage (2026-11-24): drop `runTheGroup` in groupModelTurn.ts, or the `theirs.has(address)` check in groupRun.ts,
  // and this case fails: the lines go nowhere, or a number nobody typed is added.
  async run() {
    assert.match(capabilitiesFor("group"), /\(name the chat\) <name>/, "the turn is told how to name the chat");
    const calls = [];
    const photon = {
      fetch: async (url, init) => {
        calls.push({ op: new URL(url).pathname.slice(1), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, guid: "m-1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const line = groupLineFor({ fetch: globalThis.fetch, photon }, GROUP);
    const place = { line: LINE, groupId: GROUP };
    const asked = { text: "Tex call this chat Lisbon trip, make this the photo and add my mom 555 010 0123", attachments: [PHOTO] };
    const answer = "(name the chat) Lisbon trip\n(set the chat photo)\n(add to the chat) +15550100123\n(add to the chat) +15550100999\nDone, welcome Mom!";
    const ran = await runTheGroup([answer], asked, line, place);
    for (const text of ran.texts) if (text !== "") await line.sendText(place, text);
    assert.deepEqual(calls.map((call) => call.op), ["group/name", "group/photo", "group/add", "send/text"]);
    assert.equal(calls[0].body.name, "Lisbon trip");
    assert.equal(calls[1].body.attachment, "att-42");
    assert.equal(calls[2].body.address, "+15550100123", "only the number the asker typed is added");
    assert.equal(calls[3].body.text, "Done, welcome Mom!");
    assert.ok(ran.told, "the number nobody typed is refused, and the chat is told");
  },
};
