/**
 * Tex in mail (Dev, 2026-11-27: "Tex in mail should be the same flow as tex in comments I feel, its own mini tex";
 * `docs/decisions/note-mail.md`): a line sent to a person's own Tex on a note wakes their Tex store
 * (`src/mail/deliver.js`), whose alarm hands the owner to the texting Worker (`texStore/dispatch.js`), which has the
 * gateway run `/tex/mail-run` (`agent/mailRunRoute.js`): the new lines answered the way Tex answers in comments, and the
 * answer sent back as mail from "tex".
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `wakeTex` without the `line.from === "tex"` check → "Tex's own line, and a line to someone else, wake nothing".
 *  2. `mailTurn` without `newFor`'s read mark → "only the lines new since the mailbox last read are the ask".
 *  3. the route without the mailbox's path check → "a mailbox on another note, or not its own, is refused".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import mail from "../../../packages/shared/src/mail.cjs";
import { deliverMail, TEX_MAIL_ALARM } from "../src/mail/deliver.js";
import { routineDispatchFor } from "../../../packages/tex/gateway/texStore/dispatch.js";
import { handleMailRun, mailTurn, standInsFor } from "../../../packages/tex/gateway/agent/mailRunRoute.js";
import { noteRunTools } from "../../../packages/tex/gateway/agent/noteRun.js";
import { sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { WITHHELD_TOOLS } from "../../../packages/tex/gateway/agent/textingWrites.js";
import { attentionToolDefinitions } from "../src/tools/schemas/attention.js";

const PATH = "areas/growth/mail/tex.md";
const OWNER = "ws_dev_personal";
const BOX = "mb_0123456789abcdef";

/** A Tex store namespace that records each schedule call. */
function texStores() {
  const scheduled = [];
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (request) => {
        const call = JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "null"));
        scheduled.push({ name: id.name, owner: request.headers.get("x-tex-owner"), op: call?.op, body: JSON.parse(await request.text()) });
        return Response.json({ ok: true });
      },
    }),
  };
  return { env: { TEX_STORE: namespace }, scheduled };
}

const line = (fields = {}) => ({ path: PATH, at: "2026-11-27T19:00:00.000Z", from: "pablo", app: "Pablo (@seyi's)", to: "tex", mailKind: "note", text: "send me Seyi's raw thought", ...fields });
const texBox = { mailboxId: BOX, name: "tex", texChat: true, own: false };

test("a line to a person's own Tex wakes their Tex store at once, with the owner and the mailbox and no words", async () => {
  const { env, scheduled } = texStores();
  const asked = [];
  const mailbox = { jobMailboxes: async () => [texBox], askTex: async (path, mailboxId) => (asked.push([path, mailboxId]), OWNER) };
  assert.deepEqual(await deliverMail(env, mailbox, line()), ["tex"]);
  assert.deepEqual(asked, [[PATH, BOX]]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].owner, `person:${OWNER}`);
  assert.equal(scheduled[0].op, "schedule");
  assert.equal(scheduled[0].body.id, `${TEX_MAIL_ALARM}${BOX}`);
  assert.deepEqual(scheduled[0].body.payload, { owner: `person:${OWNER}`, mail: BOX });
  assert.ok(!JSON.stringify(scheduled[0].body).includes("raw thought"), "the alarm carries no mail");
  // A line to everyone wakes it too.
  assert.deepEqual(await deliverMail(env, mailbox, line({ to: "everyone" })), ["tex"]);
});

test("Tex's own line, a line to someone else, Tex's own box, and a refusal wake nothing", async () => {
  const { env, scheduled } = texStores();
  let asks = 0;
  const mailbox = (boxes, owner = OWNER) => ({ jobMailboxes: async () => boxes, askTex: async () => (asks += 1, owner) });
  assert.deepEqual(await deliverMail(env, mailbox([texBox]), line({ from: "tex", to: "pablo" })), []);
  assert.deepEqual(await deliverMail(env, mailbox([texBox]), line({ from: "tex", to: "everyone" })), []);
  assert.deepEqual(await deliverMail(env, mailbox([texBox]), line({ from: "pablo", to: "quill" })), []);
  assert.deepEqual(await deliverMail(env, mailbox([{ ...texBox, own: true }]), line()), []);
  assert.deepEqual(await deliverMail(env, mailbox([{ ...texBox, texChat: undefined }]), line()), []);
  assert.equal(asks, 0);
  assert.deepEqual(await deliverMail(env, mailbox([texBox], null), line()), []);
  assert.equal(scheduled.length, 0);
});

