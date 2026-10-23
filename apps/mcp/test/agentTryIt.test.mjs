/**
 * `/agent/try`, the AI tab's Try it (decided by the owner, 2026-10-16).
 *
 * An editor of `@context-lc` chats, from the console, with any setup in its
 * `ai/` folder, as themselves; the turn can read and change nothing, and each
 * reply is checked against the golden case's rules by a judge turn.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-16).
 *
 *  1. `handleTryIt` dropping the console-client check.
 *     → "an editor's ordinary connection cannot try" fails.
 *  2. `editsAiNotes` accepting `member`.
 *     → "a member of @context-lc cannot try" fails.
 *  3. `tryDispatcher` calling any name it is given.
 *     → "the try's dispatcher passes only a tool it offered" fails.
 *  4. `readSetupAt` without its path pattern.
 *     → "only a setup under ai/production or ai/setups is tried" fails.
 *  5. `startBuiltinTurn` called without `tryIt`.
 *     → "an editor tries a drafted setup, on the setup's own prompt" fails.
 */

import { shown } from "./sixToolsShown.mjs";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { personaPrompt, readOnlySession, readVerdicts, tryDispatcher, tryHistory, tryPersona, tryRules } from "../src/agent/tryIt.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED, systemText } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-try-it.test";
const TOKEN_EDITOR = `cat_try_editor_${"0".repeat(24)}`;
const TOKEN_MEMBER = `cat_try_member_${"0".repeat(24)}`;
const TOKEN_EDITOR_APP = `cat_try_edapp_${"0".repeat(25)}`;
const SETUP_PATH = "ai/setups/texting-assistant/ask-first.md";
const PROMPT = "TRY-MARK: You are Tex. Ask before you text anyone.";
const TODO = "# To do\n\n- Pay rent\n";

