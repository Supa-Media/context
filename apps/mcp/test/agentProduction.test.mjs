/**
 * The texting assistant's production setup: one plain Markdown note,
 * `ai/production/texting-assistant.md` in the pinned `@context-lc` workspace
 * (decided by the owner, 2026-10-08). Its front matter picks the built-in
 * model and the step cap; its body is the one prompt a texted turn is given.
 *
 * Asserted on the wire, like `agentInstructions.test.mjs`: the system prompt
 * and the model the fake model was actually sent. Read through the caller's
 * own reach and `privacy.md`, and missing, malformed or held-back means the
 * built-in words, never an error.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { DEFAULT_BUILTIN_MODEL, DEFAULT_GATEWAY_MODEL } from "../src/agent/builtin.js";
import { PRODUCTION_APP_PATH, PRODUCTION_TEXTING_PATH, parseSetup } from "../src/agent/production.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { BUILTIN_ALLOWED, systemText } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-production-setup.test";
const TOKEN_TEXTS = `cat_prod_texts_${"0".repeat(25)}`;
const TOKEN_APP = `cat_prod_appcl_${"0".repeat(24)}`;
const TOKEN_FREE = `cat_prod_free_${"0".repeat(25)}`;
const TOKEN_STAFF = `cat_prod_staff_${"0".repeat(24)}`;
const GATEWAY_ACCOUNT = "0123456789abcdef0123456789abcdef";

const WHO = "WHO-NOTE-MARK: You are Context, as the app file describes.";
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
    `folder_defaults:\n  ai: team\n  1-projects: team\n${productionShared ? "" : "  ai/production: private\n"}\n` +
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
  ["a model outside the accepted shapes", file("models:\n  main: evil/model-x")],
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
  controlPlane.setBuiltinVerdict("ws_mine", BUILTIN_ALLOWED);
  controlPlane.setBuiltinVerdict("ws_pinned", BUILTIN_ALLOWED);
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
  gatewayCalls.length = 0;
  pinnedBucket.set("privacy.md", { body: manifest(), etag: "p1" });
  pinnedBucket.set(PRODUCTION_APP_PATH, { body: setupFile({ prompt: WHO }), etag: "a0" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile(), etag: "s0" });
});

/** A deployment with our AI gateway: the built-in model is Claude on it. */
const onGateway = { ...base, ...gatewayVars };

/** The system prompt the last turn sent through the gateway. */
function gatewaySystem() {
  return systemText(gatewayCalls.at(-1)?.body);
}

test("a texted turn is told the texting production prompt, and not the app one", async () => {
  const response = await ask(onGateway, TOKEN_TEXTS);
  assert.equal(response.status, 200);
  const system = gatewaySystem();
  assert.equal(system.split(PROMPT).length, 2, "the production prompt, exactly once");
  assert.ok(!system.includes(WHO), "the app file is not sent");
  assert.ok(!system.includes("No Markdown at all"), "the built-in texting style is not sent");
  assert.ok(system.includes("you change notes yourself when they ask"), "what the code decides is still said");
});

test("an app turn reads the app file, not the texting one", async () => {
  await ask(onGateway, TOKEN_APP);
  const system = gatewaySystem();
  assert.ok(system.includes(WHO));
  assert.ok(!system.includes(PROMPT));
  assert.ok(system.includes("Cite the note path"));
});

const BUILTIN = "You are Context, the assistant built into";

test("a missing production file falls back to the built-in words", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  await ask(onGateway, TOKEN_TEXTS);
  const system = gatewaySystem();
  assert.ok(system.includes(BUILTIN) && system.includes("No Markdown at all"));
  assert.ok(!system.includes(PROMPT));
});

test("a malformed production file falls back to the built-in words", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ model: "evil/model-x" }), etag: "s1" });
  await ask(onGateway, TOKEN_TEXTS);
  const system = gatewaySystem();
  assert.ok(system.includes(BUILTIN));
  assert.ok(!system.includes(PROMPT));
});

