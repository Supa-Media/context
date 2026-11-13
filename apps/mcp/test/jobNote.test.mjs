/**
 * A job's note, with the job, Tex and the advisor on its mail (owner, 2026-11-05: "Tex creates a shared project note
 * for each job first and connects the worker/minion, advisor and Tex itself"; `src/agent/jobNote.js`), and the line a
 * job mails to Tex or its advisor handed to that job's own object (`src/mail/deliver.js`).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `join` binding every name to the job → "the job joins bound to itself; Tex and the advisor join unbound".
 *  2. `deliverMail` dropping `box.own` for roster agents → "a line to tex or advisor reaches only the sender's own job".
 *  3. (2026-11-06) the route's `no_note` for every grant but a person's → "a group's job with no project of its own gets
 *     a note in its workspace's projects".
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fallbackPath, handleJobNote, jobName, rosterText } from "../src/agent/jobNote.js";
import { deliverMail } from "../src/mail/deliver.js";
import { jobOf, jobPrompt } from "../src/agent/background.js";
import { jobCheckBrief } from "../src/agent/jobCheck.js";

const JOB = "job-0000-abcd-1234";
const texting = (fields = {}) => {
  const s = { actorClientId: "context_texts", actorUserId: "user_dev", scopes: ["context:read", "context:write"], workspaceId: "ws_dev", workspaces: [{ workspaceId: "ws_dev", slug: "seyi", role: "owner", kind: "personal" }], ...fields };
  Object.defineProperty(s, "accessToken", { value: "cat_job_token_000000", enumerable: false });
  return s;
};

/** A note store as the tools see it: read_note and write_note, mail joins recorded with the turn's binding. */
function fakeNotes(initial = {}) {
  const notes = new Map(Object.entries(initial));
  const joins = [];
  const sent = [];
  const store = { mailTurn: { role: "tex" } };
  let box = 0;
  const call = async (name, args) => {
    const key = `${args.context ?? ""}${args.path}`;
    if (name === "read_note") return notes.has(key) ? { content: [{ type: "text", text: notes.get(key) }] } : { isError: true, content: [{ type: "text", text: "not found" }] };
    if (name === "write_note" && args.mail?.join) {
      if (!notes.has(key)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      joins.push({ name: args.mail.join, job: store.mailTurn?.job ?? null, path: args.path, context: args.context ?? null });
      notes.set(key, `${notes.get(key)}\n- 2026-11-05T14:00:00.000Z ${args.mail.join} (Tex) joined`);
      box += 1;
      return { content: [{ type: "text", text: `joined.\nmailbox: mb_${String(box).padStart(8, "0")}` }] };
    }
    if (name === "write_note" && args.mail?.text) {
      sent.push({ ...args.mail, mailbox: args.mailbox, path: args.path });
      return { content: [{ type: "text", text: "sent" }] };
    }
    if (name === "write_note") {
      notes.set(key, args.content);
      return { content: [{ type: "text", text: "saved" }] };
    }
    return { isError: true, content: [{ type: "text", text: `unexpected ${name}` }] };
  };
  return { notes, joins, sent, store, call };
}

const ask = (fake, path, body, session = texting(), extra = {}) =>
  handleJobNote(new Request(`https://gateway.test${path}`, { method: "POST", body: JSON.stringify(body) }), { AI: { run: async () => ({}) } }, session, { path, store: fake.store, controlPlane: null, call: fake.call, ...extra }).then(async (response) => ({ status: response.status, body: await response.json() }));

test("a job with no project gets its note in Tex's own notes, brief and finish line on top", async () => {
  const fake = fakeNotes();
  const { body } = await ask(fake, "/agent/job/note", { jobId: JOB, title: "Sign dev2 in to GitHub", brief: "Run gh auth login on dev2.", doneWhen: "gh auth status says signed in." });
  assert.equal(body.ok, true);
  assert.equal(body.path, fallbackPath("Sign dev2 in to GitHub", JOB));
  assert.match(body.path, /^tex\/jobs\/sign-dev2-in-to-github-job000\.md$/);
  assert.match(fake.notes.get(body.path), /^# Sign dev2 in to GitHub\n\nRun gh auth login on dev2\.\n\nDone when: gh auth status says signed in\./);
  assert.equal(body.name, "sign-dev2-in-to-github");
  assert.match(body.mailbox, /^mb_/);
  assert.match(body.advisor, /^mb_/);
});

test("the job joins bound to itself; Tex and the advisor join unbound, and the turn's own binding is put back", async () => {
  const fake = fakeNotes({ "@supaprojects/tex/overview.md": "# Tex\n\nThe plan." });
  const { body } = await ask(fake, "/agent/job/note", { jobId: JOB, title: "Pricing", brief: "Price it.", note: { path: "projects/tex/overview.md", context: "@supa", name: "pricing" } });
  assert.equal(body.ok, true);
  assert.deepEqual(fake.joins.map(({ name, job }) => [name, job]), [["pricing", JOB], ["tex", null], ["advisor", null]]);
  assert.ok(fake.joins.every((entry) => entry.context === "@supa" && entry.path === "projects/tex/overview.md"));
  assert.match(fake.notes.get("@supaprojects/tex/overview.md"), /^# Tex\n\nThe plan\./, "a project note that is there keeps its words");
  assert.deepEqual(fake.store.mailTurn, { role: "tex" });
});

test("a job Tex names tex or advisor takes a name of its own", async () => {
  const fake = fakeNotes({ "projects/x/overview.md": "# X" });
  const { body } = await ask(fake, "/agent/job/note", { jobId: JOB, title: "Pricing", brief: "Price it.", note: { path: "projects/x/overview.md", name: "tex" } });
  assert.equal(body.name, "pricing");
  assert.deepEqual(fake.joins.map(({ name, job }) => [name, job]), [["pricing", JOB], ["tex", null], ["advisor", null]]);
});

test("every job is told who is on its note and what each is for", async () => {
  const fake = fakeNotes({ "projects/x/overview.md": "# X\n\n- 2026-11-05T13:00:00.000Z research (Tex) joined" });
  const { body } = await ask(fake, "/agent/job/note", { jobId: JOB, title: "Pricing", brief: "Price it.", note: { path: "projects/x/overview.md", name: "pricing" } });
  const roster = body.roster;
  assert.match(roster, /You are "pricing" on its mail, already joined/);
  assert.match(roster, /"tex": Tex, the only one who can reach the person\. Nobody else contacts them/);
  assert.match(roster, /"advisor": your advisor, a much stronger model that is always listening/);
  assert.match(roster, /judges whether you finished/);
  assert.match(roster, /"research": other jobs on parts of the same ask/);
  assert.match(roster, new RegExp(`mailbox "${body.mailbox}"`));
  assert.match(roster, /Never look for a saved login or password/);
  // The owner, 2026-11-06: a job joins other notes' mail, always under its own name.
  assert.match(roster, /join it with write action mail on that note, args \{ join: "[a-z0-9-]+" \}: you always join as/);
  assert.doesNotMatch(roster, /\b10\b|limit/i, "the advisor's limit is never told");
  // A cloud job's part reads it in place of the old join instruction.
  const prompt = jobPrompt(jobOf({ id: JOB, title: "Pricing", brief: "Price it.", project: { path: "projects/x/overview.md", name: "pricing" }, roster }));
  assert.match(prompt, /You are "pricing" on its mail, already joined/);
  assert.doesNotMatch(prompt, /Before anything else, join the mail/);
});

test("a group's job with no project of its own gets a note in its workspace's projects, with Tex and the advisor on its mail", async () => {
  // Job 350eddce (2026-11-06) ran from a group with no note: no mail, no advisor, and two parts spent looking for one.
  const fake = fakeNotes();
  const { body } = await ask(fake, "/agent/job/note", { jobId: JOB, title: "How Tex handles long chats", brief: "Read the code." }, texting({ actorClientId: "context_texts_group" }));
  assert.equal(body.ok, true);
  assert.match(body.path, /^projects\/tex-jobs\/how-tex-handles-long-chats-job000\.md$/);
  assert.equal(body.path, fallbackPath("How Tex handles long chats", JOB, { group: true }));
  assert.match(fake.notes.get(body.path), /^# How Tex handles long chats\n\nRead the code\./);
  assert.deepEqual(fake.joins.map((j) => j.name), ["how-tex-handles-long-cha", "tex", "advisor"]);
  assert.match(body.roster, /"advisor": your advisor/);
});

test("only the texting clients may ask for a job's note", async () => {
  const fake = fakeNotes();
  assert.equal((await ask(fake, "/agent/job/note", { jobId: JOB, title: "A", brief: "B" }, texting({ actorClientId: "some_ai_client" }))).status, 403);
  assert.equal((await ask(fake, "/agent/job/note", { jobId: JOB, title: "A", brief: "B" }, texting({ scopes: ["context:read"] }))).status, 403);
  assert.equal((await ask(fake, "/agent/job/note", { jobId: "x", title: "A", brief: "B" })).status, 400);
  assert.equal(fake.joins.length, 0);
});

test("the advisor answers a job's mail on the note, to that job, from its own mailbox", async () => {
  const fake = fakeNotes({ "tex/jobs/a.md": "# A\n\nRun it.\n- 2026-11-05T14:00:00.000Z a (Tex) to advisor [ask]: gh says device flow failed" });
  const seen = [];
  const advise = async (params) => (seen.push(params), { text: "Run gh auth login --web again and mail tex the new code.", usage: { input: 10, output: 5 } });
  const setup = { getSettings: async () => null };
  Object.assign(fake.store, setup);
  const { body } = await ask(fake, "/agent/job/advise", { jobId: JOB, note: { path: "tex/jobs/a.md" }, advisor: "mb_00000009", from: "a", question: "gh says device flow failed", title: "A", brief: "Run it." }, texting(), { advise });
  assert.equal(body.ok, true);
  assert.deepEqual(fake.sent, [{ text: "Run gh auth login --web again and mail tex the new code.", to: "a", mailbox: "mb_00000009", path: "tex/jobs/a.md" }]);
  assert.match(seen[0].messages[0].text, /a asks: gh says device flow failed/);
  assert.match(seen[0].messages[0].text, /<job_note>/);
  // It knows who is on the mail and what each is for, so it can hand work to coworkers (owner, 2026-11-05).
  assert.match(seen[0].messages[0].text, /On its mail: "a", "tex", "advisor"/);
  assert.match(seen[0].system, /mail\s+its coworker jobs to split the work/);
  assert.match(seen[0].system, /mail tex what the person must see/);
  // Its verdict, said without the model.
  fake.sent.length = 0;
  await ask(fake, "/agent/job/advise", { jobId: JOB, note: { path: "tex/jobs/a.md" }, advisor: "mb_00000009", from: "a", say: "My check of part 1: done." }, texting(), { advise: async () => assert.fail("no model for a verdict") });
  assert.deepEqual(fake.sent.map((line) => line.text), ["My check of part 1: done."]);
});

test("a line to tex or advisor reaches only the sender's own job, and nobody else's", async () => {
  const calls = [];
  const env = { TEXTING: { mailDeliver: async (call) => (calls.push(call), { taken: true }) } };
  const boxes = [
    { mailboxId: "mb_00000001", name: "pricing", jobId: "job-price-0001", own: true },
    { mailboxId: "mb_00000002", name: "research", jobId: "job-rsrch-0001", own: false },
  ];
  const line = { path: "p.md", at: "2026-11-05T14:00:00.000Z", from: "pricing", app: "Claude Code", to: "tex", mailKind: "note", text: "Open github.com/login/device and enter ABCD-1234." };
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, line), ["tex"]);
  assert.deepEqual(calls, [{ jobId: "job-price-0001", mailboxId: "mb_00000001", to: "tex", mail: { path: "p.md", at: line.at, from: "pricing", app: "Claude Code", kind: "note", text: line.text } }]);
  calls.length = 0;
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, { ...line, to: "advisor", mailKind: "ask" }), ["advisor"]);
  assert.equal(calls[0].jobId, "job-price-0001");
  calls.length = 0;
  // A job's box can't pass for Tex or the advisor: a line to everyone never reaches a box by those names.
  calls.length = 0;
  const posing = [...boxes, { mailboxId: "mb_00000003", name: "tex", jobId: "job-posed-0001", own: false }];
  await deliverMail(env, { jobMailboxes: async () => posing }, { ...line, from: "research", to: "everyone" });
  assert.ok(calls.every((call) => call.to !== "tex"), "no job box named tex is handed a line");
  calls.length = 0;
  // From another person's job, or a connection that never joined as a job: neither agent is reached.
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, { ...line, from: "research" }), []);
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, { ...line, from: "claude" }), []);
  assert.equal(calls.length, 0);
});

