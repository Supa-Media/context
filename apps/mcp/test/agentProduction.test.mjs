/**
 * The texting assistant's production setup: one plain Markdown note,
 * `assistant/production/texting-assistant.md` in the pinned `@context-lc` workspace
 * (decided by the owner, 2026-10-08). Its front matter picks the built-in
 * model and the step cap; its body is the one prompt a texted turn is given.
 *
 * Asserted on the wire, like `agentInstructions.test.mjs`: the system prompt
 * and the model the fake provider was actually sent. Read through the caller's
 * own reach and `privacy.md`, and missing, malformed or held-back means the
 * pinned notes in `assistant/`, then the built-in words, never an error.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { ASSISTANT_INSTRUCTIONS_PATH, ASSISTANT_TEXTING_PATH } from "../src/agent/instructions.js";
import { DEFAULT_BUILTIN_MODEL, DEFAULT_GATEWAY_MODEL } from "../src/agent/builtin.js";
import { PRODUCTION_TEXTING_PATH, parseSetup } from "../src/agent/production.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-production-setup.test";
const TOKEN_TEXTS = `cat_prod_texts_${"0".repeat(25)}`;
const TOKEN_APP = `cat_prod_appcl_${"0".repeat(24)}`;
const TOKEN_FREE = `cat_prod_free_${"0".repeat(25)}`;
const TOKEN_STAFF = `cat_prod_staff_${"0".repeat(24)}`;
const API_KEY = "zarquon-production-setup-not-a-real-key";
const GATEWAY_ACCOUNT = "0123456789abcdef0123456789abcdef";

const WHO = "WHO-NOTE-MARK: You are Context, as the pinned notes describe.";
const STYLE = "STYLE-NOTE-MARK: Text like a friend, one short line.";
const PROMPT = "PRODUCTION-MARK: You are Context, the assistant people text. Ask before you text someone.";

/** A setup file. The example from the owner's note, with the body overridable. */
function setupFile({ model = "anthropic/claude-haiku-5-5", steps = "8", tools = "[search_notes, read_note]", prompt = PROMPT } = {}) {
  return (
    "---\njob: texting-assistant\nmodels:\n  main: " + model + "\n" +
    `tools: ${tools}\nmax_steps: ${steps}\n` +
    "came_from: setups/texting-assistant/haiku-ask-first\n" +
    "proved_by: results/2026-10-08 texting-assistant\n" +
    "why: Asks before texting someone.\n---\n\n" +
    `${prompt}\n`
  );
}

/** A file with the given front matter lines and body, for the refusal cases. */
function file(front, body = PROMPT) {
  return `---\n${front}\n---\n\n${body}\n`;
}

const OK_FRONT = "models:\n  main: anthropic/claude-haiku-5-5";

