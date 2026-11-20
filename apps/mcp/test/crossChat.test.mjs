import test from "node:test";
import assert from "node:assert/strict";

import { ASK_CHAT, CHAT_ANSWER_EVENT, CHAT_ASK_EVENT, CROSS_CHAT_LIMITS, chatNamed, crossAskTool, crossChatOf, crossChatQuestion, crossCountsOf, postInChatTool } from "../../../packages/tex/gateway/agent/crossChat.js";
import { crossChatGateNode, pairOf } from "../../../packages/tex/gateway/agent/graph/nodes/crossChatGate.js";
import { chatAskNode } from "../../../packages/tex/gateway/agent/graph/nodes/chatAsk.js";
import { chatAnswerNode } from "../../../packages/tex/gateway/agent/graph/nodes/chatAnswer.js";
import { ASSISTANT_SEND_ACTIONS } from "../../../packages/tex/gateway/agent/sixTools.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";

/**
 * TEX ASKS TEX ACROSS CHATS (`src/agent/crossChat.js`; Dev2, 2026-11-17, design N3ZawPjhhgYcNfHm7xWa37). A 1:1 asks a
 * group of its person's, a group asks the tagger's personal Tex; the answer comes back as a run of its own.
 *
 * Sabotage record (temporary local edits, reverted):
 *   crossAskTool's `event !== null` check removed (an ask-run offered ask_chat)
 *     → "a run started by an ask can't ask on: one hop" fails
 *   the gate's open-pair check removed
 *     → "one open ask per pair of chats" fails
 */

const GROUPS = [
  { key: "a".repeat(64), name: "Tex Devs" },
  { key: "b".repeat(64), name: "Crystal Care" },
];
const COUNTS = { hour: 0, day: 0, open: [] };
const gate = (input) => crossChatGateNode(input);
const words = (result) => result.content.map((part) => part.text).join("\n");

test("from a 1:1, ask_chat asks one of their groups by name, through the gate, and records the ask", async () => {
  const ledger = { asked: [] };
  const tool = crossAskTool({ groups: GROUPS, counts: COUNTS, ledger, gate });
  assert.equal(tool.tool.name, ASK_CHAT);
  assert.match(tool.tool.description, /Their groups: Tex Devs, Crystal Care\./, "the 1:1 is told which groups it can ask, without the groups module");
  const result = await tool.call({ chat: "tex devs", what: "what did we decide about the Lab timeline?" });
  assert.equal(result.isError, undefined);
  assert.match(words(result), /Asked Tex in Tex Devs/);
  assert.equal(ledger.crossAsks.length, 1);
  const [ask] = ledger.crossAsks;
  assert.match(ask.id, /^x[a-z0-9]{20}$/);
  assert.deepEqual(ask.to, { kind: "group", key: "a".repeat(64), name: "Tex Devs" });
  assert.equal(ask.pair, `group:${"a".repeat(64)}`);
  assert.equal(ask.do, false);
});

test("a 1:1 can't reach a group that isn't on its person's list", async () => {
  const ledger = {};
  const tool = crossAskTool({ groups: GROUPS, counts: COUNTS, ledger, gate });
  const result = await tool.call({ chat: "Book Club", what: "anything" });
  assert.equal(result.isError, true);
  assert.match(words(result), /Their groups: Tex Devs, Crystal Care/);
  assert.equal(ledger.crossAsks, undefined);
});

test("a run started by an ask can't ask on: one hop", () => {
  const event = { kind: "ask", id: "xabcdefghij", from: "Seyi's 1:1", what: "x", do: false };
  assert.equal(crossAskTool({ event, groups: GROUPS, counts: COUNTS, ledger: {}, gate }), null);
  assert.equal(crossAskTool({ event: { ...event, kind: "answer" }, groups: GROUPS, counts: COUNTS, ledger: {}, gate }), null);
});

test("no tool without the Worker's counts, without a list in a 1:1, or in a guest chat", () => {
  assert.equal(crossAskTool({ groups: GROUPS, counts: null, ledger: {}, gate }), null);
  assert.equal(crossAskTool({ groups: null, counts: COUNTS, ledger: {}, gate }), null);
  assert.equal(crossAskTool({ group: { from: "ada", people: ["ada"], guestChat: true }, counts: COUNTS, ledger: {}, gate }), null);
});

