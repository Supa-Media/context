/**
 * The assistant's own words, kept where staff can edit them: one production
 * file in the pinned `@context-lc` workspace,
 * `ai/production/texting-assistant.md` for texts (decided by the owner,
 * 2026-10-08; this replaced `assistant/instructions.md` and `texting.md`).
 * A turn that is not texted has no production file: the app assistant's,
 * `ai/production/app-assistant.md`, was removed by the owner on 2026-10-17,
 * and a stale copy of it is never read.
 *
 * Asserted on the wire — the system prompt the fake model was actually sent —
 * so a turn that read the note and then dropped it would still fail. Read
 * through the caller's own reach and `privacy.md`, exactly like the global
 * orient note (`globalOrientNote.test.mjs`), and the built-in words whenever
 * the file is missing, invalid, held back, or there is no pinned workspace.
 * The file's grammar and its model are `agentProduction.test.mjs`.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED, systemText } from "./agentModelFixture.mjs";

/** The retired app assistant's note, left in the bucket to prove nothing reads it. */
const RETIRED_APP_PATH = "ai/production/app-assistant.md";
const RETIRED_APP_MARK = "RETIRED-APP-ASSISTANT-MARK";
const S3_ENDPOINT = "https://s3.example-assistant-notes.test";
const TOKEN_TEXTS = `cat_assist_texts_${"0".repeat(23)}`;
const TOKEN_APP = `cat_assist_appcl_${"0".repeat(23)}`;
const TOKEN_LONELY = `cat_assist_lonel_${"0".repeat(23)}`;
const TOKEN_STAFF = `cat_assist_staff_${"0".repeat(23)}`;

const WHO = "You are Context. Context is a notes app at context.lc, never Obsidian.";
const STYLE = "Text like a friend: one short line, no lists.";

/** A production file: front matter naming a model, and the whole prompt. */
function setupFile(job, body) {
  return `---\njob: ${job}\nupdated: 2026-10-08\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\n${body}\n`;
}

