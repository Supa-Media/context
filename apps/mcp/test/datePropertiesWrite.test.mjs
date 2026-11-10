/**
 * Date properties filled on the save paths (Dev2, 2026-11-10; `notes/dateStamp.js`):
 *
 *  - an agent's `write_note` stamps them in the same save, so the etag it gets back already covers them and its next
 *    write is not a CONFLICT;
 *  - a person's collaboration save stamps them once typing pauses, as one more edit, and that edit does not set off
 *    another (no loop; that it writes no activity line is `dateStamp.test.mjs`'s);
 *  - a note without the keys is never touched.
 *
 * ## Sabotage record
 *
 * Removing the `datedForWrite` call from `write_note` failed "an agent's write fills both keys" and the quiet stamp
 * case. Which save of a burst stamps is timed in `dateStamp.test.mjs`, where the clock is the test's.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { forgetTimeZones } from "../src/controlPlane/timeZone.js";
import { DATE_QUIET_MS } from "../src/notes/dateStamp.js";

const S3_ENDPOINT = "https://s3.example-date-properties.test";
const AGENT = `cat_date_props_agent_${"0".repeat(19)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };
const ISO_CHICAGO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/;

async function call(name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

/** A person's save from the app: one collaboration replacement, and everything it deferred. */
async function appSave(path, expectedEtag, text) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/collaboration", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, replacement: { expectedEtag, text } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  return { body, status: response.status, settle };
}

async function appRead(path) {
  const { ctx } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/collaboration", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
    env,
    ctx,
  );
  return JSON.parse(await response.text());
}

const etagOf = (text) => /etag[: ]+(c2\.[A-Za-z0-9.-]+|[^\s)]+)/.exec(text)?.[1];
const write = (args) => call("write_note", args);
const read = async (path) => {
  const answer = await call("read_note", { path });
  assert.equal(answer.isError, false, answer.text);
  return { etag: etagOf(answer.text), body: answer.text.split("\n\n").slice(1).join("\n\n") };
};
const valueOf = (body, key) => new RegExp(`^${key}:[ ]?(.*)$`, "m").exec(body)?.[1] ?? null;

let restore = [];
let controlPlane;

before(async () => {
  forgetTimeZones();
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.dreams.state.timeZone = "America/Chicago";
  controlPlane.addWorkspace("ws_dates", "dates", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "date-properties",
    accessKeyId: "AKIAEXAMPLEEXAMPLEDP",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEDP",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_dates",
    userId: "user_owner",
    accessToken: AGENT,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_agent",
  });
});

after(() => {
  for (const undo of restore.reverse()) undo?.();
});

test("an agent's write fills both keys, in the owner's zone, and its etag stays good", async () => {
  const path = "projects/plan.md";
  const created = await write({ path, content: "---\ntitle: Plan\ndate created:\ndate modified:\n---\n\nFirst.\n" });
  assert.equal(created.isError, false, created.text);
  const first = await read(path);
  assert.match(valueOf(first.body, "date created"), ISO_CHICAGO);
  assert.match(valueOf(first.body, "date modified"), ISO_CHICAGO);
  // The etag the write handed back is the note's version: the dates were in that save, not a second one.
  assert.equal(first.etag, etagOf(created.text));

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const edited = await write({ path, content: first.body.replace("First.", "Second."), expected_etag: first.etag });
  assert.equal(edited.isError, false, `the agent's own etag was refused: ${edited.text}`);
  const second = await read(path);
  assert.equal(valueOf(second.body, "date created"), valueOf(first.body, "date created"), "date created never moves");
  assert.notEqual(valueOf(second.body, "date modified"), valueOf(first.body, "date modified"), "date modified follows the edit");
  assert.ok(second.body.includes("Second."));
});

test("a rewrite that changes nothing but dates keeps the agent's words", async () => {
  const path = "projects/plain-dates.md";
  await write({ path, content: "---\nupdated: 2026-01-02\n---\n\nBody\n" });
  const before = await read(path);
  assert.equal(valueOf(before.body, "updated"), before.body.match(/updated: (\S+)/)[1]);
  const set = await write({ path, content: before.body.replace(/updated: \S+/, "updated: 2025-12-31"), expected_etag: before.etag });
  assert.equal(set.isError, false, set.text);
  assert.equal(valueOf((await read(path)).body, "updated"), "2025-12-31");
});

test("a note without the keys is written exactly as sent", async () => {
  const path = "projects/no-dates.md";
  const content = "---\ntitle: No dates\nstatus: open\n---\n\nJust text.\n";
  await write({ path, content });
  assert.equal((await read(path)).body, content);
});

test("the quiet stamp: a burst of saves is stamped after it, once", async () => {
  const path = "projects/typed.md";
  await write({ path, content: "---\ndate modified: 2026-01-01T00:00:00-06:00\n---\n\nStart\n" });
  let current = await appRead(path);
  assert.equal(typeof current.etag, "string", JSON.stringify(current));
  // The agent's write that made it was stamped in its own save.
  const made = valueOf(current.text, "date modified");
  assert.match(made, ISO_CHICAGO);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // Three saves a moment apart, as typing autosaves them.
  const saves = [];
  for (const word of ["one", "two", "three"]) {
    const saved = await appSave(path, current.etag, current.text.replace(/\n\n.*\n$/s, `\n\nStart ${word}\n`));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    saves.push(saved);
    current = saved.body;
  }
  await Promise.all(saves.map((saved) => saved.settle()));

  const stamped = await appRead(path);
  assert.match(valueOf(stamped.text, "date modified"), ISO_CHICAGO);
  assert.notEqual(valueOf(stamped.text, "date modified"), made);
  assert.ok(stamped.text.endsWith("Start three\n"), stamped.text);
  assert.notEqual(stamped.etag, current.etag, "the stamp is its own collaboration edit");

  // No loop: nothing more happens after the stamp's own quiet period.
  await new Promise((resolve) => setTimeout(resolve, DATE_QUIET_MS + 300));
  assert.equal((await appRead(path)).etag, stamped.etag);

});
