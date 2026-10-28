/**
 * A NOTE HAS ONE VERSION TAG, AND EVERY TOOL ACCEPTS IT (`src/notes/version.js`).
 *
 * Reported 2026-10-28 by an agent changing a note's visibility: `write_note`
 * and `read_note` handed out the stored Markdown's etag, and `set_visibility`
 * compared what it was given with the collaboration document's, which it
 * started on the spot. The etag the agent had just been given was refused as
 * changed, so it read the note again and retried. The same split sat under
 * the moves, `archive_note` and `set_encryption`.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-28).
 *
 *  1. `set_visibility` comparing with `readDocument(...).etag` again.
 *     → "the etag a write hands out changes the note's visibility" fails.
 *  2. `isCurrentEtag` accepting only the document's own etag.
 *     → "a move accepts the etag a read handed out…" fails.
 *  3. `versionMatches` accepting any etag the note has ever had.
 *     → "once the note changes, the old tag is a conflict everywhere" fails.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-one-version.test";
const AGENT = `cat_one_version_agent_${"0".repeat(18)}`;
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
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
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
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace("ws_site", "site", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "one-version-site",
    accessKeyId: "AKIAEXAMPLEEXAMPLEOV",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEOV",
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


const PLAN = "projects/plan.md";
const MOVED = "projects/plans/plan.md";

test("the etag a write hands out changes the note's visibility", async () => {
  const created = await write({ path: PLAN, content: "# Plan\n\nShip it.\n" });
  assert.equal(created.isError, false, created.text);
  const changed = await call(AGENT, "set_visibility", {
    path: PLAN,
    visibility: "team",
    confirm_team_publish: true,
    expected_etag: etagOf(created.text),
  });
  assert.equal(changed.isError, false, changed.text);
  assert.match(changed.text, /^visibility changed: projects\/plan\.md/);
  // And the etag the answer names is the one a read hands out next.
  assert.equal(etagOf(changed.text.split("\n").at(-1)), (await read(PLAN)).etag);
});

test("once the note changes, the old tag is a conflict everywhere", async () => {
  const before = await read(PLAN);
  const edited = await write({ path: PLAN, content: "# Plan\n\nShip it today.\n", expected_etag: before.etag });
  assert.equal(edited.isError, false, edited.text);
  const now = etagOf(edited.text);
  assert.notEqual(now, before.etag);
  const stale = await call(AGENT, "set_visibility", { path: PLAN, visibility: "private", expected_etag: before.etag });
  assert.equal(stale.isError, true, stale.text);
  assert.match(stale.text, new RegExp(`^conflict: note changed since you read it \\(current etag ${now.replace(/\./g, "\\.")}\\)`));
  const staleMove = await call(AGENT, "move_note", { source: PLAN, destination: MOVED, expected_source_etag: before.etag });
  assert.equal(staleMove.isError, true, staleMove.text);
  assert.match(staleMove.text, /conflict/);
  const current = await call(AGENT, "set_visibility", { path: PLAN, visibility: "private", expected_etag: now });
  assert.equal(current.isError, false, current.text);
  assert.equal((await read(PLAN)).etag, now, "a visibility change is not a new version of the text");
});

test("a move accepts the etag a read handed out, before and after it moved", async () => {
  const fresh = "projects/fresh.md";
  const created = await write({ path: fresh, content: "# Fresh\n\nNothing edited it together.\n" });
  assert.equal(created.isError, false, created.text);
  const read1 = await read(fresh);
  assert.equal(read1.etag, etagOf(created.text));
  const moved = await call(AGENT, "move_note", { source: fresh, destination: "projects/fresh-moved.md", expected_source_etag: read1.etag });
  assert.equal(moved.isError, false, moved.text);
  const read2 = await read("projects/fresh-moved.md");
  const back = await call(AGENT, "move_note", { source: "projects/fresh-moved.md", destination: fresh, expected_source_etag: read2.etag });
  assert.equal(back.isError, false, back.text);
});