function manifest(extra = "") {
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n  ai: team\n  1-projects: team\n\nnote_overrides:\n${extra || "  # none\n"}` +
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

const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
const systems = [];
let pinnedBucket;
let restore = [];

/** One turn; returns the system prompt the model was sent. */
async function systemFor(token) {
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
  assert.equal(response.status, 200, text);
  const sent = systems.at(-1);
  assert.equal(typeof sent, "string");
  return sent;
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  // The rules a binding carries are rendered from the tree this bucket serves.
  controlPlane.serveTreesFrom(null, { s3 });

  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(AI_GATEWAY_ORIGIN)) return below(input, init);
    systems.push(systemText(JSON.parse(init.body)));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  controlPlane.addWorkspace("ws_mine", "mine", binding("assist-mine", "AA"));
  controlPlane.addWorkspace("ws_pinned", "context-lc", binding("assist-pinned", "BB"), { kind: "shared" });
  controlPlane.setBuiltinVerdict("ws_mine", BUILTIN_ALLOWED);
  controlPlane.setBuiltinVerdict("ws_pinned", BUILTIN_ALLOWED);

  for (const bucket of ["assist-mine", "assist-pinned"]) {
    s3.bucketFor(bucket).set("privacy.md", { body: manifest(), etag: "p0" });
  }
  // The person's own context has an ai/production/ folder too; only the
  // pinned one's is the assistant's setup.
  s3.bucketFor("assist-mine").set(PRODUCTION_TEXTING_PATH, { body: setupFile("texting-assistant", "NOT-THE-PINNED-ONE"), etag: "m0" });
  pinnedBucket = s3.bucketFor("assist-pinned");

  const member = [{ workspaceId: "ws_pinned", role: "member" }];
  const scopes = ["context:read", "context:write", "context:private"];
  await controlPlane.addGrant({
    workspaceId: "ws_mine", role: "owner", userId: "user_texts", accessToken: TOKEN_TEXTS,
    scopes, clientId: "context_texts", alsoMemberOf: member,
  });
  await controlPlane.addGrant({
    workspaceId: "ws_mine", role: "owner", userId: "user_app", accessToken: TOKEN_APP,
    scopes, clientId: "mcp_client_assist_app", alsoMemberOf: member,
  });
  // A self-hosted deployment: no pinned workspace at all.
  await controlPlane.addGrant({
    workspaceId: "ws_mine", role: "owner", userId: "user_lonely", accessToken: TOKEN_LONELY,
    scopes, clientId: "context_texts",
  });
  // Staff, whose turn runs inside @context-lc itself.
  await controlPlane.addGrant({
    workspaceId: "ws_pinned", role: "owner", userId: "user_staff", accessToken: TOKEN_STAFF,
    scopes, clientId: "context_texts",
  });
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  pinnedBucket.set("privacy.md", { body: manifest(), etag: "p1" });
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile("texting-assistant", `${WHO}\n\n${STYLE}`), etag: "a0" });
  pinnedBucket.set(RETIRED_APP_PATH, { body: setupFile("app-assistant", RETIRED_APP_MARK), etag: "t0" });
});

test("a texted turn is told the texting file's words, in place of the built-in ones", async () => {
  const system = await systemFor(TOKEN_TEXTS);
  assert.ok(system.includes(WHO) && system.includes(STYLE), "the texting file's prompt");
  assert.ok(!system.includes("updated: 2026-10-08"), "front matter is not sent");
  assert.ok(!system.includes("You are Tex, the assistant built into"), "built-in identity replaced");
  assert.ok(!system.includes("No Markdown at all"), "built-in texting style replaced");
  assert.ok(!system.includes("NOT-THE-PINNED-ONE"), "only the pinned workspace's file counts");
  assert.ok(system.includes("you change notes yourself when they ask"), "what the code decides is still said");
});

test("an app turn gets the built-in words: no texting file, and the retired app file is never read", async () => {
  const system = await systemFor(TOKEN_APP);
  assert.ok(!system.includes(WHO));
  assert.ok(!system.includes(STYLE));
  assert.ok(!system.includes(RETIRED_APP_MARK), "the retired app-assistant note is not read");
  assert.ok(system.includes("Cite the note path"));
});

test("staff working inside @context-lc get the files too", async () => {
  const system = await systemFor(TOKEN_STAFF);
  assert.ok(system.includes(WHO) && system.includes(STYLE));
});

test("with no pinned workspace the built-in words say what Context is", async () => {
  const system = await systemFor(TOKEN_LONELY);
  assert.ok(!system.includes(WHO));
  assert.ok(system.includes("context.lc"), "names the product");
  assert.ok(system.includes("not of any other notes app"), "and rules out other apps");
  assert.ok(system.includes("No Markdown at all"), "built-in texting style");
});

test("a missing file means the built-in words for that job only", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  const texted = await systemFor(TOKEN_TEXTS);
  assert.ok(!texted.includes(WHO));
  assert.ok(texted.includes("You are Tex, the assistant built into"), "built-in identity");
  assert.ok(texted.includes("No Markdown at all"), "built-in texting style");
  assert.ok(!(await systemFor(TOKEN_APP)).includes(RETIRED_APP_MARK), "an app turn reads no file at all");
});

test("the retired assistant/ notes are never read", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  pinnedBucket.set("assistant/instructions.md", { body: "RETIRED-MARK\n", etag: "r0" });
  pinnedBucket.set("assistant/texting.md", { body: "RETIRED-MARK\n", etag: "r1" });
  assert.ok(!(await systemFor(TOKEN_TEXTS)).includes("RETIRED-MARK"));
});

test("a file privacy.md holds back from members is not sent to their model", async () => {
  pinnedBucket.set("privacy.md", { body: manifest(`  ${PRODUCTION_TEXTING_PATH}: private\n`), etag: "p2" });
  const member = await systemFor(TOKEN_TEXTS);
  assert.ok(!member.includes(WHO));
  assert.ok(member.includes("You are Tex, the assistant built into"));
  // Its owner's turn still reads it: the rule is the privacy engine's.
  assert.ok((await systemFor(TOKEN_STAFF)).includes(WHO));
});

test("an overgrown file is refused, so it cannot crowd out the question", async () => {
  pinnedBucket.set(PRODUCTION_TEXTING_PATH, { body: setupFile("texting-assistant", `${WHO}\n${"x".repeat(40_001)}`), etag: "a1" });
  const system = await systemFor(TOKEN_TEXTS);
  assert.ok(!system.includes(WHO));
  // A bound on the built-in words alone, far under the 40,000 refused: raised
  // from 5,000 when texted turns were told about their check-ins (heartbeat.js),
  // and from 6,000 when they were told what a text about their pings means (checkIns.js),
  // and from 6,500 when they were told to send the link a note read carries (noteLinks.js),
  // and from 7,000 when every turn was told when to offer a shared workspace (workspaces.js; 7,664 then),
  // and from 8,000 when texted turns were told where their calendar and email sync to (prompt.js; 8,150 then),
  // and from 8,500 when they were told to answer a call from the meetings list (prompt.js, MEETINGS_LINE; 8,7xx then),
  // and from 9,000 when they were told never to hand back work they can do (prompt.js, DO_IT_YOURSELF_LINE, 2026-10-22),
  // and from 9,600 when that line became the adopted hand-back rule: what they may be asked for, captchas only after every try (9,884 then).
  // and from 10,000 when they were told what they can do outside the notes and to keep a fact the moment it's given (ACTIONS_LINE, REMEMBER_LINE, 2026-10-23; 11,035 then).
  // and from 11,500 when a texter with no Gmail connected, or one that can only be read, is offered it once (googleOffer.js, 2026-10-23).
  // and from 12,000 when a note they ask for is saved, and filed in the subfolder that fits (prompt.js, SAVING_LINE, 2026-10-24; 12,244 then).
  // and from 12,500 when they were told a reorganize they ask for is theirs to do at once (prompt.js, REORGANIZE_LINE, 2026-10-25).
  // and from 13,000 when they were told to push back once on a request against their goals, and never flatter (pushback.js, OPINION_LINE, 2026-10-25; 13,647 then).
  // and from 14,000 when they were told to ask the one brief-changing question and price the whole figure (prompt.js, RESEARCH_LINE, 2026-10-26; 14,278 then).
  assert.ok(system.length < 14_500, `system was ${system.length} characters`);
});

test("a texted turn does the reorganizing it's asked for itself (owner, 2026-10-25)", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  const system = await systemFor(TOKEN_TEXTS);
  assert.match(system, /do it yourself in this turn: a move keeps who can see each note/);
  assert.match(system, /Several notes go in one move_notes/);
});

test("a texted turn by somebody with no Gmail connected is asked to offer it once (owner, 2026-10-23)", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  const system = await systemFor(TOKEN_TEXTS);
  assert.match(system, /they have no Gmail connected yet/);
  assert.match(system, /manage connect_google \(kind gmail\)/);
});

test("a texted turn saves a note it's asked for, and files it in the subfolder that fits (self-review, 2026-10-24)", async () => {
  pinnedBucket.delete(PRODUCTION_TEXTING_PATH);
  const system = await systemFor(TOKEN_TEXTS);
  assert.match(system, /Never refuse twice/);
  assert.match(system, /put it in the one that fits/);
});
