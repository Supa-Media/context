/**
 * WHAT A CHECK-IN'S READS COST (production, 2026-10-19).
 *
 * The 1:12 pm and 2 pm check-ins texted and wrote no entry to their day's log,
 * while short looks did. Every Worker invocation has one subrequest ceiling,
 * and every storage and control-plane call spends from it. A first
 * `read_note` of a note cost 24 of them, 15 of which started a collaboration
 * document (head, state, seed revision, the re-reads that refuse races) for a
 * note nobody was editing; a look reading 35 changed inbox notes spent ~950
 * before its log was written.
 *
 * A check-in only reads, so its reads start no document
 * (`store.readsStartNoDocument`, `readDocumentIfStarted`): a note without
 * collaboration state is served as its Markdown, with the Markdown's etag,
 * and its own log is still appended to through `write_note` from that etag.
 * Every other caller's read still starts one.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-19).
 *
 *  1. `handleHeartbeat` not setting `readsStartNoDocument`.
 *     → "a check-in that reads five notes starts no document for them…" fails.
 *  2. `readDocumentIfStarted` returning null whatever the head says.
 *     → "a note that already has a document is read through it, by a check-in too"
 *       fails (and the first, as the log's own append then conflicts).
 *  3. `toolReadNote` using `readDocumentIfStarted` for every caller.
 *     → "an app's read still starts the note's document…" fails.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { heartbeatPath } from "../src/agent/heartbeat.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-readcost.test";
const TOKEN_BEAT = `cat_readcost_beat_${"0".repeat(22)}`;
const TOKEN_APP = `cat_readcost_app_${"0".repeat(23)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
const HEADS = ".context/collaboration/v1/heads/";
const MAILS = 6;
const mailPath = (i) => `0-inbox/email/mail-${i}.md`;

const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  4-archive: private\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

let bucket;
let restore = () => {};
/** Every subrequest the gateway makes, storage and control plane alike, as the runtime counts them. The model is not counted. */
let subrequests = 0;
let script = [];
/** What the model was sent, newest last: a tool's answer reaches it in the next request. */
const modelRequests = [];

function modelAnswer(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, call] of (step.toolCalls ?? []).entries()) {
    content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
  }
  return new Response(JSON.stringify({ content, stop_reason: step.toolCalls?.length ? "tool_use" : "end_turn" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

before(async () => {
  const previous = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const stubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      modelRequests.push(String(init?.body ?? ""));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      return modelAnswer(step);
    }
    subrequests += 1;
    return stubs(input, init);
  };
  restore = () => {
    globalThis.fetch = previous;
    restoreControlPlane();
    restoreS3();
  };
  controlPlane.addWorkspace("ws_readcost", "reader", {
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-readcost",
    accessKeyId: "AKIAEXAMPLEEXAMPLERC",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLERC",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  });
  for (const [accessToken, clientId] of [
    [TOKEN_BEAT, "context_heartbeat"],
    [TOKEN_APP, "client_readcost_app"],
  ]) {
    await controlPlane.addGrant({
      accessToken,
      workspaceId: "ws_readcost",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId,
      userId: "user_readcost",
    });
  }
  controlPlane.setBuiltinVerdict("ws_readcost", BUILTIN_ALLOWED);
  bucket = s3.bucketFor("tenant-readcost");
  bucket.set("privacy.md", { body: MANIFEST, etag: "m0" });
  const recently = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (let i = 0; i < MAILS; i += 1) {
    bucket.set(mailPath(i), { body: `# Mail ${i}\n\nPlease reply by Friday.\n`, etag: `mail-${i}`, lastModified: recently });
  }
  controlPlane.serveTreesFrom(env, { s3 });
});

after(() => restore());

async function post(token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const before = subrequests;
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const parsed = JSON.parse(await response.text());
  await settle();
  return { status: response.status, body: parsed, spent: subrequests - before };
}

/** One check-in whose model reads `paths` in one round, then texts. */
async function look(paths) {
  script = [...(paths.length ? [{ toolCalls: paths.map((path) => ({ name: "read_note", args: { path } })) }] : []), { text: "Mail 1 needs a reply by Friday." }];
  return post(TOKEN_BEAT, "/agent", { heartbeat: { timeZone: "UTC", since: Date.now() - 2 * 60 * 60 * 1000 } });
}

const headsIn = () => [...bucket.keys()].filter((key) => key.startsWith(HEADS)).length;
const log = () => bucket.get(heartbeatPath(Date.now(), "UTC"))?.body ?? "";

test("a check-in that reads five notes starts no document for them, and each read costs a handful of subrequests", async () => {
  // Two looks that read nothing first: they make the day's log and its document, and the notes its
  // writes touch, so the two looks compared below pay the same for writing it.
  for (let i = 0; i < 2; i += 1) assert.equal((await look([])).body?.outcome, "speak");
  const quiet = await look([]);
  const heads = headsIn();
  const reading = await look([0, 1, 2, 3, 4].map(mailPath));
  assert.equal(reading.body?.outcome, "speak");
  assert.equal(headsIn(), heads, "reading a note wrote nothing for it");
  const perRead = (reading.spent - quiet.spent) / 5;
  // Measured 2026-10-19: 24 a read before, 9 after (its privacy load, the stored read record and
  // its usage reports included). The bound leaves room for those, not for starting a document.
  assert.ok(perRead <= 11, `a check-in's read spent ${perRead} subrequests (look ${reading.spent}, quiet look ${quiet.spent})`);
  assert.equal((log().match(/\*\*Texted:\*\*/g) ?? []).length, 4, "every look's entry is in the day's log");
  assert.match(log(), new RegExp(`read_note\` \`\\{"path":"${mailPath(4)}"\\}\` → ok`));
});

test("an app's read still starts the note's document, and its etag is the document's", async () => {
  const { body } = await post(TOKEN_APP, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_note", arguments: { path: mailPath(5) } },
  });
  const text = body?.result?.content?.[0]?.text ?? "";
  assert.match(text, /^document_id: doc-/m);
  assert.match(text, /^etag: c2\./m);
});

test("a note that already has a document is read through it, by a check-in too", async () => {
  // mail-5 has a document since the app read it above.
  const before = headsIn();
  const reading = await look([mailPath(5)]);
  assert.equal(reading.body?.outcome, "speak");
  assert.equal(headsIn(), before);
  // The read's answer goes back to the model in its next request: the document's, with its id and etag.
  const answered = modelRequests.at(-1);
  assert.match(answered, /document_id: doc-/);
  assert.match(answered, /etag: c2\./);
});
