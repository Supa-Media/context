/**
 * A provisional run (`src/agent/steer.js`; the config's "Provisional run" wire, Dev2, 2026-11-17): the texting Worker
 * starts a turn before Triage, Decide and the Queue have answered, so Front door is not left waiting on them. Until
 * the Worker says go (`/agent/go`), nothing the turn would change runs; the Worker may stop it at any point
 * (`/agent/cancel` with `provisional: true`), mid-model-call included, and the stopped run is logged as such.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `track` not waiting for the go (drop the `waitGo` line) → "a provisional run's write waits for the go".
 *  2. `track` running the write when the wait ends in a stop (return `call(...)` instead of STOPPED) → "stopped before
 *     the go, its write never runs".
 *  3. `cancelTurn` ignoring `provisional` (drop its branch) → "a provisional run can be stopped before it marks itself
 *     running".
 *  4. `goTurn` not checking the running record's user → "go only for this person's running turn".
 *  5. `turn.js` not racing the model call against `stopWatch` → "stopped mid-call, /agent answers cancelled at once".
 *  6. `track` holding a note's save for the go (drop its revertible branch) → "a note saved before the go is put back".
 *  7. `revert` skipped on a stop (drop the `provisional_undo` line in `runTheModel.js`) → "a note saved before the go is put
 *     back when the run is stopped".
 *  8. `allow: "read"` ignored → "allow read holds even a note's save".
 *  9. `runTheModel.js` not waiting for the go → "a provisional run answers only once told go".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/logicalDelete.js";
import { CANCEL_PREFIX, GO_PREFIX, RUNNING_PREFIX, cancelTurn, goTurn, revertibleNote, steerFor } from "../src/agent/steer.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { texStoreNamespace, withAgentHome } from "./texStoreFixture.mjs";

const TURN = "turn-prov-0001";
const me = { actorClientId: "context_texts", actorUserId: "user_p" };
const someoneElse = { actorClientId: "context_texts", actorUserId: "user_q" };
const quick = { limitMs: 2_000, sleep: () => new Promise((r) => setTimeout(r, 5)) };

function memoryStore() {
  const data = new Map();
  return {
    data,
    async put(key, body) {
      data.set(key, body);
    },
    async get(key) {
      return data.has(key) ? { text: async () => data.get(key) } : null;
    },
    async list({ prefix }) {
      return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

/* ---------------- the pieces ---------------- */

test("a turn not run provisionally writes at once, as before", async () => {
  const store = memoryStore();
  const steer = steerFor(store, me, { turn: TURN });
  assert.equal(steer.provisional, false);
  let ran = false;
  await steer.track(async () => ((ran = true), {}))("write_note", {});
  assert.equal(ran, true);
});

