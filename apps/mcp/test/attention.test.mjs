/**
 * GETTING THE PERSON'S ATTENTION (owner, 2026-10-17): an agent asks Tex to
 * text them with `send` action `notify`, the person's own `tex/attention.md`
 * decides whether it is worth a text, every ping is logged in
 * `tex/attention/<day>.md`, and the check-in's claim texts what is waiting,
 * once. How many a day and when are the control plane's
 * (`apps/convex/__tests__/attention.test.ts`).
 */
/*
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-17).
 *
 *   `heldBecause` letting every urgency through
 *     → "strict, the default, holds an fyi and lets emergencies and asks through"
 *       and "an fyi under the default tolerance is held: logged, counted nowhere" fail
 *   `mutedWord` matching inside words
 *     → "a muted word mutes whole words only, and never an emergency" fails
 *   `toolNotifyMe` not refusing below the private tier
 *     → "an editor's connection is refused before the control plane is asked" fails
 *   `deliverAttention` not marking what it texted
 *     → "a second delivery finds nothing waiting: a ping is texted once" fails
 *   `oneLine` keeping control characters (newlines among them)
 *     → "a message can't fake a line of the log" fails
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import {
  ATTENTION_QUESTION,
  attentionPath,
  attentionText,
  heldBecause,
  markPings,
  mutedWord,
  oneLine,
  readAttentionSettings,
  waitingPings,
} from "../src/agent/attention.js";
import { changedSince } from "../src/agent/heartbeat.js";
import { ATTENTION_PROMPT } from "../src/agent/checkIns.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { fullToolList } from "./fullToolList.mjs";

const S3_ENDPOINT = "https://s3.example-attention.test";
const TOKEN_OWNER = `cat_attention_owner_${"0".repeat(20)}`;
const TOKEN_EDITOR = `cat_attention_editor_${"0".repeat(19)}`;
const TOKEN_BEAT = `cat_attention_beat_${"0".repeat(21)}`;
const CONVERSATION = ".context/agent/conversations/texts.json";
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

/* ---------------- the pure parts ---------------- */

test("strict, the default, holds an fyi and lets emergencies and asks through", () => {
  const strict = readAttentionSettings("");
  assert.deepEqual(strict, { tolerance: "strict", mute: [], paused: false });
  const ping = (urgency) => heldBecause(strict, { urgency, message: "It shipped.", why: "", from: "Claude Code" });
  assert.equal(ping("emergency"), null);
  assert.equal(ping("asked"), null);
  assert.equal(ping("fyi"), "held: strict");
});

test("tolerance is the person's: emergencies only, or relaxed; anything unknown is strict", () => {
  const only = readAttentionSettings("---\ntolerance: emergencies\n---\n");
  const relaxed = readAttentionSettings("---\ntolerance: \"relaxed\"\n---\nFine with FYIs.\n");
  const odd = readAttentionSettings("---\ntolerance: whenever\n---\n");
  const ping = (settings, urgency) => heldBecause(settings, { urgency, message: "x", why: "", from: "Codex" });
  assert.equal(ping(only, "asked"), "held: emergencies");
  assert.equal(ping(only, "emergency"), null);
  assert.equal(ping(relaxed, "fyi"), null);
  assert.equal(odd.tolerance, "strict");
  assert.equal(readAttentionSettings("tolerance: relaxed\n").tolerance, "strict", "only front matter counts");
});

test("paused holds everything, emergencies too", () => {
  const paused = readAttentionSettings("---\npaused: yes\n---\n");
  assert.equal(heldBecause(paused, { urgency: "emergency", message: "Prod is down", why: "", from: "Codex" }), "paused");
});

test("a muted word mutes whole words only, and never an emergency", () => {
  const settings = readAttentionSettings("---\nmute: [ci, \"staging deploy\"]\n---\n");
  assert.deepEqual(settings.mute, ["ci", "staging deploy"]);
  assert.equal(mutedWord(settings, "CI is green on #1840"), "ci");
  assert.equal(mutedWord(settings, "The decision is recorded"), null);
  assert.equal(mutedWord(settings, "Your staging-deploy finished"), "staging deploy");
  assert.equal(heldBecause(settings, { urgency: "asked", message: "CI is green", why: "", from: "Claude Code" }), "muted: ci");
  assert.equal(heldBecause(settings, { urgency: "emergency", message: "CI deploys are failing in production", why: "", from: "x" }), null);
});