function manifest() {
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    "folder_defaults:\n  ai: team\n\nnote_overrides:\n  # none\n```\n\n" +
    "<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

function setupFile() {
  return (
    "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\nmax_steps: 6\n" +
    "based_on: live-5-2026-10-14\nchange: Asks first.\nstatus: draft\n---\n\n" +
    `${PROMPT}\n`
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
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

/* ---------------- the fake model at the gateway ---------------- */

const gatewayCalls = [];
let script = [];

function reply(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, call] of (step.toolCalls ?? []).entries()) {
    content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
  }
  return new Response(
    JSON.stringify({
      content,
      stop_reason: (step.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const controlPlane = createControlPlaneStub();
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
const restore = [];
let mineBucket;
let pinnedBucket;

async function tryIt(token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent/try", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  // The rules a binding carries are rendered from the tree this bucket serves.
  controlPlane.serveTreesFrom(null, { s3 });
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      gatewayCalls.push(JSON.parse(init.body));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      return reply(step);
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  controlPlane.addWorkspace("ws_try_mine", "tryer", binding("try-mine", "AA"));
  controlPlane.addWorkspace("ws_try_member", "watcher", binding("try-member", "CC"));
  controlPlane.addWorkspace("ws_try_pinned", "context-lc", binding("try-pinned", "BB"), { kind: "shared" });
  for (const id of ["ws_try_mine", "ws_try_member"]) controlPlane.setBuiltinVerdict(id, BUILTIN_ALLOWED);

  const scopes = ["context:read", "context:write", "context:private"];
  const editor = [{ workspaceId: "ws_try_pinned", role: "editor" }];
  await controlPlane.addGrant({
    workspaceId: "ws_try_mine", role: "owner", userId: "user_try_editor", accessToken: TOKEN_EDITOR,
    scopes, clientId: "context_console", alsoMemberOf: editor,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_try_mine", role: "owner", userId: "user_try_editor", accessToken: TOKEN_EDITOR_APP,
    scopes, clientId: "mcp_client_try_app", alsoMemberOf: editor,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_try_member", role: "owner", userId: "user_try_member", accessToken: TOKEN_MEMBER,
    scopes, clientId: "context_console", alsoMemberOf: [{ workspaceId: "ws_try_pinned", role: "member" }],
  });

  mineBucket = s3.bucketFor("try-mine");
  pinnedBucket = s3.bucketFor("try-pinned");
  s3.bucketFor("try-member").set("privacy.md", { body: manifest(), etag: "m0" });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  gatewayCalls.length = 0;
  script = [];
  mineBucket.set("privacy.md", { body: manifest(), etag: "p0" });
  mineBucket.set("todo.md", { body: TODO, etag: "t0" });
  pinnedBucket.set("privacy.md", { body: manifest(), etag: "p1" });
  pinnedBucket.set(SETUP_PATH, { body: setupFile(), etag: "s0" });
});

/* ---------------- who may try ---------------- */

test("an editor tries a drafted setup, on the setup's own prompt", async () => {
  script = [{ text: "Want me to text Sam?" }];
  const startsBefore = controlPlane.builtinStarts.length;
  const reportsBefore = controlPlane.builtinReports.length;
  const answer = await tryIt(TOKEN_EDITOR, { question: "tell Sam I'm late", setup: SETUP_PATH });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.answer, "Want me to text Sam?");
  assert.deepEqual(answer.body.checks, []);
  assert.ok(systemText(gatewayCalls[0]).includes(PROMPT), "the tried setup's prompt is the one sent");
  const started = controlPlane.builtinStarts.slice(startsBefore);
  assert.deepEqual(started, [{ workspaceId: "ws_try_mine", tryIt: true }], "the start asks for the Try it exception");
  const reported = controlPlane.builtinReports.slice(reportsBefore);
  assert.ok(reported.length === 1 && reported[0].tryIt === true, "the spend is metered as a try");
});

test("a member of @context-lc cannot try", async () => {
  const refused = await tryIt(TOKEN_MEMBER, { question: "hi", setup: SETUP_PATH });
  assert.equal(refused.status, 403);
  assert.equal(gatewayCalls.length, 0);
});

test("an editor's ordinary connection cannot try", async () => {
  const refused = await tryIt(TOKEN_EDITOR_APP, { question: "hi", setup: SETUP_PATH });
  assert.equal(refused.status, 403);
  assert.equal(gatewayCalls.length, 0);
});

test("only a setup under ai/production or ai/setups is tried", async () => {
  pinnedBucket.set("ai/skills/send.md", { body: setupFile(), etag: "k0" });
  for (const setup of ["ai/skills/send.md", "ai/setups/../skills/send.md", "todo.md", "ai/setups/texting-assistant/ask-first.txt", null]) {
    const refused = await tryIt(TOKEN_EDITOR, { question: "hi", setup });
    assert.equal(refused.status, 400, `refused: ${setup}`);
  }
  assert.equal(gatewayCalls.length, 0);
});

test("an empty question is refused before any model turn", async () => {
  const refused = await tryIt(TOKEN_EDITOR, { question: "  ", setup: SETUP_PATH });
  assert.equal(refused.status, 400);
  assert.equal(gatewayCalls.length, 0);
});

/* ---------------- what a try can do ---------------- */

test("a try changes nothing, whatever the model asks", async () => {
  script = [
    {
      toolCalls: [
        { name: "write_note", args: { path: "todo.md", content: "hijacked" } },
        { name: "propose_note", args: { path: "todo.md", content: "hijacked" } },
        { name: "write_note", args: { path: SETUP_PATH, content: "hijacked", context: "@context-lc" } },
        { name: "archive_note", args: { path: "todo.md" } },
        { name: "write", args: { path: "todo.md", content: "hijacked" } },
        { name: "manage", args: { action: "archive", args: { path: "todo.md" } } },
      ],
    },
    { text: "Done." },
  ];
  const answer = await tryIt(TOKEN_EDITOR, { question: "clear my list", setup: SETUP_PATH });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const offered = [...shown(gatewayCalls[0].tools)];
  assert.ok(offered.includes("fetch") && offered.includes("search"), "reading is offered");
  for (const name of ["write.save", "write.propose", "write.remember", "manage"]) {
    assert.ok(!offered.includes(name), `${name} is not offered`);
  }
  assert.equal(mineBucket.get("todo.md")?.body, TODO);
  assert.equal(pinnedBucket.get(SETUP_PATH)?.body, setupFile());
  const results = JSON.stringify(gatewayCalls[1].messages);
  assert.equal(results.split('"is_error":true').length - 1, 6, "every refused call says so");
});

test("as a case's person, the turn reads nothing and knows only what the case says", async () => {
  script = [
    { toolCalls: [{ name: "read_note", args: { path: "todo.md" } }] },
    { text: "Sure, Ada." },
  ];
  const answer = await tryIt(TOKEN_EDITOR, {
    question: "what's on my list?",
    setup: SETUP_PATH,
    as: { who: "Ada, a nurse", notes: "Shift Tuesday 7am." },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual((gatewayCalls[0].tools ?? []).map((tool) => tool.name), [], "no tool is offered");
  const system = systemText(gatewayCalls[0]);
  assert.ok(system.includes(PROMPT), "the setup's own prompt still leads");
  assert.ok(system.includes("Ada, a nurse") && system.includes("Shift Tuesday 7am."), "the case's person is named");
  assert.ok(!JSON.stringify(gatewayCalls).includes("Pay rent"), "the caller's own notes never reach the model");
});

test("tryPersona bounds who and notes, and names nobody without a who", () => {
  assert.equal(tryPersona(null), null);
  assert.equal(tryPersona({ who: "  " }), null);
  assert.equal(tryPersona({ notes: "x" }), null);
  const long = tryPersona({ who: "a\nb".repeat(300), notes: "n".repeat(9_000) });
  assert.ok(long.who.length <= 200 && !long.who.includes("\n"));
  assert.equal(long.notes.length, 4_000);
  assert.ok(personaPrompt("P", { who: "Ada", notes: "" }).includes("say nothing relevant"));
});

test("each reply is checked against the case's rules", async () => {
  script = [
    { text: "Texted Sam." },
    { text: 'Sure: {"checks":[{"rule":1,"pass":false,"why":"It texted without asking."},{"rule":2,"pass":true,"why":"Short."}]}' },
  ];
  const answer = await tryIt(TOKEN_EDITOR, {
    question: "tell Sam I'm late",
    setup: SETUP_PATH,
    history: [{ question: "hi", answer: "Hi!" }],
    rules: [
      { key: "must", value: "ask before texting anyone" },
      { key: "must not", value: "use more than two sentences" },
      { key: "must call", value: "send_text" },
    ],
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.checks, [
    { key: "must", value: "ask before texting anyone", pass: false, why: "It texted without asking." },
    { key: "must not", value: "use more than two sentences", pass: true, why: "Short." },
  ]);
  const judged = JSON.stringify(gatewayCalls[1].messages);
  assert.ok(judged.includes("Texted Sam.") && judged.includes("1. must: ask before texting anyone"));
  assert.ok(!(gatewayCalls[1].tools ?? []).length, "the judge has no tools");
  assert.ok(JSON.stringify(gatewayCalls[0].messages).includes("Hi!"), "the chat so far goes with the try");
});

/* ---------------- the pieces ---------------- */

test("the try's dispatcher passes only a tool it offered", async () => {
  const called = [];
  const dispatch = tryDispatcher([{ name: "read_note" }, { name: "search_notes" }], async (name, args) => {
    called.push({ name, args });
    return { content: [] };
  });
  const refused = await Promise.all(["write_note", "propose_note", "send_text", ""].map((name) => dispatch(name, { context: "@context-lc" })));
  assert.ok(refused.every((result) => result.isError === true));
  await dispatch("read_note", { path: "todo.md" });
  assert.deepEqual(called, [{ name: "read_note", args: { path: "todo.md" } }]);
});

test("readOnlySession keeps reading and private, and drops every write scope", () => {
  const session = {
    workspaceId: "ws",
    scopes: ["context:read", "context:write", "context:capture", "context:private"],
    grantScopes: ["context:read", "context:write"],
    accessToken: "secret",
  };
  const clamped = readOnlySession(session);
  assert.deepEqual(clamped.scopes, ["context:read", "context:private"]);
  assert.deepEqual(clamped.grantScopes, ["context:read"]);
  assert.equal(clamped.accessToken, "secret");
  assert.ok(!Object.keys(clamped).includes("accessToken"), "the token is not enumerable");
  assert.deepEqual(session.scopes.length, 4, "the original session is untouched");
});

test("tryRules keeps the judged kinds, bounded and on one line", () => {
  const rules = tryRules([
    { key: " must ", value: "ask\nfirst" },
    { key: "must call", value: "send_text" },
    { key: "judge", value: "   " },
    { key: "may", value: "x".repeat(1000) },
    null,
    { key: "must", value: 3 },
  ]);
  assert.deepEqual(rules.map((rule) => rule.key), ["must", "may"]);
  assert.equal(rules[0].value, "ask first");
  assert.equal(rules[1].value.length, 400);
  assert.equal(tryRules(Array.from({ length: 40 }, () => ({ key: "must", value: "x" }))).length, 24);
  assert.deepEqual(tryRules("must: x"), []);
});

test("readVerdicts reads a judge leniently and never throws", () => {
  assert.deepEqual(readVerdicts("no json here", 2), [null, null]);
  assert.deepEqual(readVerdicts("{broken", 1), [null]);
  assert.deepEqual(readVerdicts('{"checks":[{"rule":2,"pass":true,"why":"ok"},{"rule":9,"pass":true},{"rule":1,"pass":"yes"}]}', 2), [
    null,
    { pass: true, why: "ok" },
  ]);
});

test("tryHistory keeps whole turns of words only", () => {
  const history = tryHistory([{ question: "a", answer: "b" }, { question: "c" }, "x", { question: "d", answer: "e" }]);
  assert.deepEqual(history.map((turn) => turn.text), ["a", "b", "d", "e"]);
  assert.deepEqual(tryHistory(null), []);
});
