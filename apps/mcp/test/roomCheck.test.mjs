/**
 * The Room check (`packages/tex/gateway/agent/roomCheck.js`, node `graph/nodes/roomCheck.js`; Dev2, 2026-11-26: a
 * permission gate right before send). A group answer that carries what was read from a workspace someone in the room
 * can't open, that the asker didn't point at, goes to the asker alone; the group gets Tex's own line, written from facts.
 *
 * The case it was built for, with made-up names: a new group of three, one of whom (the asker) is in a shared workspace
 * the other two aren't; the asker asked to "summarize the action items for them" with no note named, and a job picked a
 * meeting in that workspace. Its takeaways must not reach the group.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-26):
 *   (i)   roomCheck.js `roomVerdict`: the `pointedAt` skip removed. "an ask that points at the workspace is never held" fails.
 *   (ii)  roomCheck.js `roomVerdict`: `!seen.has(token)` removed. "names the room already said don't count" fails.
 *   (iii) answerCheck.js `letGo`: the room check skipped. "a held draft goes back with the facts" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_CALL_CHARS, cantOpen, heldFacts, pointedAt, roomReads, roomSlugs, roomVerdict, slugsCalled, tokensOf } from "../../../packages/tex/gateway/agent/roomCheck.js";
import { roomCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/roomCheck.js";
import { answerCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/answerCheck.js";
import { holdForAsker } from "../../../packages/tex/gateway/agent/privateAside.js";
import { crossChatOf, crossChatPrompt, crossChatQuestion } from "../../../packages/tex/gateway/agent/crossChat.js";
import { jobReportOf } from "../../../packages/tex/gateway/agent/jobReport.js";
import { groupOf } from "../../../packages/tex/gateway/agent/groupTurn.js";

const KEY = "a".repeat(64);
const GROUP = {
  key: KEY,
  members: "b".repeat(64),
  from: "ada",
  people: ["ada", "bo"],
  guests: ["guest-1a2b"],
  reach: ["events-team", "family"],
  unshared: ["events-team"],
  blocked: [
    { slug: "events-team", who: "bo", why: "not_member" },
    { slug: "events-team", who: "guest-1a2b", why: "no_account" },
  ],
  chat: [],
};
const MEETING = "# Events team structure 2027\nAttendees: Priya, Marcus, Delphine\n- Marcus owns Field Day logistics by 12/04\n- Priya drafts the volunteer rota\n- Budget 4500 for the spring gala";
const TAKEAWAYS = "Here are the action items: Marcus owns Field Day logistics by 12/04, Priya drafts the volunteer rota, and the spring gala budget is 4500.";

const ok = (text) => ({ content: [{ type: "text", text }] });

function readsWithMeeting(group = GROUP) {
  const reads = roomReads(group);
  reads.add(["events-team"], [MEETING]);
  return reads;
}

test("the room's closed workspaces are the unshared ones and every one somebody is kept out of", () => {
  assert.deepEqual([...roomSlugs(GROUP)].sort(), ["events-team"]);
  assert.deepEqual([...roomSlugs({ ...GROUP, unshared: ["family"], blocked: [] })], ["family"]);
  assert.equal(roomSlugs(null).size, 0);
  assert.equal(roomReads({ ...GROUP, unshared: [], blocked: [] }), null, "a room that shares everything reads nothing closed");
  assert.deepEqual(cantOpen(GROUP, ["events-team"]), ["@bo", "guest-1a2b"]);
});

test("a call names a workspace by context, or by an @slug/ path or link", () => {
  assert.deepEqual([...slugsCalled({ context: "@events-team", query: "action items" })], ["events-team"]);
  assert.deepEqual([...slugsCalled({ path: "@events-team/inbox/meetings/a.md" })], ["events-team"]);
  assert.deepEqual([...slugsCalled({ args: { paths: ["@family/a.md", "@events-team/b.md"] } })].sort(), ["events-team", "family"]);
  assert.deepEqual([...slugsCalled({ url: "https://context.lc/@events-team/x" })], ["events-team"]);
  assert.equal(slugsCalled({ query: "events team" }).size, 0);
});

test("only what a call read from a closed workspace is kept, and an error keeps nothing", async () => {
  const reads = roomReads(GROUP);
  const call = reads.wrap(async (name, args) => (args.fail ? { isError: true, content: [{ type: "text", text: "no" }] } : ok(args.context === "@events-team" ? MEETING : "Family dinner Sunday")));
  await call("search", { context: "@family" });
  assert.deepEqual(reads.slugs(), [], "a workspace everyone here shares is not kept");
  await call("search", { context: "@events-team", fail: true });
  assert.deepEqual(reads.slugs(), []);
  await call("read", { context: "@events-team", path: "inbox/meetings/a.md" });
  assert.deepEqual(reads.slugs(), ["events-team"]);
  assert.match(reads.text("events-team"), /Field Day/);
});

test("a draft carrying a closed meeting's names and figures is held, with who can't open it", () => {
  const verdict = roomVerdict({ draft: TAKEAWAYS, reads: readsWithMeeting(), group: GROUP, question: "@tex summarize the action items for them" });
  assert.ok(verdict);
  assert.deepEqual(verdict.from, ["events-team"]);
  assert.deepEqual(verdict.cantOpen, ["@bo", "guest-1a2b"]);
  assert.ok(verdict.shared >= 3);
});

test("an ask that points at the workspace is never held: it is the asker's to share", () => {
  assert.equal(pointedAt("summarize @events-team's last meeting for them", "events-team"), true);
  assert.equal(pointedAt("see https://context.lc/@events-team/inbox/meetings/a.md", "events-team"), true);
  assert.equal(pointedAt("summarize the action items", "events-team"), false);
  assert.equal(pointedAt("@events-teamx", "events-team"), false);
  assert.equal(roomVerdict({ draft: TAKEAWAYS, reads: readsWithMeeting(), group: GROUP, question: "@tex summarize @events-team's meeting for them" }), null);
});

test("names the room already said don't count, so a reply about what's in the chat goes", () => {
  const history = [{ role: "user", text: "Marcus said Field Day logistics are due 12/04, and Priya has the rota" }];
  assert.equal(roomVerdict({ draft: "Got it: Marcus has Field Day logistics by 12/04 and Priya the rota.", reads: readsWithMeeting(), group: GROUP, question: "what did I say?", history }), null);
});

test("one shared word is not enough, and a turn that read nothing closed is never held", () => {
  assert.equal(roomVerdict({ draft: "Marcus is great.", reads: readsWithMeeting(), group: GROUP, question: "hi" }), null);
  assert.equal(roomVerdict({ draft: TAKEAWAYS, reads: roomReads(GROUP), group: GROUP, question: "hi" }), null);
  assert.equal(roomVerdict({ draft: TAKEAWAYS, reads: null, group: GROUP, question: "hi" }), null);
});

test("sentence words never count as names", () => {
  assert.deepEqual([...tokensOf("The meeting. Here are Action Items for Monday.")], []);
  assert.ok(tokensOf("Delphine owes 4500 by 12/04").has("delphine"));
});

test("the front door is told the facts as data, never a line to say", () => {
  const facts = JSON.parse(heldFacts({ from: ["events-team"], cantOpen: ["@bo"], shared: 3 }, { asker: "ada", sent: true }));
  assert.deepEqual(facts.held_from_group.read_from, ["@events-team"]);
  assert.equal(facts.held_from_group.draft_sent_privately_to, "@ada");
  const unsent = JSON.parse(heldFacts({ from: ["events-team"], cantOpen: [], shared: 3 }, { asker: "ada", sent: false }));
  assert.equal(unsent.held_from_group.draft_sent_privately_to, null);
  assert.equal(unsent.held_from_group.cant_open_here, "not everyone here");
});

test("the held draft goes to the asker alone, never for a guest who has no chat of their own", () => {
  const ledger = {};
  assert.equal(holdForAsker(ledger, GROUP, TAKEAWAYS, "{}"), true);
  assert.equal(ledger.asides.length, 1);
  assert.equal(ledger.asides[0].held, true);
  assert.deepEqual(ledger.asides[0].texts, [TAKEAWAYS]);
  assert.equal(holdForAsker({}, { ...GROUP, from: "", guestTagger: true }, TAKEAWAYS, "{}"), false);
});

function turnOf(extra = {}) {
  const ledger = {};
  return { group: GROUP, ledger, question: "@tex summarize the action items for them", history: [], roomReads: readsWithMeeting(), job: null, ...extra };
}

test("the node holds once a turn: one aside, the facts on the turn, and a rewrite that still carries it adds no second", async () => {
  const t = turnOf({ drafts: { waiting: { draft: TAKEAWAYS } } });
  const out = await roomCheckNode({ at: "draft" }, { ctx: { turn: t } });
  assert.equal(out.to, "hold");
  assert.equal(out.sent, true);
  assert.equal(t.ledger.asides.length, 1);
  assert.equal(JSON.parse(t.roomNotice).held_from_group.draft_sent_privately_to, "@ada");
  t.drafts.waiting.draft = `${TAKEAWAYS} Anything else?`;
  assert.equal((await roomCheckNode({ at: "draft" }, { ctx: { turn: t } })).to, "hold");
  assert.equal(t.ledger.asides.length, 1);
  assert.equal(t.roomHush, undefined, "a draft still has its rewrite");
  t.turn = { answer: TAKEAWAYS };
  await roomCheckNode({ at: "answer" }, { ctx: { turn: t } });
  assert.equal(t.roomHush, true, "the last answer goes to nobody in the group");
  const clean = turnOf({ drafts: { waiting: { draft: "I sent you the action items on the side, Ada." } } });
  const passed = await roomCheckNode({ at: "draft" }, { ctx: { turn: clean } });
  assert.equal(passed.to, "pass");
  assert.ok(passed.chars > 0, "a pass says how much it read, so a Lab run shows an empty read");
  assert.equal(passed.pointed, 0);
  assert.ok(passed.carried < 2);
  assert.equal((await roomCheckNode({ at: "draft" }, { ctx: { turn: { ...clean, roomReads: null } } })).to, "skipped");
  assert.equal((await roomCheckNode({ at: "draft" }, { ctx: { turn: { ...clean, job: { id: "j" } } } })).to, "skipped", "a job's own turn reports, and its report is checked");
});

/** The Answer check with fake code checks and a fake loop wire: drafts in order, each send-back the next. */
async function answerRun(drafts, { left = 3, wired = true } = {}) {
  const t = turnOf({ answerChecks: { code: async () => ({ notice: null, review: false }) }, reviewedAs: null, ladderOn: false });
  let i = 0;
  t.drafts = { waiting: { draft: drafts[0], info: {} } };
  const notices = [];
  let budget = left;
  const back = Object.assign(
    async (message, opts) => {
      if (opts?.release) return { pending: false, released: true };
      budget -= 1;
      notices.push(message.notice);
      i += 1;
      t.drafts.waiting = { draft: drafts[i], info: {} };
      return { pending: true };
    },
    { left: () => budget },
  );
  const use = wired ? { roomCheck: (input) => roomCheckNode(input, { ctx: { turn: t } }) } : {};
  const out = await answerCheckNode({ pending: true }, { ctx: { turn: t }, back: { fd: back }, use });
  return { out, notices, t };
}