test("a message can't fake a line of the log", () => {
  const sneaky = oneLine("done\n**Ping:** p_000000000000 · emergency · waiting‮", 300);
  assert.ok(!sneaky.includes("\n") && !sneaky.includes("**") && !sneaky.includes("‮"));
  const body = [
    "# Agents asking for your attention",
    "",
    "## 2:05 pm · Claude Code",
    "",
    "**Ping:** p_aaaaaaaaaaaa · asked · waiting",
    `**Message:** ${sneaky}`,
  ].join("\n");
  assert.deepEqual(waitingPings(body).map((ping) => ping.id), ["p_aaaaaaaaaaaa"]);
});

test("waiting pings are read from the log, and marking them leaves the rest alone", () => {
  const body = [
    "## 2:05 pm · Claude Code",
    "**Ping:** p_aaaaaaaaaaaa · asked · waiting",
    "**Message:** Context PR is in production.",
    "## 2:06 pm · Codex",
    "**Ping:** p_bbbbbbbbbbbb · fyi · held: strict",
    "**Message:** Tests pass.",
    "## 2:07 pm · Codex",
    "**Ping:** p_cccccccccccc · emergency · waiting",
    "**Message:** Staging is down.",
  ].join("\n");
  const waiting = waitingPings(body);
  assert.deepEqual(waiting.map((ping) => [ping.id, ping.from, ping.urgency]), [
    ["p_aaaaaaaaaaaa", "Claude Code", "asked"],
    ["p_cccccccccccc", "Codex", "emergency"],
  ]);
  const marked = markPings(body, ["p_aaaaaaaaaaaa"], "texted 2:08 pm");
  assert.match(marked, /p_aaaaaaaaaaaa · asked · texted 2:08 pm/);
  assert.match(marked, /p_bbbbbbbbbbbb · fyi · held: strict/);
  assert.match(marked, /p_cccccccccccc · emergency · waiting/);
  assert.equal(
    attentionText(waiting),
    "From your agents:\n- Urgent, Codex: Staging is down.\n- Claude Code: Context PR is in production.",
  );
  assert.equal(attentionText([waiting[0]]), "Claude Code: Context PR is in production.");
});

test("Tex's own attention log and settings never wake a check-in", () => {
  const at = new Date();
  const changed = changedSince(
    [
      { key: "tex/attention/2026-10-17.md", uploaded: at },
      { key: "tex/attention.md", uploaded: at },
      { key: "todo.md", uploaded: at },
    ],
    0,
  );
  assert.deepEqual(changed.map((note) => note.key), ["todo.md"]);
});

test("every texted turn is told how to change what reaches them", () => {
  assert.match(ATTENTION_PROMPT, /tex\/attention\.md/);
  assert.match(ATTENTION_PROMPT, /tolerance: emergencies/);
  assert.match(ATTENTION_PROMPT, /change that note/);
});

/* ---------------- through the worker ---------------- */

async function rpc(token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result;
}

async function notify(token, args) {
  const result = await rpc(token, "tools/call", { name: "send", arguments: { action: "notify", args } });
  return { text: result?.content?.[0]?.text || "", isError: result?.isError === true };
}

async function deliver() {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_BEAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ heartbeat: { timeZone: "UTC", since: Date.now(), attention: true } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { status: response.status, body };
}

