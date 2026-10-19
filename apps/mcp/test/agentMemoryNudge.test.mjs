/**
 * The memory nudge (`src/agent/memoryNudge.js`, Dev 2026-10-19): every 10 of
 * the person's texts, one small turn may add what it learned to
 * `tex/about-me.md` at once, rather than waiting for the nightly dream.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `textsSince` keeping a tainted exchange in `shown` → "an exchange that
 *     read from outside is never shown to the nudge".
 *  2. `nudgeCallTool` passing another path or tool through → "the nudge's
 *     dispatcher refuses …".
 *  3. `memoryNudge` not moving its marker → "… and the next text doesn't
 *     nudge again".
 *  4. The first nudge running over texts from before → "the first turn only
 *     starts the count".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { NUDGE_EVERY, NUDGE_MARKER, nudgeCallTool, nudgeQuestion, textsSince } from "../src/agent/memoryNudge.js";
import { ABOUT_ME_PATH } from "../src/agent/aboutMe.js";
import { eventKey } from "../src/agent/events.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-nudge.test";
const TOKEN_TEXTS = `cat_nudge_texts_${"0".repeat(24)}`;

const ok = (text = "ok") => ({ content: [{ type: "text", text }] });
const isRefused = (result) => result?.isError === true;

/* ---------------- the pieces ---------------- */

const exchange = (at, question, { tainted = false, theirs = true } = {}) => [
  { role: "user", text: question, at, ...(theirs ? { theirs: true } : {}) },
  { role: "assistant", text: `re ${question}`, ...(tainted ? { tainted: true } : {}) },
];

test("an exchange that read from outside is never shown to the nudge, though its text is counted", () => {
  const history = [
    ...exchange(100, "old one"),
    ...exchange(200, "I'm vegetarian"),
    ...exchange(300, "what does this page say?", { tainted: true }),
    ...exchange(400, "a routine's run", { theirs: false }),
  ];
  const since = textsSince(history, 150);
  assert.equal(since.count, 2);
  assert.equal(since.newest, 300);
  assert.deepEqual(since.shown.map((e) => e.question), ["I'm vegetarian"]);
  const asked = nudgeQuestion(since.shown);
  assert.match(asked, /They: I'm vegetarian\nYou: re I'm vegetarian/);
  assert.ok(!asked.includes("this page"));
});

