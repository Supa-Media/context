/**
 * Private notes and secrets in the Room check (`packages/tex/gateway/agent/roomCheck.js`; Dev2, 2026-11-28).
 *
 * Dev2 feared a general group ask ("what are the v2l action items rn") drawing on a private note that mentions the
 * group, and Tex posting a folder's notes when it wasn't sure which one was meant. Chosen: a private note stays out of
 * the group unless its asker names it ("if i tell tex a specific note even if marked private it should still be able
 * to read right" — yes), and a secret read this turn never goes to the group. Names and notes here are invented.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-28):
 *   (i)   roomCheck.js `roomVerdict`: the private-note loop removed. "a private note's plans, unnamed, are held" fails.
 *   (ii)  roomCheck.js `roomVerdict`: the `namedIn` skip removed. "a private note the asker names goes" fails.
 *   (iii) roomCheck.js `privateNotesIn`: the search-hit half removed. "a search hit marked private is kept" fails.
 *   (iv)  roomCheck.js `roomVerdict`: `secretIn` ignored. "a passcode read this turn is held, even when named" fails.
 *   (v)   search.js `toolSearchNotes`: `markPrivate` ignored. "a group's search marks a private hit" fails.
 *   (vii) roomCheck.js `privateNotesAt`: the `owned` check removed. "a team note in the asker's own notes is held" fails.
 *   (vi)  texConfig.json: the roomCheck outSchema back to before 2026-11-28 → "every field the node returns is one its
 *         config's outSchema names" fails (the live bug it was written for).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PRIVATE_READ, namedIn, privateNotesIn, roomReads, roomTally, roomVerdict, secretIn } from "../../../packages/tex/gateway/agent/roomCheck.js";
import { roomCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/roomCheck.js";
import { jobReportOf } from "../../../packages/tex/gateway/agent/jobReport.js";

// A room whose people all share every workspace: nothing is closed, so only the private rule and secrets can hold.
const GROUP = { key: "a".repeat(64), members: "b".repeat(64), from: "ada", people: ["ada", "bo"], guests: [], reach: ["bandco"], unshared: [], blocked: [], chat: [] };
const ok = (text) => ({ content: [{ type: "text", text }] });
const PLANS = "etag: \"e1\"\npath: projects/bandco-plans.md\nvisibility: private\n\n# Bandco plans\n- Thinking of cutting the Friday showcase, not telling Wendell yet\n- Move Halvorsen to bass";
const TEAM = "etag: \"e2\"\npath: projects/action-items.md\nvisibility: team\n\n# Action items\n- Book Orchard Hall for rehearsal\n- Print Quillon flyers";

async function readsOf(results) {
  const reads = roomReads(GROUP);
  const call = reads.wrap(async (name, args) => results[args.path ?? args.query]);
  for (const [key, result] of Object.entries(results)) await call(key.includes(".md") ? "read_notes" : "search_notes", key.includes(".md") ? { context: "@bandco", path: key } : { query: key });
  return reads;
}

test("a read's private note is kept by key, a team note isn't", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS), "projects/action-items.md": ok(TEAM) });
  assert.deepEqual(reads.privateKeys(), ["@bandco/projects/bandco-plans.md"]);
  assert.deepEqual(reads.slugs(), [], "nothing is closed in this room");
});

test("a search hit marked private is kept, an unmarked one isn't", () => {
  const text = "2 matching notes\n\n@bandco/projects/bandco-plans.md\n    (private note)\n    Thinking of cutting the Friday showcase\n\n@bandco/projects/action-items.md\n    Book Orchard Hall";
  assert.deepEqual([...privateNotesIn(text).keys()], ["@bandco/projects/bandco-plans.md"]);
});

test("a private note's plans, unnamed, are held from a general group ask", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS), "projects/action-items.md": ok(TEAM) });
  const draft = "Action items: book Orchard Hall, print Quillon flyers, and decide on cutting the Friday showcase with Wendell and Halvorsen.";
  const verdict = roomVerdict({ draft, reads, group: GROUP, question: "tex what are the bandco action items rn" });
  assert.ok(verdict, "held");
  assert.deepEqual(verdict.private, ["@bandco/projects/bandco-plans.md"]);
  assert.deepEqual(verdict.from, []);
});

test("a draft from team notes alone goes", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS), "projects/action-items.md": ok(TEAM) });
  assert.equal(roomVerdict({ draft: "Action items: book Orchard Hall and print the Quillon flyers.", reads, group: GROUP, question: "tex what are the bandco action items rn" }), null);
});

test("a private note the asker names goes", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS) });
  const draft = "Your Bandco plans note: cutting the Friday showcase, not telling Wendell yet, and moving Halvorsen to bass.";
  assert.equal(roomVerdict({ draft, reads, group: GROUP, question: "tex share my bandco plans note here" }), null);
  assert.equal(namedIn("share my bandco plans note", "@bandco/projects/bandco-plans.md"), true, "by its file name");
  assert.equal(namedIn("post projects/bandco-plans", "@bandco/projects/bandco-plans.md"), true, "by its path");
  assert.equal(namedIn("what are the bandco action items", "@bandco/projects/bandco-plans.md", PLANS), false, "a search's words name no note");
  assert.equal(namedIn("", "@bandco/projects/bandco-plans.md"), false);
});

test("a passcode read this turn is held, even when the note is named", async () => {
  const note = "etag: \"e3\"\npath: inbox/phone.md\nvisibility: private\n\n# Phone\nScreen Time passcode: 4817";
  const reads = await readsOf({ "inbox/phone.md": ok(note) });
  const verdict = roomVerdict({ draft: "Your phone note says the Screen Time passcode is 4817.", reads, group: GROUP, question: "tex what's in my phone note" });
  assert.ok(verdict?.secret, "held for the secret");
  assert.equal(secretIn("The wifi password is hunter2024", "router: hunter2024"), true);
  assert.equal(secretIn("The wifi password is hunter2024", ""), false, "nothing read this turn holds it");
  assert.equal(secretIn("I can't share the password here", "password: hunter2024"), false, "naming a secret is not giving it");
  assert.equal(secretIn("Your PIN is 4817", "PIN 4817", new Set(["4817"])), false, "the room already said it");
});

test("the node holds a private-note draft without recording a hold for the room", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS) });
  const ledger = {};
  const t = { roomReads: reads, group: GROUP, question: "tex what are the bandco action items rn", history: [], ledger, turn: { answer: "Decide on cutting the Friday showcase with Wendell, and move Halvorsen to bass." }, controlPlane: { groupHold: async () => assert.fail("never recorded") }, session: { accessToken: "t" } };
  const out = await roomCheckNode({ at: "answer" }, { ctx: { turn: t } });
  assert.equal(out.to, "hold");
  assert.equal(out.private, 1);
  assert.equal(out.recorded, false);
  assert.ok(JSON.parse(t.roomNotice).held_from_group.private_notes_not_named.includes("@bandco/projects/bandco-plans.md"));
  assert.deepEqual(roomTally({ draft: "x", reads, group: GROUP, question: "q" }).private, 1);
});

test("a job carries the private notes it read to its report", async () => {
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS) });
  assert.deepEqual(reads.carried(), [`${PRIVATE_READ}@bandco/projects/bandco-plans.md`]);
  const report = jobReportOf({ event: "job_report", jobReport: { title: "Action items", state: "done", texts: ["Cut the Friday showcase; tell Wendell later."], roomRead: reads.carried() } }, { chatTurn: true, job: null });
  assert.deepEqual(report?.roomRead, [`${PRIVATE_READ}@bandco/projects/bandco-plans.md`]);
  const next = roomReads(GROUP);
  next.add(report.roomRead, report.texts);
  assert.deepEqual(next.privateKeys(), ["@bandco/projects/bandco-plans.md"]);
});

test("the chat's own home is the room's, never a private note to hold", () => {
  const home = "etag: \"e4\"\npath: tex/groups/abc/about.md\nvisibility: private\n\n# About this chat\nRehearsal is Tuesdays.";
  assert.equal(privateNotesIn(home).size, 0, "a bare path is the chat's home");
  assert.equal(privateNotesIn(home, "context-lc").size, 0, "its home under tex/groups/");
  assert.equal(privateNotesIn("3 matching notes\n\ntex/groups/abc/about.md\n    (private note)\n    Rehearsal").size, 0);
});

// Battle of the Bots, 2026-11-28 (Dev2): "it can make decisions based on what it knows about my notes", but "i dont
// want it to state anything from my note unless explicitly permitted by the owner". In the asker's own personal notes
// a team note is held like a private one; a note they name still goes.
test("a team note in the asker's own notes is held unless named; a search there keeps its bare hits as theirs", async () => {
  const group = { ...GROUP, ownNotes: "ada" };
  const home = "etag: \"e5\"\npath: life/home.md\nvisibility: team\n\n# Home\nLives on Corvane Street near Pellbrook Chapel";
  const reads = roomReads(group);
  const call = reads.wrap(async (name) => (name === "read_notes" ? ok(home) : ok("1 matching note\n\nlife/home.md\n    Lives on Corvane Street near Pellbrook Chapel")));
  await call("read_notes", { context: "@ada", path: "life/home.md" });
  await call("search_notes", { context: "@ada", query: "area" });
  assert.deepEqual(reads.privateKeys(), ["@ada/life/home.md"]);
  const draft = "Brunch spots near Corvane Street by Pellbrook Chapel: three good ones.";
  assert.deepEqual(roomVerdict({ draft, reads, group, question: "tex brunch spots around my area" })?.private, ["@ada/life/home.md"]);
  assert.equal(roomVerdict({ draft: "Three brunch spots for Sunday: Larkfield Diner, Ostwin Cafe, Moller's.", reads, group, question: "tex brunch spots around my area" }), null, "a decision made from it, saying nothing it says, goes");
  assert.equal(roomVerdict({ draft, reads, group, question: "tex share my home note" }), null, "named by its owner");
  // In a shared workspace a team note is still the room's.
  const shared = roomReads(group);
  await shared.wrap(async () => ok(TEAM))("read_notes", { context: "@bandco", path: "projects/action-items.md" });
  assert.deepEqual(shared.privateKeys(), []);
});

// Live on 2026-11-28 the node's new `private`/`named` counts were not in its config's outSchema, so the graph failed the
// node on every group turn and the draft went unchecked (a Lab test chat on main caught it). Every field it returns,
// on a pass and on a hold, must be one the config names.
test("every field the node returns is one its config's outSchema names", async () => {
  const { TEX_CONFIG } = (await import("../../../packages/tex/src/texConfig.cjs")).default;
  const names = new Set(TEX_CONFIG.nodes.find((node) => node.id === "roomCheck").outSchema.map((field) => field.name));
  const reads = await readsOf({ "projects/bandco-plans.md": ok(PLANS), "inbox/phone.md": ok("etag: \"e3\"\npath: inbox/phone.md\nvisibility: private\n\n# Phone\nScreen Time passcode: 4817") });
  const turn = (answer) => ({ roomReads: reads, group: GROUP, question: "tex what are the bandco action items", history: [], ledger: {}, turn: { answer }, session: {} });
  const outs = [
    await roomCheckNode({ at: "answer" }, { ctx: { turn: turn("Book the hall.") } }),
    await roomCheckNode({ at: "answer" }, { ctx: { turn: turn("Cut the Friday showcase with Wendell and Halvorsen; the passcode is 4817.") } }),
  ];
  assert.deepEqual(outs.map((out) => out.to), ["pass", "hold"]);
  for (const out of outs) for (const key of Object.keys(out)) assert.ok(names.has(key), `roomCheck returns "${key}", which texConfig.json's outSchema does not name`);
});
