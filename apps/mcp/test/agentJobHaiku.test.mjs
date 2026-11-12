/**
 * TEX'S JOB WORKERS RUN ON HAIKU, WITH THE ADVISOR (Dev2, 2026-11-05: "for the Tex minions knock them down to Haiku,
 * and also make sure that they have access to the advisor, whenever they need it").
 *
 * AI Gateway, 2026-11-02 to 05: Opus was 415 of about 7,800 calls (5%) and $40 of $71 (57%). 292 of those were job
 * rounds: the two planning rounds every job part opened with (`think_rounds: 2`) and the round after every failed call
 * (`modelPlan.js` escalation). So production drops `think`, and a job's turn is Haiku from its first round, offered the
 * advisor (send with action advisor) and told when to ask it (`advisor.js` `JOB_ADVISOR_LINE`). The advisor still
 * checks each finished part against its finish line (`jobCheck.js`). Driven through `/agent` with the setup read from
 * the pin, as production reads it.
 *
 * Sabotage record (local edits, reverted):
 * 1. `runTheModel` offering the advisor only when `job === null`: "a job's turn ... is offered the advisor" fails.
 * 2. `jobAdvisorLine` always "": "...and told when to ask it" fails.
 * 3. `jobAdvisorLine` ignoring `job`: "an ordinary text is never told the job line" fails.
 * 4. (2026-11-06) `turnEfforts` ignoring `job_effort`: "a job's turn thinks as models.job_effort says" fails.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { JOB_ADVISOR_LINE } from "../src/agent/advisor.js";
import { PRODUCTION_TEXTING_PATH, parseSetup } from "../src/agent/production.js";
import { modulePath, readModuleLists, setupLogged } from "../src/agent/promptModules.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { BUILTIN_ALLOWED, systemText } from "./agentModelFixture.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-job-haiku.test";
const TOKEN_GUEST = `cat_jobh_guest_${"0".repeat(24)}`;
const TOKEN_GROUP = `cat_jobh_group_${"0".repeat(24)}`;
const TOKEN_APP = `cat_jobh_appcl_${"0".repeat(24)}`;
const PROMPT = "SETUP-DOOR-MARK: You are Tex. Open any page you need.";

const HAIKU = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";
/** Production's models since 2026-11-05: Haiku answers and runs every job, Opus advises and checks. */
const SETUP = `---\njob: texting-assistant\nmodels:\n  main: ${HAIKU}\n  advisor: ${OPUS}\n  effort: medium\n  advisor_effort: high\nopen_web: yes\n---\n\n${PROMPT}\n`;
/** The setup before it: Opus planned each job's first two rounds (2026-10-31, `modelPlan.js`). */
const PLANNED = SETUP.replace("  effort: medium", `  think: ${OPUS}\n  think_rounds: 2\n  think_effort: high\n  effort: medium`);
const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  notes: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

/** The pin as a guest and as a chat read it: the staff folder `ai/` is private to them. */
const PERSON_RULES = { etag: "rules-person-1", accessVersion: 1, folders: [{ prefix: "ai", visibility: "private" }, { prefix: "guides", visibility: "team" }], notes: [] };
/** What the control plane's setup read hands Tex: a member's rules, narrowed to the setup's folders (`texSetupRead.ts`). */
const SETUP_RULES = { etag: "rules-setup-1", accessVersion: 1, folders: [{ prefix: "ai/production", visibility: "team" }, { prefix: "ai/agents", visibility: "team" }], notes: [] };

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

const gatewayCalls = [];
const script = [];
// The advisor's check of a finished part (`jobCheck.js`) is a request of its own after the turn's.
/** The reply reviewer's call (`replyJudge.js`): answered here, never from the script. */
const isReview = (body) => JSON.stringify(body?.system ?? "").includes("You review a text that Tex");
const PASSED = { content: [{ type: "text", text: '{"kind":"task","send":true,"problems":[],"feedback":""}' }], stop_reason: "end_turn" };
const isJobCheck = (body) => JSON.stringify(body?.system ?? "").includes("One of Tex's background jobs has just stopped");
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
let pinnedBucket;