test("the nudge's dispatcher refuses anything but about-me in their own workspace, and writes once", async () => {
  const passed = [];
  const call = nudgeCallTool(async (name, args) => {
    passed.push([name, args.path]);
    return ok();
  });
  for (const [name, args] of [
    ["write_note", { path: "1-projects/a.md", content: "x" }],
    ["write_note", { path: "Tex/About-Me.md", content: "x" }],
    ["write_note", { path: ABOUT_ME_PATH, content: "x", context: "@maya" }],
    ["write_note", { path: ABOUT_ME_PATH, content: "x", visibility: "team" }],
    ["remember", { note: ABOUT_ME_PATH, fact: "x" }],
    ["send_email", { path: ABOUT_ME_PATH }],
    ["read_note", { path: "tex/jobs.md" }],
  ]) {
    assert.ok(isRefused(await call(name, args)), `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(passed, []);
  assert.ok(!isRefused(await call("read_note", { path: ABOUT_ME_PATH })));
  assert.ok(!isRefused(await call("write_note", { path: ABOUT_ME_PATH, content: "- likes tea" })));
  assert.ok(isRefused(await call("write_note", { path: ABOUT_ME_PATH, content: "- again" })), "once");
  assert.deepEqual(passed, [["read_note", ABOUT_ME_PATH], ["write_note", ABOUT_ME_PATH]]);
  assert.equal(call.wrote(), true);
});

/* ---------------- texted turns, end to end ---------------- */

const requests = [];
let script = [];
const controlPlane = createControlPlaneStub();
let bucket;
const restore = [];
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };

function reply(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, [name, input]] of (step.calls ?? []).entries()) content.push({ type: "tool_use", id: `toolu_n_${requests.length}_${i}`, name, input });
  return { content, stop_reason: (step.calls ?? []).length > 0 ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
}

async function text(question) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question, timeZone: "UTC", conversation: "texts" }),
    }),
    env,
    ctx,
  );
  const body = await response.json().catch(() => null);
  await settle();
  return { status: response.status, body };
}

const nudges = () => requests.filter((r) => r.client === "memory_nudge");
const marker = () => JSON.parse(bucket.get(NUDGE_MARKER)?.body ?? "null");

/** `n` texts of theirs, already answered, an hour ago and after. */
function seedTexts(n, start, { tainted = () => false } = {}) {
  for (let i = 0; i < n; i += 1) {
    const at = start + i * 1_000;
    bucket.set(eventKey(at, `seed${String(i).padStart(2, "0")}`), {
      body: JSON.stringify({ v: 1, at, question: `text ${i}${i === 3 ? ": I'm vegetarian" : ""}`, answer: `answer ${i}`, by: "them", ...(tainted(i) ? { tainted: true } : {}) }),
      etag: `e${i}`,
    });
  }
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      const body = JSON.parse(init.body);
      const meta = new Headers(init.headers).get("cf-aig-metadata") ?? "";
      requests.push({ body, client: /"client":"memory_nudge"/.test(meta) ? "memory_nudge" : /"client":"reflect"/.test(meta) ? "reflect" : "turn" });
      const step = script.shift() ?? { text: "Done." };
      return new Response(JSON.stringify(reply(step)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });
  controlPlane.addWorkspace("ws_nudge", "nudger", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-nudge",
    accessKeyId: "AKIAEXAMPLEEXAMPLENG",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLENG",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.setBuiltinVerdict("ws_nudge", BUILTIN_ALLOWED);
  await controlPlane.addGrant({
    workspaceId: "ws_nudge",
    role: "owner",
    userId: "user_nudge",
    accessToken: TOKEN_TEXTS,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_texts",
  });
  controlPlane.serveTreesFrom(env, { s3 });
  bucket = s3.bucketFor("tenant-nudge");
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  requests.length = 0;
  script = [];
  for (const key of [...bucket.keys()]) bucket.delete(key);
});

const START = Date.now() - 3_600_000;

test("the first turn only starts the count", async () => {
  seedTexts(NUDGE_EVERY + 2, START);
  await text("hi");
  assert.equal(nudges().length, 0);
  assert.ok(marker().at >= START + (NUDGE_EVERY + 1) * 1_000, "texts from before are behind the marker");
});

test("fewer than 10 texts since the last nudge: no nudge", async () => {
  bucket.set(NUDGE_MARKER, { body: JSON.stringify({ at: START - 1 }), etag: "m0" });
  seedTexts(NUDGE_EVERY - 1, START);
  await text("hi");
  assert.equal(nudges().length, 0);
  assert.equal(marker().at, START - 1);
});

test("10 texts since the last nudge: about-me is written once, and the next text doesn't nudge again", async () => {
  bucket.set(NUDGE_MARKER, { body: JSON.stringify({ at: START - 1 }), etag: "m0" });
  seedTexts(NUDGE_EVERY, START, { tainted: (i) => i === 5 });
  script = [{ text: "Hi!" }, { calls: [["write", { path: ABOUT_ME_PATH, content: "- Vegetarian.\n" }]] }, { text: "DONE" }];
  const response = await text("hi");
  assert.equal(response.status, 200);
  assert.equal(response.body.answer, "Hi!");
  assert.equal(nudges().length, 2, "one nudge, two rounds");
  const asked = JSON.stringify(nudges()[0].body);
  assert.match(asked, /I'm vegetarian/);
  assert.ok(!asked.includes("text 5") && !asked.includes("answer 5"), "a tainted exchange is left out whole");
  assert.deepEqual(nudges()[0].body.tools.map((tool) => tool.name).sort(), ["fetch", "write"]);
  assert.match(bucket.get(ABOUT_ME_PATH)?.body ?? "", /Vegetarian/);
  assert.ok(marker().at >= START + (NUDGE_EVERY - 1) * 1_000);

  requests.length = 0;
  await text("thanks");
  assert.equal(nudges().length, 0);
});