test("a provisional run's write waits for the go, then runs", async () => {
  const store = memoryStore();
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  await steer.begin();
  let ran = false;
  const write = steer.track(async () => ((ran = true), { content: [{ type: "text", text: "saved" }] }))("write_note", {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran, false, "held before the go");
  assert.equal(await goTurn(store, me, TURN), true);
  const result = await write;
  assert.equal(ran, true);
  assert.equal(result.content[0].text, "saved");
  // A read never waits.
  const steer2 = steerFor(memoryStore(), me, { turn: "turn-prov-0002", provisional: true });
  let read = false;
  await steer2.track(async () => ((read = true), {}))("search_web", {});
  assert.equal(read, true);
});

test("stopped before the go, its write never runs and the turn can still be cancelled", async () => {
  const store = memoryStore();
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  await steer.begin();
  let ran = false;
  const write = steer.track(async () => ((ran = true), {}))("write_note", {});
  assert.equal(await cancelTurn(store, me, TURN, { provisional: true }), true);
  const result = await write;
  assert.equal(ran, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stopped before it could change anything/);
  assert.equal(steer.wrote, false);
  assert.equal(await steer.endCancelled(), true);
});

test("a provisional run can be stopped before it marks itself running; any other turn cannot", async () => {
  const store = memoryStore();
  assert.equal(await cancelTurn(store, me, TURN), false, "an ordinary cancel needs the turn running");
  assert.equal(store.data.has(`${CANCEL_PREFIX}${TURN}.json`), false);
  assert.equal(await cancelTurn(store, me, TURN, { provisional: true }), true);
  assert.equal(store.data.has(`${CANCEL_PREFIX}${TURN}.json`), true);
  // The run, starting after, sees its stop at once.
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  await steer.begin();
  assert.equal(await steer.waitGo(quick), false);
});

test("go only for this person's running, uncancelled turn", async () => {
  const store = memoryStore();
  assert.equal(await goTurn(store, me, TURN), false, "not running");
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  await steer.begin();
  assert.equal(await goTurn(store, someoneElse, TURN), false, "someone else's");
  assert.equal(store.data.has(`${GO_PREFIX}${TURN}.json`), false);
  assert.equal(await goTurn(store, me, TURN), true);
  assert.equal(await steer.released(), true);
  const stopped = memoryStore();
  const other = steerFor(stopped, me, { turn: TURN, provisional: true });
  await other.begin();
  await cancelTurn(stopped, me, TURN, { provisional: true });
  assert.equal(await goTurn(stopped, me, TURN), false, "a stopped run is never let go");
  await other.clear();
  assert.equal([...stopped.data.keys()].filter((k) => k.startsWith(GO_PREFIX) || k.startsWith(CANCEL_PREFIX) || k.startsWith(RUNNING_PREFIX)).length, 0);
});

test("the stop watch: true when stopped, false once go or done", async () => {
  const store = memoryStore();
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  await steer.begin();
  const watch = steer.stopWatch(quick);
  setTimeout(() => void cancelTurn(store, me, TURN, { provisional: true }), 20);
  assert.equal(await watch.stopped, true);
  const store2 = memoryStore();
  const steer2 = steerFor(store2, me, { turn: TURN, provisional: true });
  await steer2.begin();
  const watch2 = steer2.stopWatch(quick);
  setTimeout(() => void goTurn(store2, me, TURN), 20);
  assert.equal(await watch2.stopped, false);
  const watch3 = steerFor(memoryStore(), me, { turn: TURN }).stopWatch(quick);
  assert.equal(await watch3.stopped, false, "nothing to watch for a turn not run provisionally");
});

test("which writes a provisional run can undo", () => {
  assert.deepEqual(revertibleNote("write", { path: "a.md", content: "x" }), { path: "a.md" });
  assert.deepEqual(revertibleNote("write", { path: "a.md", content: "x", args: { context: "@team" } }), { path: "a.md", context: "@team" });
  assert.deepEqual(revertibleNote("write", { action: "remember", args: { fact: "f", kind: "stated", note: "me.md" } }), { path: "me.md" });
  assert.equal(revertibleNote("write", { action: "remember", args: { fact: "f", kind: "stated" } }), null, "a new note named later");
  assert.equal(revertibleNote("write", { path: "a.md", content: "x", args: { images: [] } }), null, "more than the text");
  assert.equal(revertibleNote("write", { action: "comment", path: "a.md", args: {} }), null);
  assert.deepEqual(revertibleNote("write_note", { path: "a.md", content: "x" }), { path: "a.md" });
  assert.equal(revertibleNote("write_note", { path: "a.md", visibility: "team", content: "x" }), null);
  assert.equal(revertibleNote("send_email", { to: "a@example.com" }), null);
});

function fakeNotes(initial) {
  const notes = new Map(Object.entries(initial));
  let version = 0;
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push([name, args]);
    if (name === "read_note") {
      if (!notes.has(args.path)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: v${version}\npath: ${args.path}\nvisibility: private\n\n${notes.get(args.path)}` }] };
    }
    if (name === "write_note" || name === "write") {
      version += 1;
      notes.set(args.path, args.content);
      return { content: [{ type: "text", text: "saved" }] };
    }
    if (name === "archive_note") {
      notes.delete(args.path);
      return { content: [{ type: "text", text: "archived" }] };
    }
    return { content: [{ type: "text", text: "ok" }] };
  };
  return { notes, calls, dispatch };
}

test("a note saved before the go runs at once, and is put back on a stop", async () => {
  const store = memoryStore();
  const { notes, calls, dispatch } = fakeNotes({ "plan.md": "# Plan\n\nOld.\n" });
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  steer.revertWith(dispatch);
  await steer.begin();
  const save = steer.track(dispatch);
  await save("write", { path: "plan.md", content: "# Plan\n\nNew.\n" });
  await save("write", { action: "remember", args: { fact: "Likes tea", kind: "stated", note: "plan.md" } });
  assert.equal(notes.get("plan.md"), "# Plan\n\nNew.\n", "ran before any go");
  assert.equal(steer.wrote, false, "undoable: a stop is still allowed");
  // A new note waits: Context has no delete to take it back with.
  const fresh = save("write", { path: "fresh.md", content: "hello" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notes.has("fresh.md"), false);
  assert.deepEqual(steer.changed, ["plan.md", "plan.md"]);
  assert.equal(await cancelTurn(store, me, TURN, { provisional: true }), true);
  assert.equal((await fresh).isError, true);
  const undone = await steer.revert();
  assert.deepEqual(undone, [{ path: "plan.md", how: "restored", ok: true }, { path: "plan.md", how: "restored", ok: true }]);
  assert.equal(notes.get("plan.md"), "# Plan\n\nOld.\n");
  assert.equal(notes.has("fresh.md"), false);
  const restore = calls.find(([name, args]) => name === "write_note" && args.content === "# Plan\n\nOld.\n");
  assert.equal(restore[1].expected_etag, "v3", "put back over the version it wrote, so a later edit is never lost");
});

test("allow read holds even a note's save until the go", async () => {
  const store = memoryStore();
  const { notes, dispatch } = fakeNotes({ "plan.md": "old" });
  const steer = steerFor(store, me, { turn: TURN, provisional: true, allow: "read" });
  steer.revertWith(dispatch);
  await steer.begin();
  const write = steer.track(dispatch)("write", { path: "plan.md", content: "new" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notes.get("plan.md"), "old");
  await cancelTurn(store, me, TURN, { provisional: true });
  assert.equal((await write).isError, true);
  assert.equal(notes.get("plan.md"), "old");
  assert.deepEqual(steer.changed, []);
});

test("an email draft, or any write it cannot undo, waits for the go", async () => {
  const store = memoryStore();
  const { dispatch } = fakeNotes({});
  const steer = steerFor(store, me, { turn: TURN, provisional: true });
  steer.revertWith(dispatch);
  await steer.begin();
  let ran = false;
  const draft = steer.track(async () => ((ran = true), {}))("save_email_draft", { to: "a@example.com" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran, false);
  await goTurn(store, me, TURN);
  await draft;
  assert.equal(ran, true);
  assert.equal(steer.wrote, true);
});

/* ---------------- /agent, end to end ---------------- */

const S3_ENDPOINT = "https://s3.example-provisional.test";
const TOKEN_TEXTS = `cat_prov_texts_${"0".repeat(24)}`;
const controlPlane = createControlPlaneStub();
const restore = [];
const tex = texStoreNamespace();
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
let bucket;
let hold = null; // the model's answer waits on this while set
let modelCalls = 0;
let capHold = null; // the control plane's cap check answers only once this settles, while set
let script = []; // the model's answers in order; then "Sure."

function reply(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, [name, input]] of (step.calls ?? []).entries()) content.push({ type: "tool_use", id: `toolu_p_${modelCalls}_${i}`, name, input });
  return { content, stop_reason: (step.calls ?? []).length > 0 ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
}

/** The etag the model was last shown for a note it fetched. */
const etagIn = (sent) => /etag: ([^\\\s]+)/.exec(sent)?.[1];
const fetchThenSave = (content) => [{ calls: [["fetch", { id: "1-projects/plan.md" }]] }, (sent) => ({ calls: [["write", { path: "1-projects/plan.md", content, expected_etag: etagIn(sent) }]] })];

const live = (key) => {
  const entry = bucket.get(key);
  return entry && entry.contentType !== LOGICAL_DELETE_CONTENT_TYPE ? entry : null;
};
const bodyOf = (key) => {
  const entry = live(key);
  if (entry === null) return null;
  return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body);
};
const until = async (check, ms = 3_000) => {
  for (let waited = 0; waited < ms && !(await check()); waited += 10) await new Promise((r) => setTimeout(r, 10));
  return check();
};
/** The Worker's go, once the run has marked itself running. */
const goWhenRunning = (turn) => until(async () => (await call("/agent/go", { turn })).body?.go === true);

async function call(path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env,
    ctx,
  );
  const json = await response.json().catch(() => null);
  await settle();
  return { status: response.status, body: json };
}

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (capHold !== null && /\/gateway\/builtin-model$/.test(new URL(url).pathname)) await capHold;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      const meta = new Headers(init.headers).get("cf-aig-metadata") ?? "";
      if (!/"client":"(reflect|classifier|selfreview|nudge)"/.test(meta)) modelCalls += 1;
      if (hold !== null) await hold;
      const next = /"client":"(reflect|classifier|selfreview|nudge)"/.test(meta) ? { text: "Sure." } : script.shift() ?? { text: "Sure." };
      const step = typeof next === "function" ? next(init.body) : next; // a step may read what the model was shown
      return new Response(JSON.stringify(reply(step)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });
  controlPlane.addWorkspace("ws_prov", "provisioner", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-prov",
    accessKeyId: "AKIAEXAMPLEEXAMPLEPV",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEPV",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.setBuiltinVerdict("ws_prov", BUILTIN_ALLOWED);
  await controlPlane.addGrant({ workspaceId: "ws_prov", role: "owner", userId: "user_prov", accessToken: TOKEN_TEXTS, scopes: ["context:read", "context:write", "context:private"], clientId: "context_texts" });
  controlPlane.serveTreesFrom(env, { s3 });
  bucket = withAgentHome(s3.bucketFor("tenant-prov"), tex, "ws_prov");
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  hold = null;
  capHold = null;
  controlPlane.setBuiltinVerdict("ws_prov", BUILTIN_ALLOWED);
  modelCalls = 0;
  script = [];
  for (const key of [...bucket.keys()]) bucket.delete(key);
  bucket.set("1-projects/plan.md", { body: "# Plan\n\nThe plan.\n", etag: "n0" });
});

test("stopped mid-call, /agent answers cancelled at once and says nothing", async () => {
  let release;
  hold = new Promise((r) => (release = r));
  const asking = call("/agent", { question: "what's the plan", timeZone: "UTC", conversation: "texts", turn: TURN, provisional: true });
  // Wait until the model is being asked, then stop the run.
  for (let i = 0; i < 200 && modelCalls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(modelCalls, 1, "the model was asked before the stop");
  const stop = await call("/agent/cancel", { turn: TURN, provisional: true });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.cancelled, true);
  const answered = await Promise.race([asking, new Promise((r) => setTimeout(() => r("still waiting"), 3_000))]);
  release();
  assert.notEqual(answered, "still waiting", "ended while the model call still ran");
  assert.equal(answered.status, 200);
  assert.equal(answered.body.cancelled, true);
  assert.equal(answered.body.answer, "");
});

test("a provisional run answers only once told go, as any turn", async () => {
  const asking = call("/agent", { question: "hi", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0003", provisional: true });
  await until(() => modelCalls > 0);
  const early = await Promise.race([asking, new Promise((r) => setTimeout(() => r("waiting"), 400))]);
  assert.equal(early, "waiting", "no answer before the go");
  assert.equal(await goWhenRunning("turn-prov-0003"), true);
  const answered = await asking;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.answer, "Sure.");
  // Nothing left behind for the turn.
  assert.deepEqual([...bucket.keys()].filter((k) => live(k) && k.includes("turn-prov-0003") && (k.includes(GO_PREFIX) || k.includes(CANCEL_PREFIX))), []);
});

test("a note saved before the go is put back when the run is stopped", async () => {
  script = [...fetchThenSave("# Plan\n\nChanged early.\n"), { calls: [["write", { path: "1-projects/fresh.md", content: "# Fresh\n" }]] }, { text: "Updated." }];
  // The new note waits for a go that never comes.
  const asking = call("/agent", { question: "update the plan", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0004", provisional: true });
  assert.ok(await until(() => /Changed early/.test(bodyOf("1-projects/plan.md") ?? "")), "saved before any go");
  await until(() => modelCalls >= 3);
  assert.equal((await call("/agent/cancel", { turn: "turn-prov-0004", provisional: true })).body.cancelled, true);
  const answered = await asking;
  assert.equal(answered.body.cancelled, true);
  assert.equal(answered.body.answer, "");
  assert.equal(bodyOf("1-projects/plan.md"), "# Plan\n\nThe plan.\n", "put back");
  assert.equal(bodyOf("1-projects/fresh.md"), null, "a new note never made before the go");
});

test("told go, a note saved early is kept", async () => {
  script = [...fetchThenSave("# Plan\n\nKept.\n"), { text: "Updated." }];
  const asking = call("/agent", { question: "update the plan", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0005", provisional: true });
  assert.equal(await goWhenRunning("turn-prov-0005"), true);
  const answered = await asking;
  assert.equal(answered.body.answer, "Updated.");
  assert.equal(bodyOf("1-projects/plan.md"), "# Plan\n\nKept.\n");
});

test("allow read: the save waits, and a stop leaves the note as it was", async () => {
  script = [{ calls: [["write", { path: "1-projects/plan.md", content: "# Plan\n\nNo.\n" }]] }, { text: "Updated." }];
  const asking = call("/agent", { question: "update the plan", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0006", provisional: true, allow: "read" });
  await until(() => modelCalls >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bodyOf("1-projects/plan.md"), "# Plan\n\nThe plan.\n", "held");
  assert.equal((await call("/agent/cancel", { turn: "turn-prov-0006", provisional: true })).body.cancelled, true);
  const answered = await asking;
  assert.equal(answered.body.cancelled, true);
  assert.equal(bodyOf("1-projects/plan.md"), "# Plan\n\nThe plan.\n");
});

test("Door beside Front door: a provisional run asks the model while the cap check is still out", async () => {
  let answerCap;
  capHold = new Promise((r) => (answerCap = r));
  const asking = call("/agent", { question: "hi", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0007", provisional: true });
  assert.equal(await until(() => modelCalls > 0, 2_000), true, "the model was asked before the cap check answered");
  answerCap();
  assert.equal(await goWhenRunning("turn-prov-0007"), true);
  const answered = await asking;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.answer, "Sure.");
});

test("a turn not run provisionally still waits for the cap check before the model", async () => {
  let answerCap;
  capHold = new Promise((r) => (answerCap = r));
  const asking = call("/agent", { question: "hi", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0008" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(modelCalls, 0, "no model call before the cap check");
  answerCap();
  assert.equal((await asking).body.answer, "Sure.");
});

test("a provisional run the cap refuses runs no tool and says the refusal", async () => {
  controlPlane.setBuiltinVerdict("ws_prov", { allowed: false, reason: "daily_cap" });
  script = [...fetchThenSave("# Plan\n\nNo.\n"), { text: "Updated." }];
  const asking = call("/agent", { question: "update the plan", timeZone: "UTC", conversation: "texts", turn: "turn-prov-0009", provisional: true });
  await goWhenRunning("turn-prov-0009");
  const answered = await asking;
  assert.equal(answered.status, 429);
  assert.equal(answered.body.error, "daily_limit");
  assert.equal(bodyOf("1-projects/plan.md"), "# Plan\n\nThe plan.\n");
});
