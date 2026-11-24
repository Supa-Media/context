import assert from "node:assert/strict";
import { MemoryStorage } from "../../../../../packages/tex/worker/memoryStorage.testing.ts";
import { keepTagPeople, tagWords } from "../../../../../packages/tex/worker/groupTags.ts";
import { groupLineFor } from "../../../../../packages/tex/worker/groupLine.ts";
import { rosterLine } from "../../../../../packages/tex/gateway/agent/groupNames.js";

const LINE = "+15555550199";
const SAM = "+15555550103";
const JO = "+15555550104";
const GROUP = `photon-group:${btoa("iMessage;+;chat-tags").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

export default {
  id: "tag-sent-natively",
  incident: "2026-11-23: Dev asked for native tags in groups. Tex named people in a group as \"@sam\", which iMessage showed as those literal words: nobody was notified, and a person who muted the chat never saw the task meant for them.",
  cause: "A group turn knows each account by @handle and wrote it as such; the line sent the words as typed, and the Photon bridge sent no part as a tag.",
  path: "group text",
  // Sabotage (2026-11-24): drop the `tags` branch in photonLine.ts photonGroupLine sendText, and the send is a plain
  // send/text with no mention; drop keepTagPeople in groupInbox.ts, and "@sam" goes out as written.
  async run() {
    const group = { people: ["sam", "jo"], names: [{ handle: "sam", name: "Sam Lee" }], size: 2 };
    assert.match(rosterLine(group), /write their @handle/, "the turn is told how to tag");
    const storage = new MemoryStorage();
    await keepTagPeople(storage, [{ phone: SAM, handle: "sam", name: "Sam Lee" }, { phone: JO, handle: "jo" }]);
    const calls = [];
    const photon = {
      fetch: async (url, init) => {
        calls.push({ op: new URL(url).pathname.slice(1), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true, guid: "g-1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const line = groupLineFor({ fetch: globalThis.fetch, photon }, GROUP);
    const tagged = await tagWords(storage, "@sam the deck is yours, due Friday", async () => [SAM, JO]);
    assert.equal(tagged.text, "Sam the deck is yours, due Friday", "a tag shows the person's name, never @handle");
    await line.sendText({ line: LINE, groupId: GROUP }, tagged.text, undefined, tagged.tags);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "send/multipart");
    assert.deepEqual(calls[0].body.parts, [{ text: "Sam", mention: SAM }, { text: " the deck is yours, due Friday" }], "Sam is tagged by number");
  },
};
