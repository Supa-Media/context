/**
 * `remember`: an agent saving a durable fact about the person into their
 * Context (docs/design/remember).
 *
 * The promises: the fact lands as one plain line in the note the agent named
 * (or a new inbox note), with nothing else in the note changed; a replaced
 * line is swapped exactly, or nothing happens; provenance (fact, stated or
 * inferred, the old wording) lives in the audit record and never in the note
 * or in Activity; every rule `write_note` applies (workspace, permissions,
 * reserved paths, encryption, conflicts) applies here unchanged.
 *
 * ## Sabotage record
 *
 * Matching `replaces` by "contains" instead of the whole line failed "replaces
 * matches a whole line". Dropping the one retry failed "a write that loses a
 * race". Dropping the reserved-path check, marking the tool read-only, putting
 * the fact into the change summary, and dropping `mustCreate` from the inbox
 * write each failed their test. (`mustCreate` only shows on storage without
 * live editing: with it, `write_note` already refuses an overwrite, which is
 * why the inbox test runs on both.) In `packages/shared`, counting notes
 * instead of facts and refusing to merge across folders failed the
 * `remembered` checks in test/activity/remembered.test.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-remember.test";
const OWNER = `cat_remember_owner_${"0".repeat(21)}`;
const READ_ONLY = `cat_remember_readonly_${"0".repeat(18)}`;
const RAW = `cat_remember_raw_${"0".repeat(23)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
const PREFS = "3-resources/working-preferences.md";
const PREFS_TEXT = "# Working preferences\n\n- Prefer concise but complete answers.\n- Use plain language.\n";

function binding(bucket, capabilities = {}) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLERM",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLERM",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store", ...capabilities },
    status: "active",
  };
}

async function rpc(token, method, params, path = "/mcp") {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
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

async function call(token, name, args) {
  const result = await rpc(token, "tools/call", { name, arguments: args });
  return { text: result?.content?.[0]?.text || "", isError: result?.isError === true };
}

const remember = (args, token = OWNER) => call(token, "remember", args);
const read = async (path, token = OWNER) => (await call(token, "read_note", { path })).text.split("\n\n").slice(1).join("\n\n");

let s3;
let controlPlane;
let restore = [];

function objects(bucket) {
  return s3.buckets.get(bucket) ?? new Map();
}
function bodyOf(object) {
  return typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body);
}
function audits(bucket) {
  return [...objects(bucket)]
    .filter(([key]) => key.startsWith(".context/audit/"))
    .map(([, object]) => JSON.parse(bodyOf(object)));
}

before(async () => {
  s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.addWorkspace("ws_me", "me", binding("remember-me"));
  controlPlane.addWorkspace("ws_team", "team", binding("remember-team"));
  controlPlane.addWorkspace("ws_other", "other", binding("remember-other"));
  controlPlane.addWorkspace("ws_edit", "edit", binding("remember-edit"));
  // No conditional create: no live-editing engine, so a write from a stale
  // version is refused by the store rather than merged by the engine.
  controlPlane.addWorkspace("ws_raw", "raw", binding("remember-raw", { conditionalCreate: false }));
  await controlPlane.addGrant({
    workspaceId: "ws_me",
    userId: "user_me",
    accessToken: OWNER,
    scopes: ["context:read", "context:write", "context:private"],
    alsoMemberOf: [
      { workspaceId: "ws_team", role: "owner" },
      { workspaceId: "ws_edit", role: "editor" },
    ],
  });
  await controlPlane.addGrant({
    workspaceId: "ws_me",
    userId: "user_me",
    accessToken: READ_ONLY,
    scopes: ["context:read", "context:private"],
    clientId: "mcp_client_readonly",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_raw",
    userId: "user_me",
    accessToken: RAW,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_raw",
  });
});

beforeEach(async () => {
  for (const bucket of ["remember-me", "remember-team", "remember-other", "remember-raw", "remember-edit"]) s3.buckets.set(bucket, new Map());
  const seeded = await call(OWNER, "write_note", { path: PREFS, content: PREFS_TEXT });
  assert.equal(seeded.isError, false, seeded.text);
});

after(() => {
  for (const undo of restore.reverse()) undo?.();
});

test("adds a fact as the last line, and changes nothing else in the note", async () => {
  const answer = await remember({ fact: "Prefers short replies.", kind: "stated", note: PREFS });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(await read(PREFS), `${PREFS_TEXT}- Prefers short replies.\n`);
});

test("replaces exactly one line, and the audit record keeps the old wording and the kind", async () => {
  const answer = await remember({
    fact: "Prefers short replies.",
    kind: "inferred",
    note: PREFS,
    replaces: "Prefer concise but complete answers.",
  });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(await read(PREFS), "# Working preferences\n\n- Prefers short replies.\n- Use plain language.\n");
  const record = audits("remember-me").find((entry) => entry.action === "remember_fact");
  assert.ok(record, "no remember_fact audit record");
  assert.deepEqual(record.paths, [PREFS]);
  assert.equal(record.details.fact, "Prefers short replies.");
  assert.equal(record.details.kind, "inferred");
  assert.equal(record.details.replaced, "- Prefer concise but complete answers.");
});

test("a replaces that matches no line, or two, refuses and writes nothing", async () => {
  const missing = await remember({ fact: "x.", kind: "stated", note: PREFS, replaces: "Never said this." });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no line/i);
  await call(OWNER, "write_note", { path: "2-areas/twice.md", content: "- Same.\n- Same.\n" });
  const twice = await remember({ fact: "x.", kind: "stated", note: "2-areas/twice.md", replaces: "Same." });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /more than one/i);
  assert.equal(await read(PREFS), PREFS_TEXT);
  assert.equal(await read("2-areas/twice.md"), "- Same.\n- Same.\n");
});

test("without a note, the fact becomes a new inbox note, never overwriting one", async () => {
  // Both kinds of storage: with live editing, and without it, where an
  // overwrite would otherwise go through.
  for (const [token, bucket] of [[OWNER, "remember-me"], [RAW, "remember-raw"]]) {
    const first = await remember({ fact: "Lives in Boston.", kind: "stated" }, token);
    const second = await remember({ fact: "Lives in Boston.", kind: "stated" }, token);
    assert.equal(first.isError, false, first.text);
    assert.equal(second.isError, false, second.text);
    const inbox = [...objects(bucket).keys()].filter((key) => key.startsWith("0-inbox/remembered-"));
    assert.equal(inbox.length, 2, `${bucket}: ${JSON.stringify(inbox)}`);
    for (const key of inbox) assert.equal(await read(key, token), "- Lives in Boston.\n");
  }
});

test("replaces matches a whole line, never a line that merely contains it", async () => {
  await call(OWNER, "write_note", {
    path: "2-areas/style.md",
    content: "- Use plain language in emails.\n- Use plain language.\n",
  });
  const answer = await remember({ fact: "Use plain words.", kind: "stated", note: "2-areas/style.md", replaces: "Use plain language." });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(await read("2-areas/style.md"), "- Use plain language in emails.\n- Use plain words.\n");
});

test("writes in another workspace through context, as write_note does, and nowhere else", async () => {
  const answer = await call(OWNER, "remember", { fact: "Team uses Linear.", kind: "stated", context: "@team" });
  assert.equal(answer.isError, false, answer.text);
  const teamInbox = [...objects("remember-team").keys()].filter((key) => key.startsWith("0-inbox/remembered-"));
  assert.equal(teamInbox.length, 1);
  assert.equal([...objects("remember-me").keys()].some((key) => key.startsWith("0-inbox/remembered-")), false);
  // As an editor, the answer is write_note's for the same destination.
  const asEditor = await call(OWNER, "remember", { fact: "x.", kind: "stated", context: "@edit" });
  const writeAsEditor = await call(OWNER, "write_note", { path: "0-inbox/x.md", content: "- x.\n", context: "@edit" });
  assert.equal(asEditor.isError, writeAsEditor.isError);
  assert.equal(asEditor.text, writeAsEditor.text);
  // A workspace the person does not belong to is refused, and untouched.
  const elsewhere = await call(OWNER, "remember", { fact: "x.", kind: "stated", context: "@other" });
  assert.equal(elsewhere.isError, true);
  assert.equal(objects("remember-other").size, 0);
});

test("a read-only connection is not offered remember and cannot call it", async () => {
  const tools = ((await rpc(READ_ONLY, "tools/list", {}))?.tools || []).map((tool) => tool.name);
  assert.equal(tools.includes("remember"), false);
  const answer = await remember({ fact: "x.", kind: "stated", note: PREFS }, READ_ONLY);
  assert.equal(answer.isError, true);
  assert.equal(await read(PREFS), PREFS_TEXT);
});

test("a password-locked note is refused and left exactly as it was", async () => {
  const locked = JSON.parse(readFileSync(new URL("./encryptionPassphraseVector.fixtures.json", import.meta.url), "utf8")).document;
  objects("remember-me").set("2-areas/locked.md", { body: locked, etag: '"locked"' });
  const answer = await remember({ fact: "x.", kind: "stated", note: "2-areas/locked.md" });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^encrypted:/);
  assert.equal(bodyOf(objects("remember-me").get("2-areas/locked.md")), locked);
});

test("reserved notes and bad facts are refused", async () => {
  for (const note of ["index.md", "privacy.md", "activity.md", ".context/notes.md"]) {
    const answer = await remember({ fact: "x.", kind: "stated", note });
    assert.equal(answer.isError, true, note);
  }
  for (const args of [
    { fact: "", kind: "stated" },
    { fact: "two\nlines", kind: "stated" },
    { fact: "x".repeat(501), kind: "stated" },
    { fact: "fine.", kind: "maybe" },
  ]) {
    const answer = await remember(args);
    assert.equal(answer.isError, true, JSON.stringify(args).slice(0, 60));
  }
});

test("the note never carries provenance, and Activity never carries the fact", async () => {
  await remember({ fact: "Prefers short replies.", kind: "inferred", note: PREFS });
  const note = await read(PREFS);
  assert.doesNotMatch(note, /inferred|stated|remember|<!--/);
  const activity = bodyOf(objects("remember-me").get("activity.md"));
  assert.match(activity, /remembered 1 fact/);
  assert.doesNotMatch(activity, /Prefers short replies/);
});

test("a write that loses a race is retried once on the newer text, never overwriting it", async () => {
  // Storage without live editing: another writer's edit lands through the
  // gateway just as remember's write goes out, so the store refuses that
  // write; remember re-reads once and lands on top. On storage with live
  // editing the collaboration engine merges instead (packages/collaboration).
  const seeded = await call(RAW, "write_note", { path: PREFS, content: PREFS_TEXT });
  assert.equal(seeded.isError, false, seeded.text);
  const original = s3.handle;
  let interfered = false;
  s3.handle = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const key = decodeURIComponent(new URL(url).pathname);
    if (!interfered && method === "PUT" && key === `/remember-raw/${PREFS}`) {
      interfered = true;
      const other = await call(RAW, "write_note", {
        path: PREFS,
        content: `${PREFS_TEXT}- Added by someone else.\n`,
      });
      assert.equal(other.isError, false, other.text);
    }
    return original(url, init);
  };
  let answer;
  try {
    answer = await remember({ fact: "Prefers short replies.", kind: "stated", note: PREFS }, RAW);
  } finally {
    s3.handle = original;
  }
  assert.equal(interfered, true, "the race was never staged");
  assert.equal(answer.isError, false, answer.text);
  assert.equal(await read(PREFS, RAW), `${PREFS_TEXT}- Added by someone else.\n- Prefers short replies.\n`);
});

/*
  FRONTMATTER IS NOT A LINE AN AGENT REMEMBERS A FACT INTO.

  `replaces` names "the text of an existing line", and the edit used to search
  the whole note for it — frontmatter included. A page's frontmatter is not
  prose about the person, it is the metadata other parts of the product read as
  a control: `audience: members` is what narrows a website page to the
  workspace's members, and `parseWebsitePage` defaults a page with no
  `audience` line to `public`. So one `remember` call naming that exact line —
  a constant string, nothing to guess — swapped the control for a bullet and
  published a members-only page to the internet, with no confirmation, because
  this is the one save that deliberately does not wait for a go.

  Both halves matter and both are asserted: the call is refused, and the note
  is byte for byte what it was. The second is the promise this tool makes in
  its own first test ("changes nothing else in the note").
*/
const PAGE = "website/team-only.md";
const PAGE_TEXT = "---\naudience: members\ntitle: Team only\n---\n\n# Team only\n\n- Internal notes.\n";

