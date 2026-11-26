/**
 * The asker's yes to an answer held from a group (privacy rulebook rule 4, Dev2, 2026-11-26): the Room check records
 * the hold once a turn (`graph/nodes/roomCheck.js`), and `share_held` in the asker's own chat shares it on their own
 * words (`heldShare.js`). What the control plane does with both is `apps/convex/__tests__/groupHolds.test.ts`.
 *
 * Made-up names: Ada asked in a group with Bo, who isn't in @events-team; the answer carried its meeting.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-26):
 *   (i)   heldShare.js: the `asked` check skipped. "a yes in their own words shares it, anything else doesn't" fails.
 *   (ii)  heldShare.js: offered in a group too. "never in a group" fails.
 *   (iii) roomCheck node: `first` dropped. "the node records the hold once a turn" fails (two holds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { roomReads } from "../../../packages/tex/gateway/agent/roomCheck.js";
import { roomCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/roomCheck.js";
import { controlPlaneAnswer } from "../src/labSandbox/policy.js";
import { heldShareTool } from "../../../packages/tex/gateway/agent/heldShare.js";
import { CROSS_CHAT_SEND_ACTIONS, crossChatOf, crossChatQuestion } from "../../../packages/tex/gateway/agent/crossChat.js";

const KEY = "a".repeat(64);
const GROUP = {
  key: KEY,
  members: "b".repeat(64),
  from: "ada",
  people: ["ada", "bo"],
  reach: ["events-team"],
  unshared: ["events-team"],
  blocked: [{ slug: "events-team", who: "bo", why: "not_member" }],
  chat: [],
};
const MEETING = "# Events team structure 2027\n- Marcus owns Field Day logistics by 12/04\n- Priya drafts the volunteer rota";
const TAKEAWAYS = "Action items: Marcus owns Field Day logistics by 12/04, Priya drafts the volunteer rota.";

function heldTurn(controlPlane) {
  const reads = roomReads(GROUP);
  reads.add(["events-team"], [MEETING]);
  return { group: GROUP, ledger: {}, question: "@tex the action items?", history: [], roomReads: reads, job: null, session: { accessToken: "group-turn-token" }, controlPlane, drafts: { waiting: { draft: TAKEAWAYS } } };
}

test("the node records the hold once a turn, with its workspaces and the turn's own token, and no words", async () => {
  const calls = [];
  const t = heldTurn({ groupHold: async (token, body) => (calls.push({ token, body }), { status: "held" }) });
  const out = await roomCheckNode({ at: "draft" }, { ctx: { turn: t } });
  assert.equal(out.to, "hold");
  assert.equal(out.recorded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "group-turn-token");
  assert.deepEqual(calls[0].body.slugs, ["events-team"]);
  assert.match(calls[0].body.id, /^h[a-f0-9]{20}$/);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["id", "slugs"], "never the draft, never a number");
  t.drafts.waiting.draft = `${TAKEAWAYS} Anything else?`;
  await roomCheckNode({ at: "draft" }, { ctx: { turn: t } });
  t.turn = { answer: TAKEAWAYS };
  await roomCheckNode({ at: "answer" }, { ctx: { turn: t } });
  assert.equal(calls.length, 1, "one hold a turn");
});

test("a hold that can't be recorded still holds the answer", async () => {
  const t = heldTurn({ groupHold: async () => { throw new Error("down"); } });
  const out = await roomCheckNode({ at: "draft" }, { ctx: { turn: t } });
  assert.equal(out.to, "hold");
  assert.equal(out.recorded, false);
  assert.equal(t.ledger.asides.length, 1);
  const none = heldTurn(null);
  assert.equal((await roomCheckNode({ at: "draft" }, { ctx: { turn: none } })).recorded, false);
});

const GROUPS = [{ key: KEY, name: "Field day crew" }, { key: "c".repeat(64), name: "Family" }];

function shareTool({ words, judge = async () => ({ allow: true }), status = "shared", group = null, seen = [] } = {}) {
  const controlPlane = { groupShare: async (token, body) => (seen.push({ token, body }), status === "shared" ? { status, slugs: ["events-team"] } : { status }) };
  return heldShareTool({ session: { accessToken: "own-chat-token" }, controlPlane, group, groups: GROUPS, words, judge });
}

const factsOf = (result) => JSON.parse(result.content[0].text);

test("a yes in their own words shares it, anything else doesn't", async () => {
  const seen = [];
  const yes = await shareTool({ words: "yes share it with them", seen }).call({ chat: "Field day crew" });
  assert.equal(yes.isError, undefined);
  assert.deepEqual(factsOf(yes), { shared: true, chat: KEY, name: "Field day crew", open_there: ["@events-team"], posted: false });
  assert.deepEqual(seen, [{ token: "own-chat-token", body: { groupKey: KEY } }]);
  const byKey = await shareTool({ words: "ok go ahead" }).call({ chat: KEY });
  assert.equal(factsOf(byKey).shared, true);
  const unasked = [];
  const quiet = await shareTool({ words: "what did the group say?", seen: unasked }).call({ chat: "Field day crew" });
  assert.deepEqual(factsOf(quiet), { shared: false, status: "not_their_words" });
  assert.equal(unasked.length, 0, "nothing is asked of the control plane without their words");
  const judgedNo = await shareTool({ words: "no, don't send that", judge: async () => ({ allow: false }) }).call({ chat: "Field day crew" });
  assert.equal(factsOf(judgedNo).status, "not_their_words");
  const thrown = await shareTool({ words: "yes", judge: async () => { throw new Error("x"); } }).call({ chat: "Field day crew" });
  assert.equal(factsOf(thrown).status, "not_their_words");
});

test("the control plane's no is passed on as facts", async () => {
  for (const status of ["not_found", "expired", "not_member", "refused"]) {
    const answer = await shareTool({ words: "yes", status }).call({ chat: "Field day crew" });
    assert.equal(answer.isError, true);
    assert.deepEqual(factsOf(answer), { shared: false, status });
  }
  assert.equal(factsOf(await shareTool({ words: "yes" }).call({ chat: "nope!" })).status, "no_such_chat");
});

test("never in a group, so nobody there can open it for the asker", () => {
  assert.equal(shareTool({ words: "yes", group: GROUP }), null);
  assert.equal(heldShareTool({ session: { accessToken: "t" }, controlPlane: {}, group: null }), null);
  assert.equal(CROSS_CHAT_SEND_ACTIONS.share_held.tool, "share_held");
});

test("the held line in the asker's chat names the chat to share it in", () => {
  const event = crossChatOf({ event: "chat_answer", crossChat: { id: "x12345678ab", from: "a group chat they're in", what: "{}", state: "aside", texts: [TAKEAWAYS], held: true, key: KEY } }, { chatTurn: true, job: null });
  assert.deepEqual(JSON.parse(crossChatQuestion(event).slice(1, -1)), { event: "held_from_group", group: "a group chat they're in", chat: KEY });
});

test("in a Lab test chat a hold and its yes are answered and recorded, never sent", () => {
  const noted = [];
  const gate = { record: (row) => noted.push(row) };
  assert.deepEqual(controlPlaneAnswer("/gateway/group/hold", { accessToken: "t", id: "h1234567890", slugs: ["x"] }, gate).answer, { status: "held" });
  assert.equal(controlPlaneAnswer("/gateway/group/share", { accessToken: "t", groupKey: KEY }, gate).answer.status, "shared");
  assert.equal(noted.length, 2);
});
