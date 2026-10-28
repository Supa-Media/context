/**
 * EVERY CHANGE ENDS WITH ITS OUTCOME (`src/mcp/outcome.js`).
 *
 * The owner, 2026-10-28: "Every mutation should report whether it applied,
 * the resulting visibility and revision, and a specific error code." An MCP
 * client's answer to a tool that writes ends with an `outcome: {json}` text
 * block; a read has none.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-28).
 *
 *  1. `withOutcome` dropped from `handleRpc`'s `tools/call`.
 *     → "a write says it applied, with its path, visibility and etag" fails.
 *  2. The CONFLICT row removed from `ERROR_CODES`.
 *     → "a stale change says it did not apply, and why" fails.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { outcomeOf } from "../src/mcp/outcome.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-outcome.test";
const AGENT = `cat_outcome_agent_${"0".repeat(22)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

async function call(token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  const content = body?.result?.content ?? [];
  const last = content.at(-1)?.text ?? "";
  return {
    text: content[0]?.text || "",
    isError: body?.result?.isError === true,
    outcome: content.length > 1 && last.startsWith("outcome: ") ? JSON.parse(last.slice("outcome: ".length)) : null,
  };
}

const etagOf = (text) => /etag[: ]+(c2\.[A-Za-z0-9.-]+|[^\s)]+)/.exec(text)?.[1];
const write = (args) => call(AGENT, "write_note", args);
const read = async (path) => {
  const answer = await call(AGENT, "read_note", { path });
  assert.equal(answer.isError, false, answer.text);
  return { etag: etagOf(answer.text), body: answer.text.split("\n\n").slice(1).join("\n\n") };
};

let restore = [];

before(async () => {
  // Every write stamped with the real time, so an orient mark falls between two of them.
  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace("ws_site", "site", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "outcome-site",
    accessKeyId: "AKIAEXAMPLEEXAMPLEOC",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEOC",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_site",
    userId: "user_owner",
    accessToken: AGENT,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_agent",
  });
});

after(() => {
  for (const undo of restore.reverse()) undo?.();
});



test("a write says it applied, with its path, visibility and etag", async () => {
  const written = await write({ path: "projects/outcome.md", content: "# Outcome\n\nSaid plainly.\n" });
  assert.equal(written.isError, false, written.text);
  assert.deepEqual(written.outcome, {
    applied: true,
    path: "projects/outcome.md",
    visibility: "private",
    etag: etagOf(written.text),
  });
});

test("a visibility change says the visibility it left, and the version it is at", async () => {
  const { etag } = await read("projects/outcome.md");
  const changed = await call(AGENT, "set_visibility", {
    path: "projects/outcome.md",
    visibility: "team",
    confirm_team_publish: true,
    expected_etag: etag,
  });
  assert.equal(changed.isError, false, changed.text);
  assert.deepEqual(changed.outcome, { applied: true, path: "projects/outcome.md", visibility: "team", etag });
  const again = await call(AGENT, "set_visibility", { path: "projects/outcome.md", visibility: "team", expected_etag: etag });
  assert.deepEqual(again.outcome, { applied: true, unchanged: true, path: "projects/outcome.md", visibility: "team", etag });
});

test("a stale change says it did not apply, and why", async () => {
  const before = await read("projects/outcome.md");
  await write({ path: "projects/outcome.md", content: "# Outcome\n\nSaid again.\n", expected_etag: before.etag });
  const stale = await call(AGENT, "set_visibility", { path: "projects/outcome.md", visibility: "private", expected_etag: before.etag });
  assert.equal(stale.isError, true);
  assert.deepEqual(stale.outcome, { applied: false, error: "CONFLICT" });
  const missing = await call(AGENT, "set_visibility", { path: "projects/nowhere.md", visibility: "private" });
  assert.deepEqual(missing.outcome, { applied: false, error: "NOT_FOUND" });
  const invalid = await write({ path: "projects/no-extension", content: "x" });
  assert.deepEqual(invalid.outcome, { applied: false, error: "INVALID_ARGUMENT" });
});

test("a read carries no outcome", async () => {
  const answer = await call(AGENT, "read_note", { path: "projects/outcome.md" });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(answer.outcome, null);
  const v2 = await call(AGENT, "fetch", { id: "projects/outcome.md" });
  assert.equal(v2.outcome, null);
});

test("a call held for the person, or refused by the judge, needs the person", () => {
  const error = (text, extra = {}) => ({ content: [{ type: "text", text }], isError: true, ...extra });
  assert.deepEqual(outcomeOf("write", error("Not done: this would make a.md visible to the team, and …")), { applied: false, error: "NEEDS_PERSON" });
  assert.deepEqual(outcomeOf("send", error("anything", { held: true })), { applied: false, error: "NEEDS_PERSON" });
  assert.equal(outcomeOf("search", error("not found")), null);
});

test("a remembered fact says where it went and the version it left", async () => {
  const remembered = await call(AGENT, "remember", { fact: "Ships on Fridays", kind: "stated", note: "projects/outcome.md" });
  assert.equal(remembered.isError, false, remembered.text);
  assert.equal(remembered.outcome.applied, true);
  assert.equal(remembered.outcome.path, "projects/outcome.md");
  assert.equal(remembered.outcome.etag, (await read("projects/outcome.md")).etag);
});

/*
 * `orient { since }` (the owner, 2026-10-28: "compact, incremental orient
 * responses"). Sabotage: `sinceAnswer` returning the overview fails "an orient
 * since a mark names only what changed".
 */
test("an orient since a mark names only what changed, and ends with a new mark", async () => {
  const first = await call(AGENT, "orient", {});
  const mark = /^orient_mark: (\S+)$/m.exec(first.text)?.[1];
  assert.ok(mark, "the overview ends with a mark");
  assert.equal(first.outcome, null, "orient changes nothing");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await write({ path: "projects/after-mark.md", content: "# After the mark\n" });
  const since = await call(AGENT, "orient", { since: mark });
  assert.equal(since.isError, false, since.text);
  assert.match(since.text, /projects\/after-mark\.md/);
  assert.doesNotMatch(since.text, /projects\/outcome\.md/, "a note from before the mark is not news");
  assert.doesNotMatch(since.text, /## How to work here|## Workspaces/, "what the caller already holds is not said again");
  assert.ok(since.text.length < first.text.length / 2, `${since.text.length} vs ${first.text.length}`);
  const next = /^orient_mark: (\S+)$/m.exec(since.text)?.[1];
  assert.ok(next && next > mark);
  const quiet = await call(AGENT, "orient", { since: next });
  assert.match(quiet.text, /Nothing in this workspace changed since then/);
  const bad = await call(AGENT, "orient", { since: "yesterday-ish" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^invalid: since/);
});