async function ask(token, extra = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "apply to the accelerator", conversation: "texts", ...extra }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text };
}

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
      const next = isReview(body) ? PASSED : script.shift() ?? (isJobCheck(body) ? { content: [{ type: "text", text: "VERDICT: done\nADVICE: none" }], stop_reason: "end_turn" } : { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" });
      return new Response(JSON.stringify({ ...next, usage: { input_tokens: 5, output_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  controlPlane.addWorkspace("ws_door_mine", "door-mine", binding("door-mine", "AA"));
  controlPlane.addWorkspace("ws_door_pin", "context-lc", binding("door-pin", "BB"), { kind: "shared" });
  controlPlane.setBuiltinVerdict("ws_door_mine", BUILTIN_ALLOWED);
  s3.bucketFor("door-mine").set("privacy.md", { body: MANIFEST, etag: "p0" });
  pinnedBucket = s3.bucketFor("door-pin");
  controlPlane.holdRules("ws_door_pin", PERSON_RULES);
  controlPlane.holdSetupRules("ws_door_pin", SETUP_RULES);

  const scopes = ["context:read", "context:write", "context:private"];
  // A person texting Tex who is not a member of the pin: they reach it as a pin reader, read as a guest.
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "owner", userId: "user_door_guest", accessToken: TOKEN_GUEST, scopes, clientId: "context_texts",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
  // A group chat with a home in the pin: its setup row is read as the chat (`liveGrants.ts` `groupSetupRow`).
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "editor", userId: "user_door_guest", accessToken: TOKEN_GROUP,
    scopes: ["context:read", "context:write"], clientId: "context_texts_group",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "editor", setupOnly: true, grantedNames: ["#reads-as-guest", "#reads-as-chat", "#k7m2p9q4x1v8"] }],
  });
  // An AI client of the same person: never Tex, so never a setup read.
  await controlPlane.addGrant({
    workspaceId: "ws_door_mine", role: "owner", userId: "user_door_guest", accessToken: TOKEN_APP, scopes, clientId: "mcp_client_door_app",
    alsoMemberOf: [{ workspaceId: "ws_door_pin", role: "member", grantedNames: ["#reads-as-guest"] }],
  });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  gatewayCalls.length = 0;
  script.length = 0;
  pinnedBucket.set("privacy.md", { body: MANIFEST, etag: "p1" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: SETUP, etag: "s0" });
});

const JOB = { id: "job-apply-00001", title: "Apply to the accelerator", brief: "Fill in the application.", doneWhen: "the application is submitted", attempt: 1, followUps: [] };
const WIRE = { "claude-haiku-5-5": HAIKU, "claude-opus-5-5": OPUS };
const modelOf = (call) => WIRE[call.body.model] ?? call.body.model;
const turnCalls = () => gatewayCalls.filter((call) => !isJobCheck(call.body) && !isReview(call.body));
const reviews = () => gatewayCalls.filter((call) => isReview(call.body));
const sendTool = (body) => (body?.tools ?? []).find((tool) => tool.name === "send");
const askAdvisor = { content: [{ type: "tool_use", id: "t1", name: "send", input: { action: "advisor", args: {} } }], stop_reason: "tool_use" };

test("a job's turn runs on Haiku from its first round, is offered the advisor, and told when to ask it", async () => {
  script.push(askAdvisor, { content: [{ type: "text", text: "Sign in with the saved login, then fill page one." }], stop_reason: "end_turn" }, { content: [{ type: "text", text: "Submitted it." }], stop_reason: "end_turn" });
  const response = await ask(TOKEN_GUEST, { job: JOB });
  assert.equal(response.status, 200, response.text);
  const rounds = turnCalls();
  assert.deepEqual(rounds.map(modelOf), [HAIKU, OPUS, HAIKU], "Haiku plans and drives; Opus only answers the advisor ask");
  assert.match(JSON.stringify(sendTool(rounds[0].body)), /- advisor: Ask your advisor/, "the job is offered the advisor");
  assert.ok(systemText(rounds[0].body).includes(JOB_ADVISOR_LINE.trim()), "...and told when to ask it");
  assert.doesNotMatch(systemText(rounds[0].body), /plans those jobs/, "and never told another model plans it");
  assert.doesNotMatch(JOB_ADVISOR_LINE, /\d|\bten\b|at most|limit|budget/i, "never told the budget");
  assert.ok(gatewayCalls.some((call) => isJobCheck(call.body) && modelOf(call) === OPUS), "the advisor still checks the part against its finish line");
});

