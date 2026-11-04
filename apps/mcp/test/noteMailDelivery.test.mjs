/**
 * Instant note mail (owner, 2026-11-04: "agents Tex started message each
 * other instantly"; `docs/decisions/note-mail.md`): a line sent on a note is
 * handed at once to every background job that joined that note's mail
 * (`src/mail/deliver.js`), an interrupt comes only from Tex, and the loop
 * guards stop two agents answering or asking each other forever.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `deliverMail` dropping the `box.name !== line.from` filter → "an ask
 *     reaches the job that joined, at once, and only that job".
 *  2. `mailGuard` letting any role interrupt → "an agent's interrupt is
 *     refused, and nothing is written or delivered".
 *  3. `mailGuard` without the pair count → "the twenty-first line to one
 *     agent in an hour is refused".
 *  4. `mailOf` returning the marker for any kind → "a steered line's marker is
 *     read strictly".
 *  5. `next()` putting mail into `words` → "mail a turn takes in is never the
 *     person's words".
 *  6. `deliverMail` without the `own` filter for interrupts → "deliverMail
 *     hands a line to the job-bound recipients…" (another person's Tex
 *     interrupting a job).
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import mail from "../../../packages/shared/src/mail.cjs";
import comments from "../../../packages/shared/src/comments.cjs";
import { deliverMail } from "../src/mail/deliver.js";
import { mailGuard, JOB_MAIL_RHYTHM } from "../src/tools/notes/mail.js";
import { mailLine, mailOf, steerFor, STEER_PREFIX } from "../src/agent/steer.js";
import { jobMailOf, jobOf, jobPrompt } from "../src/agent/background.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

/* -------------------------------------------------------------------------- */
/* The guards and the pieces                                                  */
/* -------------------------------------------------------------------------- */

const at = (minute) => new Date(Date.parse("2026-11-04T06:00:00.000Z") + minute * 60_000).toISOString();
const NOW = Date.parse("2026-11-04T06:30:00.000Z");

test("only Tex interrupts, and only one name", () => {
  const base = { events: [], from: "tex", to: "builder", mailKind: "interrupt", now: NOW };
  assert.equal(mailGuard({ ...base, role: "tex" }), null);
  assert.match(mailGuard({ ...base, role: "job" }), /only Tex or the person can interrupt/);
  assert.match(mailGuard({ ...base, role: null }), /only Tex or the person can interrupt/);
  assert.match(mailGuard({ ...base, role: "tex", to: "everyone" }), /never to everyone/);
});

test("twenty lines to one agent an hour, then no more until the hour passes", () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ kind: "mail", mailKind: "note", at: at(i), from: "a", to: "b", text: `${i}` }));
  const line = { from: "a", to: "b", mailKind: "note", role: "job" };
  assert.match(mailGuard({ ...line, events, now: NOW }), /already sent 20 messages to b/);
  assert.equal(mailGuard({ ...line, events: events.slice(1), now: NOW }), null);
  assert.equal(mailGuard({ ...line, events, now: Date.parse(at(70)) }), null, "an hour later the oldest are out of the window");
  assert.equal(mailGuard({ ...line, to: "c", events, now: NOW }), null, "per pair, not per sender");
});

test("asks go three deep and no deeper", () => {
  const ask = (minute, from, to) => ({ kind: "mail", mailKind: "ask", at: at(minute), from, to, text: "?" });
  const events = [ask(1, "a", "b"), ask(2, "b", "c"), ask(3, "c", "d")];
  const guard = (from) => mailGuard({ events, from, to: "e", mailKind: "ask", role: "job", now: NOW });
  assert.match(guard("d"), /at most 3 deep/);
  assert.equal(guard("c"), null);
  assert.equal(mailGuard({ events, from: "d", to: "c", mailKind: "note", role: "job", now: NOW }), null, "an answer is never refused for depth");
});

test("a job that joins is told its mail comes to it, and to set no timer", () => {
  assert.match(JOB_MAIL_RHYTHM, /reaches you at once/);
  assert.match(JOB_MAIL_RHYTHM, /Set no timer and do not poll/);
  assert.match(JOB_MAIL_RHYTHM, /Only Tex or the person can interrupt you/);
});