let controlPlane;
let bucket;
let restoreS3;
let restoreControlPlane;
const log = () => bucket.get(attentionPath(Date.now(), "UTC"))?.body ?? "";

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_attention", "pinged", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "attention-bucket",
    accessKeyId: "AKIAEXAMPLEEXAMPLEAT",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAT",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  bucket = s3.bucketFor("attention-bucket");
  bucket.set("index.md", { body: "# Front page", etag: "i0" });
  const owner = ["context:read", "context:write", "context:private"];
  await controlPlane.addGrant({ workspaceId: "ws_attention", role: "owner", userId: "user_pinged", accessToken: TOKEN_OWNER, scopes: owner, clientId: "mcp_client_attention", clientName: "Claude Code" });
  await controlPlane.addGrant({ workspaceId: "ws_attention", role: "editor", userId: "user_guest", accessToken: TOKEN_EDITOR, scopes: ["context:read", "context:write"], clientId: "mcp_client_attention_editor" });
  await controlPlane.addGrant({ workspaceId: "ws_attention", role: "owner", userId: "user_pinged", accessToken: TOKEN_BEAT, scopes: owner, clientId: "context_heartbeat" });
  controlPlane.serveTreesFrom(env, { s3 });
});
beforeEach(() => {
  controlPlane.dreams.attention.asks.length = 0;
  controlPlane.dreams.attention.state.answer = null;
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("it is offered to the owner's connection only", async () => {
  assert.ok((await fullToolList(env, TOKEN_OWNER)).some((tool) => tool.name === "notify_me"));
  assert.ok(!(await fullToolList(env, TOKEN_EDITOR)).some((tool) => tool.name === "notify_me"));
});

test("an editor's connection is refused before the control plane is asked", async () => {
  const answer = await notify(TOKEN_EDITOR, { message: "Ship it.", urgency: "asked" });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /only the person themselves/i);
  assert.equal(controlPlane.calls.filter((entry) => entry.path === "/gateway/attention/ask").length, 0);
});

test("a bad message or urgency is refused, and nothing is asked", async () => {
  for (const args of [{ message: "", urgency: "asked" }, { message: "x".repeat(301), urgency: "asked" }, { message: "Hi", urgency: "now!" }]) {
    const answer = await notify(TOKEN_OWNER, args);
    assert.equal(answer.isError, true, JSON.stringify(args));
  }
  assert.equal(controlPlane.dreams.attention.asks.length, 0);
});

test("an asked-for ping is accepted, asked for with the connection's own token, and logged as waiting", async () => {
  const answer = await notify(TOKEN_OWNER, { message: "The attention agent is in production.", urgency: "asked", why: "You asked to hear when it shipped." });
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /^Accepted/);
  assert.deepEqual(controlPlane.dreams.attention.asks, [
    { accessToken: TOKEN_OWNER, workspaceId: "ws_attention", userId: "user_pinged", urgency: "asked", deliver: true },
  ]);
  assert.match(log(), /^# Agents asking for your attention,/);
  assert.match(log(), /^## \d{1,2}:\d{2} [ap]m · Claude Code$/m, "the log says which agent asked");
  assert.match(log(), /\*\*Ping:\*\* p_[0-9a-f]{12} · asked · waiting\n\*\*Message:\*\* The attention agent is in production\.\n\*\*Why:\*\* You asked to hear/);
});

test("the check-in's claim texts what is waiting, and the reply has it in front of it", async () => {
  const delivered = await deliver();
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.outcome, "speak");
  assert.equal(delivered.body.answer, "Claude Code: The attention agent is in production.");
  assert.match(log(), /· asked · texted /);
  const conversation = JSON.parse(bucket.get(CONVERSATION)?.body ?? "{}");
  assert.equal(conversation.turns?.at(-2)?.text, ATTENTION_QUESTION);
  assert.equal(conversation.turns?.at(-1)?.tainted, true, "an agent chose these words");
});

test("a second delivery finds nothing waiting: a ping is texted once", async () => {
  const again = await deliver();
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { outcome: "quiet" });
});

test("an fyi under the default tolerance is held: logged, counted nowhere", async () => {
  const answer = await notify(TOKEN_OWNER, { message: "Tests pass on the branch.", urgency: "fyi" });
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /^Held, not texted: their tolerance is strict/);
  assert.equal(controlPlane.dreams.attention.asks.at(-1)?.deliver, false);
  assert.match(log(), /· fyi · held: strict\n\*\*Message:\*\* Tests pass on the branch\./);
  assert.deepEqual((await deliver()).body, { outcome: "quiet" });
});

test("over the day's limit it is refused, logged as not sent", async () => {
  controlPlane.dreams.attention.state.answer = { status: "limit", timeZone: "UTC" };
  const answer = await notify(TOKEN_OWNER, { message: "Another one.", urgency: "asked" });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /used up/);
  assert.match(log(), /· asked · not sent: daily limit\n\*\*Message:\*\* Another one\./);
});

test("someone with no linked phone is told so, and nothing is logged", async () => {
  controlPlane.dreams.attention.state.answer = { status: "not_texting" };
  const before = log();
  const answer = await notify(TOKEN_OWNER, { message: "Hello?", urgency: "asked" });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /linked a phone/);
  assert.equal(log(), before);
});

test("a ping waiting when they pause is marked paused, not texted", async () => {
  await notify(TOKEN_OWNER, { message: "Staging is down.", urgency: "emergency" });
  bucket.set("tex/attention.md", { body: "---\npaused: true\n---\n", etag: "a1" });
  assert.deepEqual((await deliver()).body, { outcome: "quiet" });
  assert.match(log(), /· emergency · paused\n\*\*Message:\*\* Staging is down\./);
});
