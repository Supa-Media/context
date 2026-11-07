/**
 * A ROUTINE'S RUN MAY SAY NOTHING, AND THE REVIEWER READS WHAT IT TEXTS (Dev2, 2026-11-07).
 *
 * 13:30 UTC that day, Dev2's 1:1: two one-off reminders were due at 2:30, one for the envelopes and one for the rings.
 * The envelopes run texted both. The rings run saw that and called send with action say_nothing, as its prompt said
 * (`routine.js`, since #3067), but a routine's run was never offered it (`runTheModel.js` passed
 * `sayNothing: job === null && !runner`), so the call came back "no such action" and the model's note about it went
 * out as a text: "The say_nothing action isn't available to me in this session ...". And no reviewer read it, because
 * the reviewer ran only on a reply to a text. Dev2 chose both fixes. Driven through `/agent` with the setup read from
 * the pin, as production reads it.
 *
 * Sabotage record (local edits, reverted):
 * 1. `sayNothing: job === null && !runner` again in runTheModel.js: "a routine's run is offered say_nothing ..." fails.
 * 2. `scheduled` left out of `gated` in runTheModel.js: "the reviewer reads a routine's text ..." fails.
 * 3. `scheduled` set whatever `send:` says: "a routine that only writes a note is never reviewed" fails.
 * 4. heartbeat.js passing `answerCheck: null`: "the reviewer reads a check-in's text too ..." fails.
 * 5. heartbeat.js back to `grants: {}`: the same test fails, on its say_nothing offer (the look's send had no
 *    actions at all, so a check-in could never say nothing either; found writing this test).
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-scheduled-review.test";
const TOKEN_RUNNER = `cat_sched_runner_${"0".repeat(22)}`;
const TOKEN_BEAT = `cat_sched_beater_${"0".repeat(22)}`;
const HAIKU = "anthropic/claude-haiku-5-5";
const SETUP = `---\njob: texting-assistant\nmodels:\n  main: ${HAIKU}\n  effort: medium\nreply_judge: haiku\n---\n\nYou are Tex.\n`;
const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  notes: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const PERSON_RULES = { etag: "rules-person-1", accessVersion: 1, folders: [{ prefix: "ai", visibility: "private" }], notes: [] };
const SETUP_RULES = { etag: "rules-setup-1", accessVersion: 1, folders: [{ prefix: "ai/production", visibility: "team" }], notes: [] };
// A one-off is marked done once it has run (`finishOnce`), so each test runs its own.
let ran = 0;
const RINGS_BODY = "---\nat: 2026-11-07 2:30 pm\n---\nRemind them to get the rings from Simi.\n";
const NOTE_ONLY = "routines/once/log-the-rings.md";
/** What the model wrote on 2026-11-07 when it could not say nothing. */
const LEAKED = "The reminder was already sent: the 1:30 pm routine texted it. The say_nothing action isn't available to me in this session, so I couldn't formally skip it.";