test("a production file privacy.md holds back from members falls back, and its owner still reads it", async () => {
  pinnedBucket.set("privacy.md", { body: manifest(`  ${PRODUCTION_TEXTING_PATH}: private\n`), etag: "p2" });
  await ask(onGateway, TOKEN_TEXTS);
  const member = gatewaySystem();
  assert.ok(member.includes(BUILTIN), "the member gets the built-in words");
  assert.ok(!member.includes(PROMPT), "the member is not sent the held-back prompt");
  await ask(onGateway, TOKEN_STAFF);
  assert.ok(gatewaySystem().includes(PROMPT), "staff inside @context-lc still read it");
});

test("a production folder privacy.md keeps private inside a shared folder is not sent", async () => {
  pinnedBucket.set("privacy.md", { body: manifest("", false), etag: "p3" });
  await ask(onGateway, TOKEN_TEXTS);
  const system = gatewaySystem();
  assert.ok(system.includes(BUILTIN));
  assert.ok(!system.includes(PROMPT), "a private subfolder of ai/ stays private");
});

test("a built-in turn is given the production prompt once, and the app file not at all", async () => {
  const ai = fakeAi();
  await ask({ ...base, AI: ai }, TOKEN_FREE);
  const system = builtinSystem(ai);
  assert.equal(system.split(PROMPT).length, 2, "one prompt per setup");
  assert.ok(!system.includes(WHO));
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

test("max_steps caps the rounds a built-in turn may take", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile({ steps: "1" }), etag: "s8" });
  const ai = fakeAi([toolCallReply("search_notes")]);
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(response.body?.exhausted, true, "the turn ends after one round");
  assert.equal(ai.calls.length, 1);
});

/* ---------------- the router: which model a text runs on (`router.js`) ---------------- */

const ROUTED_FRONT =
  "models:\n  main: anthropic/claude-haiku-5-5\n  router: \"@cf/cloudflare/clef\"\n  think: anthropic/claude-opus-5-5";

test("parseSetup reads a router and its thinking model", async () => {
  const setup = await parseSetup(file(ROUTED_FRONT));
  assert.ok(setup);
  assert.equal(setup.model, "anthropic/claude-haiku-5-5");
  assert.deepEqual(setup.router, { model: "@cf/cloudflare/clef", think: "anthropic/claude-opus-5-5", routeAt: 0.5 });
});

test("parseSetup reads the router's cutoff, and refuses one outside 0 to 1 or without a router", async () => {
  const wide = await parseSetup(file(`${ROUTED_FRONT}\n  route_at: 0.3`));
  assert.equal(wide?.router?.routeAt, 0.3);
  assert.equal((await parseSetup(file(`${ROUTED_FRONT}\n  route_at: 1`)))?.router?.routeAt, 1);
  assert.equal((await parseSetup(file(`${ROUTED_FRONT}\n  route_at: 0`)))?.router?.routeAt, 0);
  for (const bad of ["1.5", "-0.1", ".3", "half", "0.3333"]) {
    assert.equal(await parseSetup(file(`${ROUTED_FRONT}\n  route_at: ${bad}`)), null, bad);
  }
  assert.equal(await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\n  route_at: 0.3")), null, "a cutoff with no router routes nothing");
});

test("parseSetup reads no router when the file names none", async () => {
  assert.equal((await parseSetup(file(OK_FRONT))).router, null);
});

for (const [name, front] of [
  ["a router with no thinking model", "models:\n  main: anthropic/claude-haiku-5-5\n  router: \"@cf/cloudflare/clef\""],
  ["a thinking model with no router", "models:\n  main: anthropic/claude-haiku-5-5\n  think: anthropic/claude-opus-5-5"],
  ["a router that is not Clef", "models:\n  main: anthropic/claude-haiku-5-5\n  router: anthropic/claude-haiku-5-5\n  think: anthropic/claude-opus-5-5"],
  ["a thinking model outside the accepted shapes", "models:\n  main: anthropic/claude-haiku-5-5\n  router: \"@cf/cloudflare/clef\"\n  think: evil/model-x"],
]) {
  test(`parseSetup refuses ${name}`, async () => {
    assert.equal(await parseSetup(file(front)), null);
  });
}

/** Clef's answer to the router's pick-one question. */
const clefSays = (choice, confidence = 0.9) => ({ answers: { tier: { choice, confidence } } });

test("a text the router calls think runs on the thinking model, and the meter says so", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r1" });
  const ai = fakeAi([clefSays("think")]);
  const response = await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(ai.calls[0]?.model, "@cf/cloudflare/clef", "the router is asked first");
  assert.ok(String(ai.calls[0]?.input?.state ?? "").includes("What are you?"), "it reads the person's text");
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-opus-5-5", "the thinking model answers");
  const report = controlPlane.builtinReports.at(-1);
  assert.equal(report?.model, "anthropic/claude-opus-5-5", "the meter reports the model that answered");
  assert.ok((report?.decision ?? report?.decisionTokens ?? 0) > 0, "what the router read is metered");
  const trace = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.deepEqual(trace[0] && { kind: trace[0].kind, tier: trace[0].tier, model: trace[0].model }, { kind: "router", tier: "think", model: "anthropic/claude-opus-5-5" });
});