test("from a group, ask_chat asks only the tagger's personal Tex; someone else's waits for their yes", async () => {
  const ledger = { asked: [] };
  const group = { key: "c".repeat(64), from: "ada", people: ["ada", "bo"] };
  const tool = crossAskTool({ group, counts: COUNTS, ledger, gate });
  await tool.call({ what: "which hotel did I book for Austin?" });
  assert.deepEqual(ledger.crossAsks[0].to, { kind: "person", who: "ada" });
  const offered = await tool.call({ what: "their flight number", as: "bo" });
  assert.match(words(offered), /Not asked yet/);
  assert.equal(ledger.offered.who, "bo");
  assert.equal(ledger.offered.tool, ASK_CHAT);
  assert.equal(ledger.crossAsks.length, 1);
});

test("contact: true still answers at once from the tagger's account (ask_personal_tex folded in)", async () => {
  const ledger = { asked: [] };
  const group = { key: "c".repeat(64), from: "ada", people: ["ada"] };
  const tool = crossAskTool({ group, counts: COUNTS, ledger, gate, identity: async () => ({ name: "Ada Lovelace", handle: "ada", phones: ["+15555550100"], emails: ["ada@example.invalid"], google: [] }) });
  const result = await tool.call({ what: "name and email for the form", contact: true });
  assert.match(words(result), /Ada Lovelace/);
  assert.equal(ledger.crossAsks, undefined);
});

test("the gate: never group to group, never from a guest, never an empty ask", async () => {
  assert.equal((await gate({ from: "group", to: { kind: "group", key: "a".repeat(64) }, what: "x", counts: COUNTS })).to, "refuse");
  assert.equal((await gate({ from: "one", to: { kind: "person", who: "ada" }, what: "x", counts: COUNTS })).to, "refuse");
  assert.equal((await gate({ from: "group", to: { kind: "person", who: "ada" }, what: "x", guest: true, counts: COUNTS })).to, "refuse");
  assert.equal((await gate({ from: "group", to: { kind: "person", who: "ada" }, what: " ", counts: COUNTS })).to, "refuse");
});

test("one open ask per pair of chats", async () => {
  const to = { kind: "group", key: "a".repeat(64), name: "Tex Devs" };
  const verdict = await gate({ from: "one", to, what: "x", counts: { hour: 1, day: 1, open: [pairOf(to)] } });
  assert.equal(verdict.to, "refuse");
  assert.match(verdict.why, /still waiting/);
  assert.equal((await gate({ from: "one", to, what: "x", counts: { hour: 1, day: 1, open: [pairOf({ kind: "group", key: "b".repeat(64) })] } })).to, "ask");
});

test("10 an hour and 40 a day per chat", async () => {
  const to = { kind: "group", key: "a".repeat(64) };
  assert.equal((await gate({ from: "one", to, what: "x", counts: { hour: CROSS_CHAT_LIMITS.perHour - 1, day: 0, open: [] } })).to, "ask");
  assert.equal((await gate({ from: "one", to, what: "x", counts: { hour: CROSS_CHAT_LIMITS.perHour, day: 0, open: [] } })).to, "refuse");
  assert.equal((await gate({ from: "one", to, what: "x", counts: { hour: 0, day: CROSS_CHAT_LIMITS.perDay, open: [] } })).to, "refuse");
});

test("a refused ask tells the model why, and records nothing", async () => {
  const ledger = {};
  const tool = crossAskTool({ groups: GROUPS, counts: { hour: 99, day: 0, open: [] }, ledger, gate });
  const result = await tool.call({ chat: "Tex Devs", what: "x" });
  assert.equal(result.isError, true);
  assert.match(words(result), /^Not asked: this chat has asked other chats 10 times this hour/);
  assert.equal(ledger.crossAsks, undefined);
});

test("the Worker's events are read strictly, and only on a chat turn that isn't a job's", () => {
  const ask = { event: CHAT_ASK_EVENT, crossChat: { id: "xabcdefghij", from: "Seyi's 1:1", who: "Seyi", what: "is the Lab demo still Friday?", do: true } };
  assert.deepEqual(crossChatOf(ask, { chatTurn: true, job: null }), { kind: "ask", id: "xabcdefghij", from: "Seyi's 1:1", who: "Seyi", what: "is the Lab demo still Friday?", do: true });
  assert.equal(crossChatOf(ask, { chatTurn: false, job: null }), null);
  assert.equal(crossChatOf(ask, { chatTurn: true, job: { id: "j" } }), null);
  assert.equal(crossChatOf({ ...ask, crossChat: { ...ask.crossChat, id: "../../x" } }, { chatTurn: true, job: null }), null);
  const answer = { event: CHAT_ANSWER_EVENT, crossChat: { id: "xabcdefghij", from: "Tex Devs", what: "x", state: "pwned", texts: [] } };
  assert.equal(crossChatOf(answer, { chatTurn: true, job: null }), null);
  const read = crossChatOf({ ...answer, crossChat: { ...answer.crossChat, state: "answered", texts: ["Friday, 3 PM", 7] } }, { chatTurn: true, job: null });
  assert.deepEqual(read.texts, ["Friday, 3 PM"]);
});