test("the Tex store's alarm for mail hands the owner alone to the texting Worker, and is done", async () => {
  const calls = [];
  const dispatch = routineDispatchFor({ TEXTING: { texMailDue: async (call) => (calls.push(call), { ran: 1 }), routineDue: async () => assert.fail("not a routine") } });
  assert.deepEqual(await dispatch({ id: `${TEX_MAIL_ALARM}${BOX}`, at: 0, payload: { owner: `person:${OWNER}`, mail: BOX } }), { next: null });
  assert.deepEqual(calls, [{ owner: `person:${OWNER}` }]);
  await assert.rejects(routineDispatchFor({ TEXTING: {} })({ id: "mail:x", payload: { owner: `person:${OWNER}`, mail: BOX } }));
});

/** A note whose mail has these lines, written as the note format writes them. */
function noteWith(entries) {
  let text = "# Growth\n\nNotes.\n";
  for (const entry of entries) {
    const outcome = mail.appendMail(text, entry);
    text = outcome.changes.reduce((words, change) => words.slice(0, change.from) + change.insert + words.slice(change.to), text);
  }
  return text;
}

test("only the lines new since the mailbox last read are the ask; the lines before are the thread", () => {
  const note = noteWith([
    { kind: "mail", from: "tex", app: "Tex", to: "pablo", text: "Here is the folder.", mailKind: "note", at: "2026-11-27T18:09:00.000Z" },
    { kind: "mail", from: "pablo", app: "Pablo (@seyi's)", to: "tex", text: "Got it. What is Seyi's raw thought?", mailKind: "note", at: "2026-11-27T18:10:00.000Z", used: 1 },
  ]);
  const turn = mailTurn(note, "2026-11-27T18:09:30.000Z");
  assert.equal(turn.to, "pablo");
  assert.match(turn.ask, /^pablo \(Pablo @seyi's\): Got it\. What is Seyi's raw thought\?/);
  assert.deepEqual(turn.history, [{ who: "tex (Tex)", body: "Here is the folder." }]);
  assert.equal(mailTurn(note, "2026-11-27T18:10:00.000Z"), null, "nothing new since the mark");
});

/** The route's session, store and dispatch, with the note above and one new line. */
function routeWorld({ session = {}, box = {}, answer = "Seyi's raw thought is in resources/glaze-ideas/thought.md." } = {}) {
  const note = noteWith([{ kind: "mail", from: "pablo", app: "Pablo (@seyi's)", to: "tex", text: "What's the raw thought?", mailKind: "note", at: "2026-11-27T18:10:00.000Z", used: 1 }]);
  const calls = [];
  const runs = [];
  const read = [];
  const store = {
    mail: {
      get: async () => ({ mailboxId: BOX, name: "tex", workspaceId: "ws_team", path: PATH, readThrough: "2026-11-27T18:00:00.000Z", ...box }),
      read: async (mailboxId, at) => read.push([mailboxId, at]),
    },
  };
  const live = {
    actorClientId: "context_texts",
    workspaceKind: "personal",
    role: "owner",
    workspaceId: "ws_dev",
    workspaces: [{ workspaceId: "ws_dev" }, { workspaceId: "ws_team", slug: "team" }],
    ...session,
  };
  const dispatched = [];
  const deps = {
    mailRunNode: () => ({ id: "mailRun", on: true }),
    dispatchFor: (_store, given) => (dispatched.push(given), async (name, args) => {
      calls.push([name, args]);
      if (name === "read_note") return { content: [{ type: "text", text: `etag: e1\npath: ${PATH}\nvisibility: team\n\n${note}` }] };
      return { content: [{ type: "text", text: "ok" }] };
    }),
    offeredFor: async () => [],
    ledgerOf: () => null,
    controlPlane: {},
    runNoteRun: async (input) => (runs.push(input), { outcome: "answered", answer }),
  };
  const request = (body = { workspaceId: "ws_team", path: PATH, mailboxId: BOX }) => new Request("https://gateway/tex/mail-run", { method: "POST", body: JSON.stringify(body) });
  return { run: (body) => handleMailRun(request(body), store, live, "/tex/mail-run", {}, null, deps), calls, runs, read, dispatched };
}

/**
 * A mail run's whole ask is somebody else's mail line, so there are no words of the person's behind it. `judgedGate`
 * (`src/tools/session.js`) judges a run of ours with no turn on "" and refuses every widening; without the mark it
 * falls back to the model's own `person_said`, which on this path can only be words the model lifted from that line
 * (and `parseMail` takes a line's `from` from the note's Markdown, so it can claim to be the person). Same mark as a
 * heartbeat, a nightly and a try-it run.
 */
test("a mail run is one of ours with nobody behind it, so the sharing judge is given no words", async () => {
  const world = routeWorld();
  assert.deepEqual(await (await world.run()).json(), { outcome: "answered", sent: true });
  for (const session of [world.runs[0].session, ...world.dispatched]) {
    assert.equal(session?.egress?.complete, true, "marked as one of our own runs");
    assert.equal(session?.egress?.turn, undefined, "no person's turn behind it");
  }
});

test("a run answers the new lines the way Tex answers in comments, and sends the answer back to who wrote, as tex", async () => {
  const world = routeWorld();
  const answered = await world.run();
  assert.deepEqual(await answered.json(), { outcome: "answered", sent: true });
  assert.equal(world.runs.length, 1);
  assert.match(world.runs[0].ask, /What's the raw thought\?/);
  assert.equal(world.runs[0].workspace, "@team");
  assert.equal(world.runs[0].audience, "the team it is shared with");
  assert.equal(world.runs[0].full, true, "the person's own connection, in full");
  assert.deepEqual(world.read, [[BOX, "2026-11-27T18:10:00.000Z"]], "read through the line it answers");
  const sent = world.calls.find(([name]) => name === "write_note");
  assert.deepEqual(sent, ["write_note", { path: PATH, context: "@team", mail: { text: "Seyi's raw thought is in resources/glaze-ideas/thought.md.", to: "pablo", used: 0 } }]);
});

test("nothing new is nothing: no model, no mail", async () => {
  const world = routeWorld({ box: { readThrough: "2026-11-27T18:30:00.000Z" } });
  assert.deepEqual(await (await world.run()).json(), { outcome: "nothing", sent: false });
  assert.equal(world.runs.length, 0);
  assert.equal(world.calls.some(([name]) => name === "write_note"), false);
});

test("only the texting client, as owner, may run; a mailbox on another note, or not its own, is refused", async () => {
  for (const session of [{ actorClientId: "context_console" }, { workspaceKind: "shared" }, { role: "member" }]) {
    assert.equal((await routeWorld({ session }).run()).status, 403);
  }
  assert.equal((await routeWorld({ box: { path: "other.md" } }).run()).status, 403);
  assert.equal((await routeWorld({ box: { name: "builder" } }).run()).status, 403);
  assert.equal((await routeWorld({ box: { workspaceId: "ws_other" } }).run()).status, 403);
  assert.equal((await routeWorld().run({ workspaceId: "ws_stranger", path: PATH, mailboxId: BOX })).status, 403);
  assert.equal((await routeWorld().run({ workspaceId: "ws_team", path: PATH, mailboxId: "nope" })).status, 400);
});

test("an empty answer sends nothing", async () => {
  const world = routeWorld({ answer: "  " });
  assert.deepEqual(await (await world.run()).json(), { outcome: "answered", sent: false });
  assert.equal(world.calls.some(([name]) => name === "write_note"), false);
});

test("when an agent in the mail needs the person, the run can text them the way any agent does: notify_me", async () => {
  // Dev, 2026-11-27: "AgentMail is for agents really, if an agent needs me, tex included it should use the text user flow".
  // No reply in mail texts them by itself; the run is offered notify_me (`send` action `notify`) from their own connection.
  const offered = attentionToolDefinitions().concat([{ name: "read_note", annotations: { readOnlyHint: true } }, { name: "text_progress" }]);
  const tools = noteRunTools(offered, { full: true });
  assert.ok(tools.some((tool) => tool.name === "notify_me"), "the mail run holds notify_me");
  assert.equal(noteRunTools(offered).some((tool) => tool.name === "notify_me"), false, "a comment's run does not");
  const six = sixToolsOver(tools, null);
  const send = six.tools.find((tool) => tool.name === "send");
  assert.ok(send, "notify_me reaches the model as the send tool");
  assert.match(JSON.stringify(send), /notify/);
  assert.equal(WITHHELD_TOOLS.has("notify_me"), false, "Tex is never kept from it");
  // And nothing else texts them: the route's only write is the mail line back.
  const world = routeWorld();
  await world.run();
  assert.deepEqual(world.calls.map(([name]) => name).filter((name) => name !== "read_note"), ["write_note"]);
});

// The person's own Tex as the seat for an agent of theirs that holds none (Dev, 2026-11-28; `docs/decisions/note-mail.md`).
// Sabotage: drop `toOwner` from `wakeTex` → "a line to an agent with no seat wakes" fails; drop `standIns` from
// `mailTurn` → "the run sees lines to the agent" fails.
test("a line to an agent with no seat wakes its person's Tex, checked for that person", async () => {
  const { env, scheduled } = texStores();
  const asked = [];
  const mailbox = { jobMailboxes: async () => [texBox], askTex: async (path, mailboxId, forHandle) => (asked.push(forHandle), OWNER) };
  assert.deepEqual(await deliverMail(env, mailbox, line({ from: "grok-bot", to: "claude-code", toOwner: "@seyi" })), ["tex"]);
  assert.deepEqual(asked, ["seyi"], "the control plane is asked for that person's Tex only");
  assert.equal(scheduled.length, 1);
  // A line to a name signed for nobody (or a bot, which the sender leaves without `toOwner`) wakes nothing.
  assert.deepEqual(await deliverMail(env, mailbox, line({ from: "grok-bot", to: "claude-code" })), []);
  assert.deepEqual(await deliverMail(env, mailbox, line({ from: "grok-bot", to: "claude-code", toOwner: "seyi" })), []);
  assert.equal(asked.length, 1);
});

test("the run sees lines to the agent Tex stands in for, and never lines to a bot", async () => {
  const note = noteWith([
    { kind: "mail", from: "claude-code", app: "Claude Code · @seyi", to: "everyone", text: "Grok Bot, please mail the four cuts.", mailKind: "ask", at: "2026-11-28T09:00:00.000Z", used: 0 },
    { kind: "mail", from: "grok-bot", app: "Cursor · @seyi", to: "claude-code", text: "Done: two yes, two no.", mailKind: "note", at: "2026-11-28T09:30:00.000Z", used: 1 },
    { kind: "mail", from: "muse", app: "Muse · @seyi", to: "grok-bot", text: "Thanks.", mailKind: "note", at: "2026-11-28T09:31:00.000Z", used: 0 },
  ]);
  const standIns = await standInsFor(note, "@seyi", async (name) => name !== "claude-code");
  assert.deepEqual(standIns, ["claude-code"], "bots that sign for the person are not stood in for");
  const turn = mailTurn(note, "2026-11-28T09:10:00.000Z", standIns);
  assert.match(turn.ask, /two yes, two no/);
  assert.doesNotMatch(turn.ask, /Thanks/);
  assert.equal(turn.to, "grok-bot", "Tex answers whoever wrote");
  assert.equal(mailTurn(note, "2026-11-28T09:10:00.000Z"), null, "without stand-ins, nothing there is Tex's");
  assert.deepEqual(await standInsFor(note, "@kim", async () => false), [], "only the run's own person's agents");
});

test("only an agent with no seat gets its person's Tex as its seat, and a reply to it names that person", async () => {
  const { seatless, signedForOf } = await import("../src/tools/notes/mail.js");
  const agent = { actor: { name: "@seyi", clientId: "c_claude" } };
  assert.equal(seatless(agent, [], "claude-code"), true);
  assert.equal(seatless(agent, [{ bot: "grok-bot" }], "grok-bot"), false, "a bound bot holds a seat");
  assert.equal(seatless({ actor: { ...agent.actor, helper: { mail: "claude-via-grok" } } }, [], "claude-via-grok"), false, "a bot's helper reports to its bot");
  assert.equal(seatless({ actor: { name: "@seyi", clientId: "context_texts" } }, [], "tex"), false, "Tex is the seat");
  assert.equal(seatless({ ...agent, mailTurn: { job: "job_1" } }, [], "builder"), false, "a job's mail reaches it already");
  assert.equal(seatless({ actor: { name: null, clientId: "c_claude" } }, [], "claude-code"), false, "nobody to stand in for");
  const events = mail.parseMail(noteWith([
    { kind: "mail", from: "claude-code", app: "Claude Code · @seyi", to: "everyone", text: "Please do it.", mailKind: "ask", at: "2026-11-28T09:00:00.000Z" },
  ])).events;
  assert.equal(signedForOf(events, "claude-code"), "@seyi");
  assert.equal(signedForOf(events, "everyone"), null);
  assert.equal(signedForOf(events, "muse"), null);
});
