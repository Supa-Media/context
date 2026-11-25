import assert from "node:assert/strict";
import { acceptJoined, INTRO_KEY, joinedOf } from "../../../../../packages/tex/worker/groupJoined.ts";
import { photonGroupChange } from "../../../../../packages/tex/worker/photonInbound.ts";
import { joinedNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/joined.js";

const LINE = "+15555550199";
const ADA = "+15555550101";
const GROUP = "11111111-2222-3333-4444-555555555555";

/** The chat object's storage, as `acceptJoined` and the group queue read it. */
function memory() {
  const kept = new Map();
  return {
    kept,
    get: async (key) => (typeof key === "string" ? kept.get(key) : new Map(key.filter((k) => kept.has(k)).map((k) => [k, kept.get(k)]))),
    put: async (key, value) => void (typeof key === "string" ? kept.set(key, value) : Object.entries(key).forEach(([k, v]) => kept.set(k, v))),
    delete: async (key) => kept.delete(key),
    list: async ({ prefix = "" } = {}) => new Map([...kept].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => kept.get("__alarm") ?? null,
    setAlarm: async (at) => void kept.set("__alarm", at),
  };
}

export default {
  id: "group-hello-when-added",
  incident: "2026-11-25: Dev2: \"Tex should have an intro when added to a group\". Added to a group, Tex said nothing until someone tagged it, and then only a line tacked onto its first answer.",
  cause: "Nothing in Tex read Photon's participantAdded naming Tex's own number, or a group's first message, as Tex being new there: no turn of its own said hello.",
  path: "group chat, Tex added",
  // Sabotage (2026-11-25): node `joined` off in main's config makes acceptJoined answer "off", and this fails.
  async run() {
    const change = photonGroupChange({ type: "group.changed", eventId: "photon:group.changed:g:1", seq: 1, line: LINE, chat: { guid: `any;+;${GROUP}`, kind: "group" }, from: ADA, fromMe: false, at: "2026-11-25T05:00:00Z", group: { change: "participantAdded", address: LINE } });
    assert.equal(change?.texAdded, true, "Photon's participantAdded naming Tex's line is Tex added");
    const joined = joinedOf({ groupId: GROUP, line: LINE, by: ADA, participants: [LINE, ADA] });
    assert.notEqual(joined, null);
    const storage = memory();
    assert.equal(await acceptJoined(storage, joined, 1_000), "queued", "main's config queues the hello");
    assert.notEqual(storage.kept.get(INTRO_KEY), undefined, "and marks the chat introduced");
    assert.equal(await acceptJoined(storage, joined, 2_000), "already", "said once per group");
    const node = await joinedNode({ event: "joined", group: true });
    assert.equal(node.to, "intro");
    assert.match(node.question, /Hey all, I'm Tex/, "its line carries Dev2's wording as the example");
    assert.match(node.question, /Anything personal stays in your own 1:1/);
    assert.equal((await joinedNode({ event: "joined", group: false })).to, "refuse", "never in a 1:1");
  },
};
