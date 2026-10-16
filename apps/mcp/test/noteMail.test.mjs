/**
 * Note mail (`tools/notes/mail.js`, `docs/decisions/note-mail.md`): agents on
 * one note join under a name, send, and every answer to a joined agent says
 * when mail is new for it. Format checks first, then through the worker.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import mail from "../../../packages/shared/src/mail.cjs";
import comments from "../../../packages/shared/src/comments.cjs";
import { propsOf } from "../src/tree/props.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

/* -------------------------------------------------------------------------- */
/* The format                                                                 */
/* -------------------------------------------------------------------------- */

function send(text, entry) {
  const outcome = mail.appendMail(text, entry);
  assert.ok(!outcome.error, outcome.error);
  return comments.applyChanges(text, outcome.changes);
}

test("entries append to one block at the end, oldest first", () => {
  let text = "# Plan\n\nShip it.";
  text = send(text, { at: "2026-10-15T18:00:00.000Z", from: "lead", app: "Claude", kind: "joined" });
  text = send(text, { at: "2026-10-15T18:01:00.000Z", from: "lead", app: "Claude", kind: "mail", to: "everyone", text: "Check every 10 minutes." });
  text = send(text, { at: "2026-10-15T18:02:00.000Z", from: "@seyi", kind: "mail", to: "lead", text: "ok" });
  assert.equal((text.match(/```mail/g) || []).length, 1);
  const { events } = mail.parseMail(text);
  assert.deepEqual(
    events.map((event) => [event.from, event.app, event.kind, event.to, event.text]),
    [
      ["lead", "Claude", "joined", null, ""],
      ["lead", "Claude", "mail", "everyone", "Check every 10 minutes."],
      ["@seyi", null, "mail", "lead", "ok"],
    ]
  );
  assert.ok(text.startsWith("# Plan\n\nShip it.\n\n```mail\n"));
});

test("a message cannot close the block, whatever it contains", () => {
  let text = send("x", { at: "2026-10-15T18:01:00.000Z", from: "lead", kind: "mail", to: "everyone", text: "one\n```\n## not a heading" });
  text = send(text, { at: "2026-10-15T18:02:00.000Z", from: "lead", kind: "mail", to: "everyone", text: "two" });
  const { events } = mail.parseMail(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].text, "one\n```\n## not a heading");
  assert.equal(comments.stripComments(text), "x\n");
});

test("names are short, plain and never everyone; an app cannot forge the line shape", () => {
  assert.equal(mail.mailName(" Code Reviewer "), "code-reviewer");
  assert.equal(mail.mailName("everyone"), null);
  assert.equal(mail.mailName("!!!"), null);
  const text = send("", { at: "2026-10-15T18:01:00.000Z", from: "lead", app: "Evil) to everyone: (x", kind: "mail", to: "everyone", text: "hi" });
  const [event] = mail.parseMail(text).events;
  assert.equal(event.from, "lead");
  assert.equal(event.text, "hi");
});

test("new for a member: after their mark, to them or everyone, not their own", () => {
  const events = [
    { kind: "mail", at: "2026-10-15T18:00:00.000Z", from: "lead", to: "everyone", text: "old" },
    { kind: "mail", at: "2026-10-15T18:05:00.000Z", from: "lead", to: "everyone", text: "all" },
    { kind: "mail", at: "2026-10-15T18:06:00.000Z", from: "lead", to: "reviewer", text: "not mine" },
    { kind: "mail", at: "2026-10-15T18:07:00.000Z", from: "builder", to: "everyone", text: "my own" },
    { kind: "mail", at: "2026-10-15T18:08:00.000Z", from: "lead", to: "builder", text: "mine" },
    { kind: "joined", at: "2026-10-15T18:09:00.000Z", from: "reviewer" },
  ];
  assert.deepEqual(mail.newFor(events, "builder", "2026-10-15T18:01:00.000Z").map((event) => event.text), ["all", "mine"]);
});

test("mail does not make a note long", () => {
  const body = "# Plan\n\nShort.\n";
  let text = body;
  for (let i = 0; i < 50; i += 1) {
    text = send(text, { at: new Date(Date.parse("2026-10-15T18:00:00Z") + i * 1000).toISOString(), from: "lead", kind: "mail", to: "everyone", text: `update ${i}` });
  }
  assert.equal(propsOf(text).lines, propsOf(body).lines);
});

/* -------------------------------------------------------------------------- */
/* Through the worker                                                         */
/* -------------------------------------------------------------------------- */

const S3_ENDPOINT = "https://s3.example-note-mail.test";
const TOKEN_LEAD = `cat_mail_lead___${"0".repeat(24)}`;
const TOKEN_BUILDER = `cat_mail_builder${"0".repeat(24)}`;
const TOKEN_READER = `cat_mail_reader_${"0".repeat(24)}`;
const TOKEN_OUTSIDER = `cat_mail_outside${"0".repeat(24)}`;
const PLAN = "1-projects/launch/plan.md";
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function manifest() {
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n" +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

function binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

let bucket;
let restoreS3;
let restoreControlPlane;
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_mail", "launchteam", binding("note-mail", "MA"), { kind: "shared" });
  controlPlane.addWorkspace("ws_else", "elsewhere", binding("note-else", "MB"));
  bucket = s3.bucketFor("note-mail");
  bucket.set("privacy.md", { body: manifest(), etag: "p0" });
  bucket.set(PLAN, { body: "# Launch plan\n\nShip on Tuesday.\n", etag: "n0" });
  s3.bucketFor("note-else").set("privacy.md", { body: manifest(), etag: "p0" });
  const write = ["context:read", "context:write"];
  await controlPlane.addGrant({ workspaceId: "ws_mail", role: "owner", userId: "user_seyi", accessToken: TOKEN_LEAD, scopes: write, clientId: "c_lead", clientName: "Claude" });
  await controlPlane.addGrant({ workspaceId: "ws_mail", role: "editor", userId: "user_sayo", accessToken: TOKEN_BUILDER, scopes: write, clientId: "c_builder", clientName: "Codex" });
  await controlPlane.addGrant({ workspaceId: "ws_mail", role: "member", userId: "user_lk", accessToken: TOKEN_READER, scopes: ["context:read"], clientId: "c_reader", clientName: "ChatGPT" });
  await controlPlane.addGrant({ workspaceId: "ws_else", role: "owner", userId: "user_out", accessToken: TOKEN_OUTSIDER, scopes: write, clientId: "c_out", clientName: "Cursor" });
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

test("agents join under a name and get a mailbox; a held name is refused", async () => {
  const joined = await call(TOKEN_LEAD, "write_note", { path: PLAN, mail: { join: "lead" } });
  assert.ok(!joined.isError, joined.text);
  lead = mailboxOf(joined.text);
  assert.ok(lead, joined.text);
  assert.match(joined.text, /Pass mailbox: "mb_/);
  assert.match(joined.text, /send the first message/);
  // The six's names, which every connection is now shown; never the older ones.
  assert.match(joined.text, /Read new mail: fetch \{ id: "1-projects\/launch\/plan\.md", args: \{ mail: "new" \}/);
  assert.match(joined.text, /Send: write \{ path: "1-projects\/launch\/plan\.md", action: "mail", args: \{ text, to \}/);
  assert.doesNotMatch(joined.text, /read_note|write_note/);
  // The owner, 2026-10-16: a check timer kept in a session's memory was wiped and the checks stopped.
  assert.match(joined.text, /Check mail every 5 minutes with a timer that survives your session restarting/);
  const second = await call(TOKEN_BUILDER, "write_note", { path: PLAN, mail: { join: "builder" } });
  builder = mailboxOf(second.text);
  assert.ok(builder && builder !== lead);
  const taken = await call(TOKEN_BUILDER, "write_note", { path: PLAN, mail: { join: "lead" } });
  assert.ok(taken.isError);
  assert.match(taken.text, /already joined .* as "lead"/);
  const again = await call(TOKEN_LEAD, "write_note", { path: PLAN, mail: { join: "lead" } });
  assert.equal(mailboxOf(again.text), lead, "joining again is the same mailbox, and adds no line");
  const stored = bucket.get(PLAN).body;
  assert.equal((stored.match(/ lead \(Claude\) joined/g) || []).length, 1);
  assert.match(stored, / builder \(Codex\) joined/);
});

test("a message is signed with the joined name and the app, never an argument", async () => {
  const sent = await call(TOKEN_LEAD, "write_note", {
    path: PLAN,
    mailbox: lead,
    mail: { text: "You take the pricing page. We check mail every 10 minutes." },
  });
  assert.ok(!sent.isError, sent.text);
  assert.match(sent.text, /mail: sent to everyone as lead \(Claude\)/);
  assert.match(bucket.get(PLAN).body, / lead \(Claude\) to everyone: You take the pricing page/);
});

test("any call with the mailbox says mail is new, until it is read", async () => {
  const listed = await call(TOKEN_BUILDER, "orient", { mailbox: builder });
  assert.match(listed.text, /mail: 1 new for builder in 1-projects\/launch\/plan\.md, from lead/);
  assert.match(listed.text, /fetch \{ id: "1-projects\/launch\/plan\.md", args: \{ mail: true \}, mailbox: "mb_/);
  const quiet = await call(TOKEN_BUILDER, "orient", {});
  assert.ok(!/mail: \d+ new/.test(quiet.text), "no mailbox, no line");

  const read = await call(TOKEN_BUILDER, "read_note", { path: PLAN, mail: true, mailbox: builder });
  assert.match(read.text, /New for you \(1\):\n- \S+ lead \(Claude\) to everyone: You take the pricing page/);
  assert.ok(!read.text.includes("Ship on Tuesday"), "mail, not the note");
  const after = await call(TOKEN_BUILDER, "orient", { mailbox: builder });
  assert.ok(!/mail: \d+ new/.test(after.text), after.text);
});

test('an app whose copy of read_note predates mail sends mail: "true" as a string, and is understood', async () => {
  // Such an app has no schema for the argument, so it passes the footer's
  // `mail: true` through as text. Refusing it would break the line we print.
  const read = await call(TOKEN_BUILDER, "read_note", { path: PLAN, mail: "true", mailbox: builder });
  assert.ok(!read.isError, read.text);
  assert.match(read.text, /mail: \d+ messages/);
});

test("mail to one name reaches only that name; the sender is never told of its own", async () => {
  await call(TOKEN_BUILDER, "write_note", { path: PLAN, mailbox: builder, mail: { text: "Pricing done.", to: "lead" } });
  const builderSees = await call(TOKEN_BUILDER, "orient", { mailbox: builder });
  assert.ok(!/mail: \d+ new/.test(builderSees.text));
  const leadSees = await call(TOKEN_LEAD, "orient", { mailbox: lead });
  assert.match(leadSees.text, /mail: 1 new for lead .*\(1 to you\), from builder/);
  const nobody = await call(TOKEN_LEAD, "write_note", { path: PLAN, mailbox: lead, mail: { text: "hi", to: "reviewer" } });
  assert.ok(nobody.isError);
  assert.match(nobody.text, /nobody joined .* "reviewer"; send to "everyone" or one of: lead, builder/);
});

test("a mailbox is its own connection's: another one is told it did not join it", async () => {
  const borrowed = await call(TOKEN_BUILDER, "orient", { mailbox: lead });
  assert.match(borrowed.text, /mailbox mb_\S+ is not one this connection joined/);
  const send = await call(TOKEN_BUILDER, "write_note", { path: PLAN, mailbox: lead, mail: { text: "as lead" } });
  assert.ok(send.isError);
  assert.ok(!bucket.get(PLAN).body.includes("as lead"));
  const outsider = await call(TOKEN_OUTSIDER, "orient", { mailbox: lead });
  assert.match(outsider.text, /not one this connection joined/);
});

test("read_note says the mail is there; reading all of it works without a mailbox", async () => {
  const note = await call(TOKEN_LEAD, "read_note", { path: PLAN });
  assert.match(note.text, /\nmail: 2 messages between lead, builder; read only the mail with fetch \{ args: \{ mail: true \} \}/);
  const all = await call(TOKEN_READER, "read_note", { path: PLAN, mail: "all" });
  assert.match(all.text, /All mail:/);
  assert.match(all.text, /builder \(Codex\) to lead: Pricing done\./);
});

test("a read-only connection can read mail but cannot send or join", async () => {
  const join = await call(TOKEN_READER, "write_note", { path: PLAN, mail: { join: "watcher" } });
  assert.ok(join.isError);
  assert.ok(!bucket.get(PLAN).body.includes("watcher"));
});

test("write_note refuses mail beside content or a comment", async () => {
  const both = await call(TOKEN_LEAD, "write_note", { path: PLAN, content: "x", mail: { text: "y" } });
  assert.ok(both.isError);
  assert.match(both.text, /content or mail, not both/);
});