test("an ordinary text is never told the job line, and is still offered the advisor", async () => {
  const response = await ask(TOKEN_GUEST, { question: "what's on tomorrow" });
  assert.equal(response.status, 200, response.text);
  const [first] = turnCalls();
  assert.equal(modelOf(first), HAIKU);
  assert.ok(!systemText(first.body).includes(JOB_ADVISOR_LINE.trim()));
  assert.match(JSON.stringify(sendTool(first.body)), /- advisor: Ask your advisor/);
});

test("the setup before it put a job's first two rounds on Opus: the cost this change removes", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: PLANNED, etag: "s1" });
  script.push({ content: [{ type: "tool_use", id: "t1", name: "send", input: { action: "advisor", args: {} } }], stop_reason: "tool_use" });
  await ask(TOKEN_GUEST, { job: JOB });
  assert.deepEqual(turnCalls().slice(0, 2).map(modelOf), [OPUS, OPUS]);
});

test("a job's own turn is never reviewed; an ordinary text is (review, 2026-11-05; the reviewer, 2026-11-06)", async () => {
  // Sabotage: drop `job === null` from `gated` in runTheModel.js: the job turn is reviewed.
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: SETUP.replace("open_web: yes", "open_web: yes\nreply_judge: haiku"), etag: "s-review" });
  script.push({ content: [{ type: "text", text: "Submitted it." }], stop_reason: "end_turn" });
  assert.equal((await ask(TOKEN_GUEST, { job: JOB })).status, 200);
  assert.equal(reviews().length, 0, "nothing reviews a job's own turn");
  // The ordinary text asks the advisor first: a draft written with no action is not reviewed (2026-11-11, `replyJudge.js`).
  script.push(askAdvisor, { content: [{ type: "text", text: "Nothing on." }], stop_reason: "end_turn" }, { content: [{ type: "text", text: "Nothing tomorrow." }], stop_reason: "end_turn" });
  assert.equal((await ask(TOKEN_GUEST, { question: "what's on tomorrow" })).status, 200);
  assert.equal(reviews().length, 1, "one review of an ordinary text's reply");
  assert.equal(reviews()[0].body.model, "claude-haiku-5-5");
});

test("what Tex texts about a job's report is reviewed with the report in view (Dev2, 2026-11-05)", async () => {
  // Sabotage: pass `report: null` to replyJudge in runTheModel.js: the reviewer never sees the report.
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: SETUP.replace("open_web: yes", "open_web: yes\nreply_judge: clef-flash"), etag: "s-review-report" });
  script.push({ content: [{ type: "text", text: "Your last ten merged PRs, riskiest is #2684: the page has each one with its risk." }], stop_reason: "end_turn" });
  const report = { title: "Last ten PRs", state: "done", texts: ["1. #2839 search rework. 2. #2684 74 files, risk high. 3. #2563 retries."] };
  assert.equal((await ask(TOKEN_GUEST, { event: "job_report", jobReport: report, running: [] })).status, 200);
  assert.equal(reviews().length, 1);
  assert.match(JSON.stringify(reviews()[0].body.messages), /#2684 74 files, risk high/);
});

test("a job's turn thinks as models.job_effort says; an ordinary text keeps effort (Dev2, 2026-11-06: Haiku, reasoning high)", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: SETUP.replace("  effort: medium", "  effort: medium\n  job_effort: high"), etag: "s2" });
  script.push({ content: [{ type: "text", text: "Submitted it." }], stop_reason: "end_turn" });
  assert.equal((await ask(TOKEN_GUEST, { job: JOB })).status, 200);
  const [jobRound] = turnCalls();
  assert.equal(modelOf(jobRound), HAIKU);
  assert.deepEqual(jobRound.body.output_config, { effort: "high" });
  gatewayCalls.length = 0;
  assert.equal((await ask(TOKEN_GUEST, { question: "what's on tomorrow" })).status, 200);
  assert.deepEqual(turnCalls()[0].body.output_config, { effort: "medium" });
});

test("a job_effort that is not an effort refuses the setup, as every other effort does", async () => {
  assert.equal((await parseSetup(SETUP.replace("  effort: medium", "  effort: medium\n  job_effort: high")))?.jobEffort, "high");
  assert.equal(await parseSetup(SETUP.replace("  effort: medium", "  effort: medium\n  job_effort: loud")), null);
});