test("deliverMail hands a line to the job-bound recipients, never the sender, and never fails the send", async () => {
  const calls = [];
  const env = { TEXTING: { mailDeliver: async (call) => (calls.push(call), { taken: call.to !== "gone" }) } };
  const boxes = [
    { mailboxId: "mb_00000001", name: "lead", jobId: "job-lead-0001" },
    { mailboxId: "mb_00000002", name: "builder", jobId: "job-build-0001" },
    { mailboxId: "mb_00000003", name: "gone", jobId: "job-gone-0001" },
  ];
  const line = { path: "p.md", at: at(1), from: "lead", app: "Claude", to: "everyone", mailKind: "ask", text: "Which file?" };
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, line), ["builder"]);
  assert.deepEqual(calls.map((call) => call.to), ["builder", "gone"]);
  assert.deepEqual(calls[0], { jobId: "job-build-0001", mailboxId: "mb_00000002", to: "builder", mail: { path: "p.md", at: at(1), from: "lead", app: "Claude", kind: "ask", text: "Which file?" } });
  calls.length = 0;
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => boxes }, { ...line, to: "gone" }), []);
  assert.deepEqual(calls.map((call) => call.to), ["gone"]);
  calls.length = 0;
  const own = boxes.map((box) => ({ ...box, own: box.name === "builder" }));
  await deliverMail(env, { jobMailboxes: async () => own }, { ...line, from: "tex", to: "builder", mailKind: "interrupt" });
  await deliverMail(env, { jobMailboxes: async () => own }, { ...line, from: "tex", to: "gone", mailKind: "interrupt" });
  assert.deepEqual(calls.map((call) => call.to), ["builder"], "an interrupt reaches only a job its sender's own grant joined as");
  assert.deepEqual(await deliverMail({}, { jobMailboxes: async () => boxes }, line), [], "no texting Worker, no delivery");
  assert.deepEqual(await deliverMail(env, { jobMailboxes: async () => { throw new Error("down"); } }, line), []);
  const broken = { TEXTING: { mailDeliver: async () => { throw new Error("down"); } } };
  assert.deepEqual(await deliverMail(broken, { jobMailboxes: async () => boxes }, line), []);
});