test("a text the router calls lookup stays on the main model", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r2" });
  const ai = fakeAi([clefSays("lookup")]);
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-haiku-5-5");
  assert.equal(controlPlane.builtinReports.at(-1)?.model, "anthropic/claude-haiku-5-5");
});

test("a think pick under the default cutoff clears a setup's lower one, and the trace keeps the confidence", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(`${ROUTED_FRONT}\n  route_at: 0.3`), etag: "r2-wide" });
  const ai = fakeAi([clefSays("think", 0.4)]);
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-opus-5-5", "0.4 clears a cutoff of 0.3");
  const trace = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.deepEqual(trace[0] && { tier: trace[0].tier, confidence: trace[0].confidence }, { tier: "think", confidence: 0.4 });

  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r2-default" });
  await ask({ ...base, ...gatewayVars, AI: fakeAi([clefSays("think", 0.4)]) }, TOKEN_FREE);
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-haiku-5-5", "0.4 does not clear the default 0.5");
  const near = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.deepEqual(near[0] && { tier: near[0].tier, confidence: near[0].confidence }, { tier: "main", confidence: 0.4 }, "the near miss keeps its confidence");

  await ask({ ...base, ...gatewayVars, AI: fakeAi([clefSays("think", 1.7)]) }, TOKEN_FREE);
  const odd = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.equal(odd[0]?.confidence, 1, "a confidence Clef got wrong is clamped, so the turn log still takes the turn");

  await ask({ ...base, ...gatewayVars, AI: fakeAi([clefSays("lookup", 0.9)]) }, TOKEN_FREE);
  const looked = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.equal(looked[0]?.confidence, undefined, "a lookup pick carries no think confidence");
});

test("router tells Clef that a date worked out from another, an order and a total are think questions", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r2-shape" });
  const ai = fakeAi([clefSays("think")]);
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  const question = ai.calls[0]?.input?.questions?.tier;
  assert.match(question?.instructions ?? "", /date worked out from another date/);
  assert.match(question?.instructions ?? "", /more than one of their notebooks/);
  assert.match(question?.criteria?.think ?? "", /deadline or how long is left/);
  assert.match(question?.criteria?.lookup ?? "", /not a date that has to be worked out/);
});

test("router tells Clef that making an event requires checking commitments", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r2-attendance" });
  const ai = fakeAi([clefSays("think")]);
  await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
  const question = ai.calls[0]?.input?.questions?.tier;
  assert.match(question?.instructions ?? "", /whether.*make an event/i);
  assert.match(question?.criteria?.think ?? "", /make an event/i);
});