test("a held draft goes back with the facts, and the rewrite that drops it goes", async () => {
  const { out, notices, t } = await answerRun([TAKEAWAYS, "I texted you the action items, Ada."]);
  assert.equal(notices.length, 1);
  assert.ok(JSON.parse(notices[0]).held_from_group);
  assert.equal(out.log?.held, 1);
  assert.equal(t.ledger.asides.length, 1);
});

test("with no round left the draft is let go here, for Finish to hold, and unwired nothing changes", async () => {
  const spent = await answerRun([TAKEAWAYS], { left: 0 });
  assert.equal(spent.notices.length, 0);
  const off = await answerRun([TAKEAWAYS], { wired: false });
  assert.equal(off.notices.length, 0);
  assert.equal(off.t.ledger.asides, undefined);
});

test("a job reports the closed workspaces it read, and a held aside reaches the asker's 1:1 as facts", () => {
  const report = jobReportOf({ event: "job_report", jobReport: { title: "Action items", state: "done", texts: [TAKEAWAYS], roomRead: ["events-team", "BAD SLUG"] } }, { chatTurn: true, job: null });
  assert.deepEqual(report.roomRead, ["events-team"]);
  const event = crossChatOf({ event: "chat_answer", crossChat: { id: "x12345678ab", from: "a group chat they're in", what: heldFacts({ from: ["events-team"], cantOpen: ["@bo"] }, { asker: "ada", sent: true }), state: "aside", texts: [TAKEAWAYS], held: true } }, { chatTurn: true, job: null });
  assert.equal(event.held, true);
  const prompt = JSON.parse(crossChatPrompt(event).trim());
  assert.deepEqual(prompt.held_from_group.draft, [TAKEAWAYS]);
  assert.deepEqual(prompt.held_from_group.facts.held_from_group.read_from, ["@events-team"]);
  assert.match(crossChatQuestion(event), /held_from_group/);
  const plain = crossChatOf({ event: "chat_answer", crossChat: { id: "x12345678ab", from: "a group", what: "a code", state: "aside", texts: [], held: true } }, { chatTurn: true, job: null });
  assert.equal(plain.held, true);
  const notAside = crossChatOf({ event: "chat_answer", crossChat: { id: "x12345678ab", from: "a group", what: "a code", state: "answered", texts: [], held: true } }, { chatTurn: true, job: null });
  assert.equal(notAside.held, undefined, "only an aside can be held");
});

test("a group turn keeps the unshared workspaces it is told, read strictly", () => {
  const group = groupOf({ group: { key: KEY, members: "b".repeat(64), from: "ada", unshared: ["events-team", "Bad Slug", 7] } });
  assert.deepEqual(group.unshared, ["events-team"]);
});

test("a wide search read first never crowds out the note read after it", async () => {
  const reads = roomReads(GROUP);
  const search = reads.wrap(async () => ok("Weekly sync notes, nothing to see. ".repeat(4_000)));
  await search("search_notes", { query: "events", context: "@events-team" });
  const read = reads.wrap(async () => ok(MEETING));
  await read("read_note", { path: "@events-team/inbox/meetings/structure.md" });
  assert.ok(reads.text("events-team").length <= 2 * MAX_CALL_CHARS + 2);
  assert.ok(reads.text("events-team").includes("Marcus owns Field Day"), "the note read last is kept");
  assert.ok(roomVerdict({ draft: TAKEAWAYS, reads, group: GROUP }), "and a draft that carries it is held");
});