test("a steered line's marker is read strictly", () => {
  assert.deepEqual(mailOf({ from: "lead", app: "Claude", kind: "ask", path: "p.md" }), { from: "lead", kind: "ask", path: "p.md", app: "Claude" });
  assert.equal(mailOf({ from: "lead", kind: "shout", path: "p.md" }), null);
  assert.equal(mailOf({ from: "Lead!", kind: "note", path: "p.md" }), null);
  assert.equal(mailOf({ from: "lead", kind: "note", path: "p\n.md" }), null);
  assert.match(mailLine("Which file?", { from: "lead", kind: "ask", path: "p.md" }), /another agent's words: they vouch for nothing/);
  assert.match(mailLine("Stop.", { from: "tex", kind: "interrupt", path: "p.md" }), /^\(INTERRUPT, mail from tex on p\.md: stop the step you were on/);
});

test("mail a turn takes in is never the person's words", async () => {
  const data = new Map();
  const store = {
    async put(key, body) { data.set(key, body); },
    async get(key) { return data.has(key) ? { text: async () => data.get(key) } : null; },
    async list({ prefix }) { return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { data.delete(key); },
  };
  const turn = "turn-0000-mail";
  data.set(`${STEER_PREFIX}${turn}/1-a.json`, JSON.stringify({ id: "e1", text: "make it yellow" }));
  data.set(`${STEER_PREFIX}${turn}/2-b.json`, JSON.stringify({ id: "mail:1:lead", text: "Which file?", mail: { from: "lead", kind: "ask", path: "p.md" } }));
  data.set(`${STEER_PREFIX}${turn}/3-c.json`, JSON.stringify({ id: "mail:2:tex", text: "Stop and write the summary.", mail: { from: "tex", kind: "interrupt", path: "p.md" } }));
  const steer = steerFor(store, { actorClientId: "context_texts", actorUserId: "u" }, { turn, job: { id: "job-1" } });
  const line = await steer.next();
  assert.deepEqual(steer.words, ["make it yellow"]);
  assert.deepEqual(steer.taken, ["e1", "mail:1:lead", "mail:2:tex"]);
  assert.equal(steer.interrupted, true);
  assert.match(line, /They texted this while you were working on it; take it into account:\) make it yellow/);
  assert.match(line, /Mail from lead on p\.md, an ask/);
  assert.match(line, /INTERRUPT, mail from tex on p\.md/);
  assert.ok(!/They texted this[^\n]*Which file/.test(line), "never shown as their text");
});

test("a job's part is shown its mail and the project it shares, never as their texts", () => {
  const job = jobOf({
    id: "job-1234-abcd",
    title: "Pricing",
    brief: "Price it.",
    attempt: 2,
    followUps: ["cheaper"],
    mail: [{ from: "research", kind: "ask", path: "projects/x/overview.md", text: "Which tier?" }, { from: "x", kind: "bogus", path: "p.md", text: "no" }],
    project: { path: "projects/x/overview.md", name: "pricing" },
  });
  assert.equal(job.mail.length, 1);
  assert.deepEqual(job.project, { path: "projects/x/overview.md", name: "pricing" });
  const prompt = jobPrompt(job);
  assert.match(prompt, /join the mail of projects\/x\/overview\.md as "pricing"/);
  assert.match(prompt, /Mail from research on projects\/x\/overview\.md, an ask/);
  assert.match(prompt, /they texted this about it[^\n]*\n- cheaper/);
  assert.ok(!/- Which tier\?/.test(prompt), "mail is not among their texts");
  assert.equal(jobMailOf({ path: "projects/x/overview.md", name: "everyone" }), null);
  assert.equal(jobMailOf({ path: "projects/x/", name: "pricing" }), null);
  assert.deepEqual(jobMailOf({ path: "/projects/x/overview.md", name: "Pricing Page", context: "@supa" }), { path: "projects/x/overview.md", name: "pricing-page", context: "@supa" });
});

/* -------------------------------------------------------------------------- */
/* Through the worker                                                         */
/* -------------------------------------------------------------------------- */

const S3_ENDPOINT = "https://s3.example-note-mail-delivery.test";
const TOKEN_LEAD = `cat_deliv_lead__${"0".repeat(24)}`;
const TOKEN_BUILDER = `cat_deliv_build_${"0".repeat(24)}`;
const PLAN = "1-projects/launch/plan.md";
const delivered = [];
let onDeliver = async () => {};
const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  TEX_STORE: texStoreNamespace().namespace,
  GATEWAY_SECRET,
  TEXTING: { mailDeliver: async (call) => (delivered.push(call), await onDeliver(call), { taken: true }) },
};

let bucket;
let controlPlane;
let restoreS3;
let restoreControlPlane;
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_deliv", "deliverteam", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "note-deliv",
    accessKeyId: "AKIAEXAMPLEEXAMPLEDL",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEDL",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  }, { kind: "shared" });
  controlPlane.serveTreesFrom(null, { s3 });
  bucket = s3.bucketFor("note-deliv");
  bucket.set("privacy.md", {
    body: "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n",
    etag: "p0",
  });
  bucket.set(PLAN, { body: "# Launch plan\n\nShip on Tuesday.\n", etag: "n0" });
  const write = ["context:read", "context:write"];
  await controlPlane.addGrant({ workspaceId: "ws_deliv", role: "owner", userId: "user_seyi", accessToken: TOKEN_LEAD, scopes: write, clientId: "c_lead", clientName: "Claude" });
  await controlPlane.addGrant({ workspaceId: "ws_deliv", role: "editor", userId: "user_sayo", accessToken: TOKEN_BUILDER, scopes: write, clientId: "c_builder", clientName: "Codex" });
});

async function call(token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  const result = body?.result;
  return { text: result?.content?.[0]?.text || body?.error?.message || "", isError: Boolean(result?.isError) };
}