test("a low-confidence think, a word the router does not know, or a failed router all stay on main", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file(ROUTED_FRONT), etag: "r3" });
  for (const reply of [clefSays("think", 0.2), clefSays("genius"), { nonsense: true }]) {
    const ai = fakeAi([reply]);
    await ask({ ...base, ...gatewayVars, AI: ai }, TOKEN_FREE);
    assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-haiku-5-5", JSON.stringify(reply));
  }
  const throwing = { calls: [], async run() { throw new Error("clef is down"); } };
  const response = await ask({ ...base, ...gatewayVars, AI: throwing }, TOKEN_FREE);
  assert.equal(response.status, 200, "a router that throws costs nobody their answer");
  assert.equal(gatewayCalls.at(-1)?.body?.model, "claude-haiku-5-5");
});

test("a thinking model this deployment cannot call means no routing at all", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, {
    body: file("models:\n  main: @cf/acme/texting-model\n  router: \"@cf/cloudflare/clef\"\n  think: anthropic/claude-opus-5-5"),
    etag: "r4",
  });
  const ai = fakeAi([clefSays("think")]);
  await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(ai.calls[0]?.model, "@cf/acme/texting-model", "Clef is never asked; the main model answers");
});

/* ---------------- the fallback model: a second model the turn goes on with (`turn.js`) ---------------- */

test("parseSetup reads a fallback model, and refuses one that is the main model or no model", async () => {
  const spare = await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\n  fallback: \"@cf/zai-org/glm-4.7-flash\""));
  assert.equal(spare.fallback, "@cf/zai-org/glm-4.7-flash");
  assert.equal((await parseSetup(file(OK_FRONT))).fallback, null, "none named is none");
  assert.equal(await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\n  fallback: anthropic/claude-haiku-5-5")), null, "the same model is no fallback");
  assert.equal(await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\n  fallback: evil/model-x")), null);
});

test("a built-in turn whose production model fails goes on with the setup's fallback, and the meter and turn log say so", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file("models:\n  main: \"@cf/acme/texting-model\"\n  fallback: \"@cf/acme/spare-model\""), etag: "f1" });
  const calls = [];
  const ai = {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model === "@cf/acme/texting-model") throw new Error("upstream said no");
      return { choices: [{ message: { content: "From the spare.", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    },
  };
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 200);
  assert.equal(response.body?.answer, "From the spare.");
  assert.deepEqual(calls.map((call) => call.model), ["@cf/acme/texting-model", "@cf/acme/spare-model"]);
  assert.equal(controlPlane.builtinReports.at(-1)?.model, "@cf/acme/spare-model", "the meter is told the model that answered");
  const trace = controlPlane.turnReports.at(-1)?.trace ?? [];
  const fell = trace.find((entry) => entry.kind === "fallback");
  assert.deepEqual(fell, { kind: "fallback", ok: true, ms: fell?.ms ?? 0, model: "@cf/acme/spare-model" }, JSON.stringify(trace));
  assert.ok(!("from" in (fell ?? {})) && !("reason" in (fell ?? {})), "the turn log gets the model and a status, never a provider's words");
});

test("a fallback this deployment cannot call is no fallback, and the failure is reported as before", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: file("models:\n  main: \"@cf/acme/texting-model\"\n  fallback: anthropic/claude-sonnet-5-5"), etag: "f2" });
  const ai = { calls: [], async run() { throw new Error("upstream said no"); } };
  const response = await ask({ ...base, AI: ai }, TOKEN_FREE);
  assert.equal(response.status, 502);
  assert.equal(response.body?.error, "model_unavailable");
  const trace = controlPlane.turnReports.at(-1)?.trace ?? [];
  assert.ok(!trace.some((entry) => entry.kind === "fallback"));
  assert.deepEqual(trace.at(-1) && { kind: trace.at(-1).kind, ok: trace.at(-1).ok }, { kind: "model", ok: false });
});