function manifest(extra = "", productionShared = true) {
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n  assistant: team\n  1-projects: team\n${productionShared ? "" : "  assistant/production: private\n"}\n` +
    `note_overrides:\n${extra || "  # none\n"}` +
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
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

function version(raw) {
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/* ---------------- parseSetup: the file's grammar and its refusals ---------------- */

test("parseSetup accepts the example setup and reads every field", async () => {
  const raw = setupFile();
  const setup = await parseSetup(raw);
  assert.ok(setup, "the example parses");
  assert.equal(setup.job, "texting-assistant");
  assert.equal(setup.model, "anthropic/claude-haiku-5-5");
  assert.deepEqual(setup.tools, ["search_notes", "read_note"]);
  assert.equal(setup.maxSteps, 8);
  assert.equal(setup.prompt, PROMPT, "the body, without its front matter");
  assert.equal(setup.version, version(raw), "the first 12 hex of SHA-256 of the raw file");
});

test("parseSetup accepts a Workers AI model with no tools or step cap", async () => {
  const setup = await parseSetup(file("models:\n  main: @cf/zai-org/glm-4.7-flash"));
  assert.ok(setup);
  assert.equal(setup.model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(setup.tools, []);
  assert.equal(setup.maxSteps, null);
});

const REFUSED = [
  ["a file with no front matter", `${PROMPT}\n`],
  ["a front matter line the subset does not read", file(`${OK_FRONT}\nnot a pair`)],
  ["models.main missing", file("models:\n  fallback: anthropic/claude-haiku-5-5")],
  ["a model outside the two accepted shapes", file("models:\n  main: openai/gpt-5")],
  ["an empty body", file(OK_FRONT, "   ")],
  ["a body of more than 1,000 lines", file(OK_FRONT, Array.from({ length: 1001 }, (_, i) => `line ${i}`).join("\n"))],
  ["a body of more than 40,000 characters", file(OK_FRONT, "x".repeat(40_001))],
  ["max_steps of 13", file(`${OK_FRONT}\nmax_steps: 13`)],
  ["max_steps of 0", file(`${OK_FRONT}\nmax_steps: 0`)],
  ["max_steps that is not an integer", file(`${OK_FRONT}\nmax_steps: eight`)],
  ["a tool name outside the grammar", file(`${OK_FRONT}\ntools: [Search-Notes]`)],
  ["tools that is not a list", file(`${OK_FRONT}\ntools: search_notes`)],
];

for (const [name, raw] of REFUSED) {
  test(`parseSetup refuses ${name}`, async () => {
    assert.equal(await parseSetup(raw), null);
  });
}

/* ---------------- the wire: what a turn is told and which model it runs ---------------- */

const anthropicCalls = [];
const gatewayCalls = [];
const base = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
const gatewayVars = {
  AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT,
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: "gateway-token-fixture-0000000000",
};
const controlPlane = createControlPlaneStub();
let pinnedBucket;
let restore = [];

function answer() {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A Workers AI binding that records each call and answers in the chat shape. */
function fakeAi(replies = []) {
  const calls = [];
  const script = [...replies];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return script.shift() ?? { choices: [{ message: { content: "Hi.", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    },
  };
}

function toolCallReply(name) {
  return {
    choices: [{ message: { content: "", tool_calls: [{ id: "call_0", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  };
}

async function ask(env, token) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What are you?" }),
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

/** The system prompt a built-in turn sent to Workers AI, as its first message. */
function builtinSystem(ai) {
  return String(ai.calls[0]?.input?.messages?.[0]?.content ?? "");
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());

  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.anthropic.com")) {
      anthropicCalls.push({ url, body: JSON.parse(init.body) });
      return answer();
    }
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      gatewayCalls.push({ url, headers: { ...init?.headers }, body: JSON.parse(init.body) });
      return answer();
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  controlPlane.addWorkspace("ws_mine", "mine", binding("prod-mine", "AA"));
  controlPlane.addWorkspace("ws_free", "free", binding("prod-free", "CC"));
  controlPlane.addWorkspace("ws_pinned", "context-lc", binding("prod-pinned", "BB"), { kind: "shared" });
  controlPlane.connectProvider("ws_mine", "anthropic", API_KEY);
  controlPlane.connectProvider("ws_pinned", "anthropic", API_KEY);
  controlPlane.setBuiltinVerdict("ws_free", { allowed: true, remaining: 10 });

  for (const bucket of ["prod-mine", "prod-free"]) {
    s3.bucketFor(bucket).set("privacy.md", { body: manifest(), etag: "p0" });
  }
  pinnedBucket = s3.bucketFor("prod-pinned");

  const member = [{ workspaceId: "ws_pinned", role: "member" }];
  const scopes = ["context:read", "context:write", "context:private"];
  await controlPlane.addGrant({
    workspaceId: "ws_mine", role: "owner", userId: "user_prod_texts", accessToken: TOKEN_TEXTS,
    scopes, clientId: "context_texts", alsoMemberOf: member,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_mine", role: "owner", userId: "user_prod_app", accessToken: TOKEN_APP,
    scopes, clientId: "mcp_client_prod_app", alsoMemberOf: member,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_free", role: "owner", userId: "user_prod_free", accessToken: TOKEN_FREE,
    scopes, clientId: "context_texts", alsoMemberOf: member,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_pinned", role: "owner", userId: "user_prod_staff", accessToken: TOKEN_STAFF,
    scopes, clientId: "context_texts",
  });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  anthropicCalls.length = 0;
  gatewayCalls.length = 0;
  pinnedBucket.set("privacy.md", { body: manifest(), etag: "p1" });
  pinnedBucket.set(ASSISTANT_INSTRUCTIONS_PATH, { body: `${WHO}\n`, etag: "a0" });
  pinnedBucket.set(ASSISTANT_TEXTING_PATH, { body: `${STYLE}\n`, etag: "t0" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile(), etag: "s0" });
});

/** The system prompt a turn sent to Anthropic on the person's own key. */
function anthropicSystem() {
  return String(anthropicCalls.at(-1)?.body?.system ?? "");
}

test("a texted turn is told the production prompt, and nothing the pinned notes say", async () => {
  const response = await ask(base, TOKEN_TEXTS);
  assert.equal(response.status, 200);
  const system = anthropicSystem();
  assert.equal(system.split(PROMPT).length, 2, "the production prompt, exactly once");
  assert.ok(!system.includes(WHO), "assistant/instructions.md is not sent");
  assert.ok(!system.includes(STYLE), "assistant/texting.md is not sent");
  assert.ok(!system.includes("No Markdown at all"), "the built-in texting style is not sent");
  assert.ok(system.includes("propose_note"), "what the code decides is still said");
});

test("an app turn ignores the production file and keeps the instructions note", async () => {
  await ask(base, TOKEN_APP);
  const system = anthropicSystem();
  assert.ok(system.includes(WHO));
  assert.ok(!system.includes(PROMPT));
  assert.ok(system.includes("Cite the note path"));
});

test("a missing production file falls back to the pinned notes", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  await ask(base, TOKEN_TEXTS);
  const system = anthropicSystem();
  assert.ok(system.includes(WHO) && system.includes(STYLE));
  assert.ok(!system.includes(PROMPT));
});

test("a malformed production file falls back to the pinned notes", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "openai/gpt-5" }), etag: "s1" });
  await ask(base, TOKEN_TEXTS);
  const system = anthropicSystem();
  assert.ok(system.includes(WHO) && system.includes(STYLE));
  assert.ok(!system.includes(PROMPT));
});

test("a production file privacy.md holds back from members falls back, and its owner still reads it", async () => {
  pinnedBucket.set("privacy.md", { body: manifest(`  ${PRODUCTION_TEXTING_PATH}: private\n`), etag: "p2" });
  await ask(base, TOKEN_TEXTS);
  const member = anthropicSystem();
  assert.ok(member.includes(WHO), "the member gets the pinned notes");
  assert.ok(!member.includes(PROMPT), "the member is not sent the held-back prompt");
  await ask(base, TOKEN_STAFF);
  assert.ok(anthropicSystem().includes(PROMPT), "staff inside @context-lc still read it");
});

test("a production folder privacy.md keeps private inside a shared folder is not sent", async () => {
  pinnedBucket.set("privacy.md", { body: manifest("", false), etag: "p3" });
  await ask(base, TOKEN_TEXTS);
  const system = anthropicSystem();
  assert.ok(system.includes(WHO));
  assert.ok(!system.includes(PROMPT), "a private subfolder of assistant/ stays private");
});

test("a built-in turn is given the production prompt once, and the pinned notes not at all", async () => {
  const ai = fakeAi();
  await ask({ ...base, AI: ai }, TOKEN_FREE);
  const system = builtinSystem(ai);
  assert.equal(system.split(PROMPT).length, 2, "one prompt per setup");
  assert.ok(!system.includes(WHO) && !system.includes(STYLE));
});

test("a built-in turn runs the production model when this deployment can call a Workers AI one", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "@cf/acme/texting-model" }), etag: "s2" });
  const ai = fakeAi();
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(ai.calls[0]?.model, "@cf/acme/texting-model");
  assert.equal(controlPlane.builtinReports.at(-1)?.model, "@cf/acme/texting-model", "the meter reports the model used");
});

test("a built-in turn runs a production gateway model on the gateway when the deployment has one", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "anthropic/claude-sonnet-5-5" }), etag: "s3" });
  const ai = fakeAi();
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-sonnet-5-5", "the gateway's name for it");
  assert.equal(ai.calls.length, 0, "Workers AI is not asked");
});

test("a production model this deployment cannot call falls back to the Workers AI default", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "anthropic/claude-sonnet-5-5" }), etag: "s4" });
  const ai = fakeAi();
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(ai.calls[0]?.model, DEFAULT_BUILTIN_MODEL);
});

test("a Workers AI production model on a gateway-only deployment falls back to the gateway default", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "@cf/acme/texting-model" }), etag: "s5" });
  const response = await ask({ ...base, ...gatewayVars }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(gatewayCalls.at(-1)?.body?.model, DEFAULT_GATEWAY_MODEL.replace("anthropic/", ""));
});

test("the gateway call is filed under the setup's version", async () => {
  const raw = setupFile({ model: "anthropic/claude-sonnet-5-5" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: raw, etag: "s6" });
  await ask({ ...base, ...gatewayVars }, TOKEN_FREE);
  const labels = gatewayCalls.at(-1)?.headers?.["cf-aig-metadata"] ?? "";
  assert.ok(labels.includes(`"setup":"${version(raw)}"`), labels);
});

test("a person's own key never takes the production model", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "anthropic/claude-haiku-5-5" }), etag: "s7" });
  const ai = fakeAi();
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_TEXTS);
  assert.equal(anthropicCalls.at(-1)?.body?.model, "claude-sonnet-5", "their model, their bill");
  assert.equal(gatewayCalls.length, 0);
  assert.equal(ai.calls.length, 0);
});

test("max_steps caps the rounds a built-in turn may take", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ steps: "1" }), etag: "s8" });
  const ai = fakeAi([toolCallReply("search_notes")]);
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(response.body?.exhausted, true, "the turn ends after one round");
  assert.equal(ai.calls.length, 1);
});