test("replaces never edits a line inside the frontmatter block", async () => {
  const seeded = await call(OWNER, "write_note", { path: PAGE, content: PAGE_TEXT });
  assert.equal(seeded.isError, false, seeded.text);
  for (const replaces of ["audience: members", "title: Team only", "---"]) {
    const answer = await remember({ fact: "Works from Lagos.", kind: "stated", note: PAGE, replaces });
    assert.equal(answer.isError, true, `remember edited frontmatter line ${JSON.stringify(replaces)}`);
    assert.match(answer.text, /frontmatter/i);
    assert.equal(await read(PAGE), PAGE_TEXT, `the note changed while replacing ${JSON.stringify(replaces)}`);
  }
});

test("a fact still appends below the frontmatter, and a body line is still replaceable", async () => {
  const seeded = await call(OWNER, "write_note", { path: PAGE, content: PAGE_TEXT });
  assert.equal(seeded.isError, false, seeded.text);
  const added = await remember({ fact: "Works from Lagos.", kind: "stated", note: PAGE });
  assert.equal(added.isError, false, added.text);
  assert.equal(await read(PAGE), `${PAGE_TEXT}- Works from Lagos.\n`);
  const swapped = await remember({
    fact: "Internal notes, reviewed quarterly.",
    kind: "stated",
    note: PAGE,
    replaces: "Internal notes.",
  });
  assert.equal(swapped.isError, false, swapped.text);
  assert.equal(
    await read(PAGE),
    "---\naudience: members\ntitle: Team only\n---\n\n# Team only\n\n- Internal notes, reviewed quarterly.\n- Works from Lagos.\n",
  );
});