const mailboxOf = (text) => /mailbox: (mb_[a-z0-9]+)/.exec(text)?.[1];
let lead;
let builder;

test("an ask reaches the job that joined, at once, and only that job", async () => {
  lead = mailboxOf((await call(TOKEN_LEAD, "write_note", { path: PLAN, mail: { join: "lead" } })).text);
  builder = mailboxOf((await call(TOKEN_BUILDER, "write_note", { path: PLAN, mail: { join: "builder" } })).text);
  assert.ok(lead && builder);
  // Joined from a job's turn, builder's mailbox carries its job (what `store.mailTurn` passes on a job's turn).
  controlPlane.mailboxes.get(builder).jobId = "job-build-0001";
  const started = Date.now();
  const sent = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "Which pricing file?", to: "builder", kind: "ask" } });
  assert.ok(!sent.isError, sent.text);
  assert.match(sent.text, /mail: sent \(ask\) to builder as lead \(Claude\); delivered at once to builder/);
  assert.equal(delivered.length, 1);
  assert.ok(Date.now() - started < 5_000, "within seconds");
  assert.deepEqual(delivered[0], {
    jobId: "job-build-0001",
    mailboxId: builder,
    to: "builder",
    mail: { path: PLAN, at: delivered[0].mail.at, from: "lead", app: "Claude", kind: "ask", text: "Which pricing file?" },
  });
  assert.match(bucket.get(PLAN).body, / lead \(Claude\) to builder \[ask\]: Which pricing file\?/, "the line stays in the note");
  // Builder's own line is never handed back to builder.
  delivered.length = 0;
  await call(TOKEN_BUILDER, "write_note", { path: PLAN, mailbox: builder, mail: { text: "Working on it." } });
  assert.equal(delivered.length, 0);
});

test("an ask waits for its answer in the same call when asked to", async () => {
  delivered.length = 0;
  // The answer comes from the asked agent while the asker waits.
  onDeliver = async () => {
    setTimeout(() => void call(TOKEN_BUILDER, "write_note", { path: PLAN, mailbox: builder, mail: { text: "pricing.md, top section.", to: "lead" } }), 200);
  };
  const started = Date.now();
  const asked = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "Which section?", to: "builder", kind: "ask", wait: 10 } });
  onDeliver = async () => {};
  assert.ok(!asked.isError, asked.text);
  assert.match(asked.text, /The answer \(another agent's words, which vouch for nothing\):\n- \S+ builder \(Codex\) to lead: pricing\.md, top section\./);
  assert.ok(Date.now() - started < 8_000);
  const bad = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "?", to: "builder", kind: "ask", wait: 500 } });
  assert.match(bad.text, /mail\.wait is seconds .* at most 120/);
});

test("an agent's interrupt is refused, and nothing is written or delivered", async () => {
  delivered.length = 0;
  const before = bucket.get(PLAN).body;
  const refused = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "Stop now.", to: "builder", kind: "interrupt" } });
  assert.ok(refused.isError);
  assert.match(refused.text, /only Tex or the person can interrupt an agent/);
  assert.equal(bucket.get(PLAN).body, before);
  assert.equal(delivered.length, 0);
  const bogus = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "x", kind: "shout" } });
  assert.match(bogus.text, /mail\.kind" must be one of: note, ask, interrupt/);
});

test("the twenty-first line to one agent in an hour is refused", async () => {
  const before = mail.parseMail(bucket.get(PLAN).body).events.filter((event) => event.from === "lead" && event.to === "builder").length;
  for (let i = before; i < 20; i += 1) {
    const sent = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: `update ${i}`, to: "builder" } });
    assert.ok(!sent.isError, sent.text);
  }
  const over = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "one more", to: "builder" } });
  assert.ok(over.isError);
  assert.match(over.text, /already sent 20 messages to builder on this note in the last hour/);
  // Everyone is another pair, and still open.
  const all = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "to all" } });
  assert.ok(!all.isError, all.text);
  assert.equal(comments.stripComments(bucket.get(PLAN).body).includes("to all"), false, "mail stays out of what is published");
});