test("names and fallback paths stay plain", () => {
  assert.equal(jobName("Tex"), "job");
  assert.equal(jobName("  Fix THE flaky test!! "), "fix-the-flaky-test");
  assert.match(fallbackPath("../../etc", JOB), /^tex\/jobs\/etc-job000\.md$/);
  assert.match(rosterText({ path: "p.md", name: "a", mailbox: "mb_00000001" }), /^Your job note is p\.md\./);
});

test("the advisor's end-of-part check knows the job's note mail and its coworkers", () => {
  const roster = rosterText({ path: "projects/x/overview.md", name: "pricing", mailbox: "mb_00000001", others: ["research"] });
  const brief = jobCheckBrief({ job: { title: "Pricing", brief: "Price it.", doneWhen: "", attempt: 1, roster }, system: "", messages: [], answer: "", exhausted: false });
  assert.match(brief, /<job_note_mail>/);
  assert.match(brief, /split the work/);
  assert.match(brief, /"research": other jobs on parts of the same ask/);
  assert.doesNotMatch(jobCheckBrief({ job: { title: "A", brief: "B", attempt: 1 }, system: "", messages: [], answer: "", exhausted: false }), /job_note_mail/);
});

test("a computer part's brief always names its advisor, how to ask it, and that it checks the finish line", async () => {
  const { jobBackground } = await import("../src/machines/jobBackground.js");
  for (const actorClientId of ["context_texts", "context_texts_group"]) {
    const brief = jobBackground({ actorClientId }, { machineName: "dev2", fromOwner: true });
    assert.match(brief, /## Your advisor/);
    assert.match(brief, /kind "ask" and wait: 120/);
    assert.match(brief, /before you call the job finished/);
    assert.match(brief, /checks your final answer against the job's finish line/);
    assert.doesNotMatch(brief, /\b10\b|limit on asks|budget/i, "the advisor's limit is never told");
  }
});

test("the job's mail advisor leaves its step in the chat's ledger, tagged with the job (Dev2, 2026-11-13)", async () => {
  const fake = fakeNotes({ "tex/jobs/a.md": "# A\n\nRun it." });
  const appended = [];
  Object.assign(fake.store, { getSettings: async () => null, texLedger: () => ({ append: async (chat, entries) => appended.push(...entries.map((entry) => ({ chat, ...entry }))) }) });
  const advise = async () => ({ text: "Try the web login.", usage: { input: 1, output: 1 } });
  await ask(fake, "/agent/job/advise", { jobId: JOB, note: { path: "tex/jobs/a.md" }, advisor: "mb_00000009", from: "a", question: "it failed", title: "A" }, texting({ workspaceKind: "personal" }), { advise });
  const step = appended.find((entry) => entry.kind === "step");
  assert.ok(step, JSON.stringify(appended));
  assert.equal(step.step, "mailadv");
  assert.equal(step.chat, "texts");
  assert.equal(step.jobId, JOB);
  assert.deepEqual(step.input, { question: "it failed", from: "a" });
  assert.equal(step.output, "Try the web login.");
  assert.equal(step.ok, true);
});