function binding(bucket, key) {
  return {
    provider: "s3", endpoint: S3_ENDPOINT, region: "auto", bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`, secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true, capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true }, status: "active",
  };
}

const gatewayCalls = [];
const script = [];
const reviewScript = [];
const isReview = (body) => JSON.stringify(body?.system ?? "").includes("You review a text that Tex");
const PASSED = '{"kind":"scheduled","verdict":"ok","problems":[],"feedback":""}';
const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  TEX_STORE: texStoreNamespace().namespace,
  GATEWAY_SECRET,
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: "gateway-token-fixture-0000000000",
};
const controlPlane = createControlPlaneStub();
const restore = [];
let mine;
let pinned;
let RINGS;

/** One check-in look, as the control plane asks for it (`heartbeat.js`). */
async function look() {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_BEAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ heartbeat: { timeZone: "UTC", since: Date.now() - 2 * 60 * 60 * 1000 } }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text, body: JSON.parse(text) };
}

async function run(path) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_RUNNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ routine: { path, timeZone: "Africa/Casablanca" }, conversation: "texts" }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text, body: JSON.parse(text) };
}

const says = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const calls = (name, input) => ({ content: [{ type: "tool_use", id: `t${script.length}`, name, input }], stop_reason: "tool_use" });
const sayNothing = () => calls("send", { action: "say_nothing", args: { why: "the envelopes run already said it" } });
const turnCalls = () => gatewayCalls.filter((call) => !isReview(call.body));
const reviews = () => gatewayCalls.filter((call) => isReview(call.body));

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      const body = JSON.parse(init.body);
      gatewayCalls.push({ url, body });
      const next = isReview(body) ? says(reviewScript.shift() ?? PASSED) : script.shift() ?? says("Done.");
      return new Response(JSON.stringify({ ...next, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });
  controlPlane.addWorkspace("ws_sched_mine", "sched-mine", binding("sched-mine", "AA"));
  controlPlane.addWorkspace("ws_sched_pin", "context-lc", binding("sched-pin", "BB"), { kind: "shared" });
  controlPlane.setBuiltinVerdict("ws_sched_mine", BUILTIN_ALLOWED);
  mine = s3.bucketFor("sched-mine");
  mine.set("privacy.md", { body: MANIFEST, etag: "p0" });
  pinned = s3.bucketFor("sched-pin");
  controlPlane.holdRules("ws_sched_pin", PERSON_RULES);
  controlPlane.holdSetupRules("ws_sched_pin", SETUP_RULES);
  await controlPlane.addGrant({
    workspaceId: "ws_sched_mine", role: "owner", userId: "user_sched", accessToken: TOKEN_BEAT,
    scopes: ["context:read", "context:write", "context:private"], clientId: "context_heartbeat",
    alsoMemberOf: [{ workspaceId: "ws_sched_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
  await controlPlane.addGrant({
    workspaceId: "ws_sched_mine", role: "owner", userId: "user_sched", accessToken: TOKEN_RUNNER,
    scopes: ["context:read", "context:write", "context:private"], clientId: "context_routines",
    alsoMemberOf: [{ workspaceId: "ws_sched_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  gatewayCalls.length = 0;
  script.length = 0;
  reviewScript.length = 0;
  pinned.set("privacy.md", { body: MANIFEST, etag: "p1" });
  pinned.set(PRODUCTION_TEXTING_PATH, { body: SETUP, etag: "s0" });
  ran += 1;
  RINGS = `routines/once/rings-from-simi-${ran}.md`;
  mine.set(RINGS, { body: RINGS_BODY, etag: `r${ran}` });
  mine.set(`notes/changed-${ran}.md`, { body: "# Wedding\n\nRings are with Simi.\n", etag: `n${ran}`, lastModified: new Date(Date.now() - 60_000).toISOString() });
  mine.set(NOTE_ONLY, { body: "---\nat: 2026-11-07 2:30 pm\nsend: note\n---\nNote down that the rings were collected.\n", etag: "r2" });
});

test("a routine's run is offered say_nothing, and calling it texts nothing, with no review", async () => {
  script.push(sayNothing());
  const response = await run(RINGS);
  assert.equal(response.status, 200, response.text);
  const [first] = turnCalls();
  assert.match(JSON.stringify((first.body.tools ?? []).find((tool) => tool.name === "send") ?? {}), /say_nothing/, "the routine is offered the call its prompt names");
  assert.equal(response.body.outcome, "skipped");
  assert.equal(response.body.answer, "");
  assert.equal(response.body.skipped, true);
  assert.equal(turnCalls().length, 1, "the call ends the run at once");
  assert.equal(reviews().length, 0, "nothing texted, nothing to review");
});

test("the reviewer reads a routine's text as one nobody asked for, and its feedback leads to silence", async () => {
  script.push(says(LEAKED), sayNothing());
  reviewScript.push('{"kind":"scheduled","verdict":"send_back","problems":["not_for_them"],"feedback":"Quote: \\"The say_nothing action isn\'t available\\". This is about your own run. Call send with action say_nothing."}');
  const response = await run(RINGS);
  assert.equal(response.status, 200, response.text);
  const [review] = reviews();
  assert.ok(review, "the routine's text was reviewed");
  const state = JSON.stringify(review.body.messages);
  assert.match(state, /Nobody texted\. This is a scheduled routine/);
  assert.match(state, /get the rings from Simi/, "the reviewer sees what the run was asked to do");
  assert.match(JSON.stringify(review.body.system), /not_for_them/);
  assert.match(JSON.stringify(turnCalls()[1].body.messages), /reviewer read your reply/, "the run is told the feedback");
  assert.equal(response.body.outcome, "skipped", "and texts nothing");
  assert.equal(response.body.answer, "");
});

test("a routine's reminder the reviewer passes goes out as written", async () => {
  script.push(says("Time to get the rings from Simi."));
  const response = await run(RINGS);
  assert.equal(response.status, 200, response.text);
  assert.equal(reviews().length, 1);
  assert.equal(response.body.outcome, "answered");
  assert.equal(response.body.answer, "Time to get the rings from Simi.");
});

test("a routine that only writes a note is never reviewed", async () => {
  script.push(says("Noted the rings as collected."));
  const response = await run(NOTE_ONLY);
  assert.equal(response.status, 200, response.text);
  assert.equal(reviews().length, 0);
});

test("the reviewer reads a check-in's text too, under the texting setup's switch, and silence is still a call", async () => {
  script.push(says("I looked at your notes this run and nothing needs a text, but I can't skip formally here."), sayNothing());
  reviewScript.push('{"kind":"scheduled","verdict":"send_back","problems":["not_for_them"],"feedback":"This is about your own run. Call send with action say_nothing."}');
  const response = await look();
  assert.equal(response.status, 200, response.text);
  const [review] = reviews();
  assert.ok(review, "the check-in's text was reviewed");
  assert.match(JSON.stringify(review.body.messages), /Nobody texted\. This is a scheduled check-in/);
  const send = (turnCalls()[0].body.tools ?? []).find((tool) => tool.name === "send");
  assert.match(JSON.stringify(send ?? {}), /say_nothing/, "a check-in is offered the call its prompt names");
  assert.doesNotMatch(JSON.stringify(send ?? {}), /send_email|notify|background/, "and no other send");
  assert.equal(response.body.outcome, "quiet", "and nothing is texted");
});

test("a check-in is not reviewed when the texting setup has no reviewer", async () => {
  pinned.set(PRODUCTION_TEXTING_PATH, { body: SETUP.replace("reply_judge: haiku\n", ""), etag: "s-off" });
  script.push(says("The rings are with Simi, per your wedding note."));
  const response = await look();
  assert.equal(response.status, 200, response.text);
  assert.equal(reviews().length, 0);
  assert.equal(response.body.outcome, "speak");
});