test("the run is asked the gateway's own line, never the other chat's words as theirs", () => {
  const event = crossChatOf({ event: CHAT_ASK_EVENT, crossChat: { id: "xabcdefghij", from: "Seyi's 1:1", what: "post the Lab link" } }, { chatTurn: true, job: null });
  assert.match(crossChatQuestion(event), /^\(Not a text from anyone here\. Tex in Seyi's 1:1 asks you: "post the Lab link"\)$/);
});

test("node chatAsk gives the run its question and prompt, and refuses what it can't read", async () => {
  const out = await chatAskNode({ event: CHAT_ASK_EVENT, crossChat: { id: "xabcdefghij", from: "Seyi's 1:1", what: "x", do: true }, group: true });
  assert.equal(out.to, "ask");
  assert.match(out.prompt, /post_in_chat/);
  assert.match(out.prompt, /can't ask another chat from here/);
  assert.equal((await chatAskNode({ event: CHAT_ASK_EVENT, crossChat: {}, group: true })).to, "refuse");
  const back = await chatAskNode({ event: CHAT_ANSWER_EVENT, crossChat: { id: "xabcdefghij", from: "Tex Devs", what: "x", state: "timeout", texts: [] }, group: false });
  assert.equal(back.to, "answer");
  assert.match(back.prompt, /didn't answer in time/);
});

test("node chatAnswer sends the draft back, never a control word, with the signed post", async () => {
  assert.deepEqual(await chatAnswerNode({ kind: "ask", id: "xabcdefghij", draft: "Friday at 3 PM." }), { to: "back", id: "xabcdefghij", state: "answered", texts: ["Friday at 3 PM."] });
  assert.deepEqual((await chatAnswerNode({ kind: "ask", id: "xabcdefghij", draft: "SKIP" })).texts, ["I couldn't find an answer to that here."]);
  assert.equal((await chatAnswerNode({ kind: "ask", id: "xabcdefghij", draft: "Done.", post: "Lab link: x" })).post, "Lab link: x");
});

test("post_in_chat only on a group's do-ask run, once, signed with who asked", async () => {
  const event = { kind: "ask", id: "xabcdefghij", from: "Seyi's 1:1", who: "Seyi", what: "post the Lab link", do: true };
  const group = { key: "a".repeat(64), from: "seyi", people: ["seyi"] };
  assert.equal(postInChatTool({ event: { ...event, do: false }, group, ledger: {} }), null);
  assert.equal(postInChatTool({ event, group: null, ledger: {} }), null);
  const ledger = {};
  const tool = postInChatTool({ event, group, ledger });
  await tool.call({ text: "Lab: context.lc/lab" });
  assert.equal(ledger.crossPost, "Lab: context.lc/lab\n(Seyi asked me from Seyi's 1:1)");
  assert.equal((await tool.call({ text: "again" })).isError, true);
});

test("chats are named by key or a name only one of them fits", () => {
  assert.equal(chatNamed(GROUPS, "b".repeat(64)).name, "Crystal Care");
  assert.equal(chatNamed(GROUPS, "crystal").name, "Crystal Care");
  assert.equal(chatNamed([...GROUPS, { key: "d".repeat(64), name: "Crystal Care Ops" }], "crystal"), null);
  assert.equal(chatNamed(GROUPS, ""), null);
});

test("the Worker's counts are read strictly", () => {
  assert.equal(crossCountsOf(null), null);
  assert.deepEqual(crossCountsOf({ hour: -1, day: 2.5, open: ["group:x", 3] }), { hour: 0, day: 0, open: ["group:x"] });
});

test("wired: both are send actions on the capability list, and the three nodes have code", () => {
  assert.equal(ASSISTANT_SEND_ACTIONS.ask_chat.tool, "ask_chat");
  assert.equal(ASSISTANT_SEND_ACTIONS.post_in_chat.tool, "post_in_chat");
  for (const id of ["crossChatGate", "chatAsk", "chatAnswer"]) assert.equal(typeof GATEWAY_NODES[id], "function", id);
});