/* ---------------- The prompt in modules (`promptModules.js`; Dev2, 2026-11-06: "split into modules now") ---------------- */
// Sabotage record (local edits, reverted): `notes: { prompt: production.prompt }` back in runTheModel.js fails "each kind
// of turn"; dropping `assembleSetup` from `readAssembled` (production.js) fails it too; `prompts.texts` for every kind
// in `setupPromptFor` fails "each kind of turn".
const MODULAR = SETUP.replace("open_web: yes", "open_web: yes\nmodules:\n  texts: [core, texting]\n  job: [core, job-only]").replace(PROMPT, "This note's rules are in its modules.");

test("each kind of turn is given its own modules, in order, and never the setup's body", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: MODULAR, etag: "s-mod" });
  pinnedBucket.set(modulePath("core"), { body: "---\nnote: for people\n---\n\nCORE-MARK: You are Tex.\n", etag: "m1" });
  pinnedBucket.set(modulePath("texting"), { body: "TEXTING-MARK: answer in a sentence.\n", etag: "m2" });
  pinnedBucket.set(modulePath("job-only"), { body: "JOB-MARK: report what you did.\n", etag: "m3" });
  script.push({ content: [{ type: "text", text: "Nothing tomorrow." }], stop_reason: "end_turn" });
  assert.equal((await ask(TOKEN_GUEST, { question: "what's on tomorrow" })).status, 200);
  const text = systemText(turnCalls()[0].body);
  assert.match(text, /CORE-MARK: You are Tex\.\n\nTEXTING-MARK/);
  assert.doesNotMatch(text, /JOB-MARK|note: for people|rules are in its modules/);
  gatewayCalls.length = 0;
  script.push({ content: [{ type: "text", text: "Submitted it." }], stop_reason: "end_turn" });
  assert.equal((await ask(TOKEN_GUEST, { job: JOB })).status, 200);
  const job = systemText(turnCalls()[0].body);
  assert.match(job, /CORE-MARK[\s\S]*JOB-MARK/);
  assert.doesNotMatch(job, /TEXTING-MARK/);
});

test("a setup naming a module that isn't there, or naming modules badly, is refused whole", async () => {
  const one = (name, text) => [name, text];
  const kept = (modules) => JSON.stringify({ kind: "context-tex-setup-modules/1", raw: MODULAR, modules: Object.fromEntries(modules) });
  const full = await parseSetup(kept([one("core", "C"), one("texting", "T"), one("job-only", "J")]));
  assert.deepEqual(full.prompts, { texts: "C\n\nT", group: "C\n\nT", job: "C\n\nJ" }, "group falls back to texts");
  assert.deepEqual(full.modules.job, ["core", "job-only"]);
  assert.equal(full.prompt, "C\n\nT");
  assert.equal(await parseSetup(kept([one("core", "C"), one("texting", "T")])), null, "a missing module");
  assert.equal(await parseSetup(kept([one("core", "C"), one("texting", "   "), one("job-only", "J")])), null, "an empty module");
  assert.equal(await parseSetup(MODULAR), null, "modules named, none read");
  assert.equal(await parseSetup(MODULAR.replace("  texts: [core, texting]\n", "")), null, "texts is required");
  assert.equal(await parseSetup(MODULAR.replace("job: [core, job-only]", "advisor: [core]")), null, "an unknown kind");
  assert.equal(await parseSetup(MODULAR.replace("[core, texting]", "[core, ../texting]")), null, "a name that is not a module name");
  assert.equal(await parseSetup(MODULAR.replace("[core, texting]", "[core, core]")), null, "a module named twice");
  const other = await parseSetup(kept([one("core", "C2"), one("texting", "T"), one("job-only", "J")]));
  assert.notEqual(other.version, full.version, "a changed module is a new version");
  assert.deepEqual((await parseSetup(kept([one("core", "call read_note"), one("texting", "T"), one("job-only", "J")]))).staleNames, ["read_note"]);
  assert.equal((await parseSetup(SETUP)).prompts, null, "a setup with no modules is its body, as before");
  assert.equal(readModuleLists(undefined), null);
  assert.deepEqual(setupLogged(full, { job: JOB }), { setup: full.version, modules: ["core", "job-only"] }, "the turn log names the modules a turn got");
  assert.deepEqual(setupLogged(null, {}), {});
});
