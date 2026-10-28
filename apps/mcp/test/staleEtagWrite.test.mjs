/**
 * A whole-note write whose `expected_etag` is no longer the note's version is
 * refused, never merged.
 *
 * Reported 2026-10-28 on a website note: the owner saved an edit at 01:39:06,
 * and at 01:44:51 an agent wrote the whole note with an etag it had read
 * before that. The live-editing engine merged the agent's text over the
 * version it had read, the lines both had changed came out as the agent wrote
 * them, and the write said it had succeeded. `expected_etag` promises a
 * conflict there; the conflict carries the current text and etag to merge
 * into.
 *
 * ## Sabotage record
 *
 * Dropping `onlyCurrent: true` from `write_note`'s replacement failed "an
 * agent's write from before the owner's edit is a conflict".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-stale-etag.test";
const AGENT = `cat_stale_etag_agent_${"0".repeat(19)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
const PATH = "website/notes/beneath-the-chaos.md";
const FRONT = "---\ntitle: beneath the chaos\ndate: 2026-01-05\n---\n\n";
const POEM = `${FRONT}beneath the chaos\nthere is a quiet\nthat waits for me\n`;
const OWNER_EDIT = `${FRONT}beneath the chaos\nthere is a quiet place\nthat waits for me, still\n`;
const AGENT_EDIT = `${FRONT}below the noise\nthere is a quiet\nthat holds me\n`;

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
const read = async () => {
  const answer = await call(AGENT, "read_note", { path: PATH });
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
    bucket: "stale-etag-site",
    accessKeyId: "AKIAEXAMPLEEXAMPLEST",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEST",
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

test("an agent's write from before the owner's edit is a conflict, and the owner's edit stays", async () => {
  const created = await write({ path: PATH, content: POEM });
  assert.equal(created.isError, false, created.text);
  const agentRead = await read();
  // Nothing has edited it together yet, so a read hands out the Markdown's etag, and the
  // owner's save below starts its document from that version (`notes/version.js`).
  assert.equal(agentRead.etag, etagOf(created.text));

  // The owner's save lands after the agent read the note.
  const owner = await write({ path: PATH, content: OWNER_EDIT, expected_etag: agentRead.etag });
  assert.equal(owner.isError, false, owner.text);
  const ownerEtag = etagOf(owner.text);
  assert.notEqual(ownerEtag, agentRead.etag);

  const stale = await write({ path: PATH, content: AGENT_EDIT, expected_etag: agentRead.etag });
  assert.equal(stale.isError, true, `a stale write was accepted: ${stale.text}`);
  assert.match(stale.text, /^conflict: note changed since you read it/);
  assert.ok(stale.text.includes(`current etag ${ownerEtag}`), stale.text);
  assert.ok(stale.text.includes("there is a quiet place"), "the conflict carries the text to merge into");

  const after = await read();
  assert.equal(after.etag, ownerEtag);
  assert.ok(after.body.includes("there is a quiet place\nthat waits for me, still"), after.body);
});

test("the same write against the current version lands, with a new etag", async () => {
  const current = await read();
  const written = await write({ path: PATH, content: AGENT_EDIT, expected_etag: current.etag });
  assert.equal(written.isError, false, written.text);
  assert.notEqual(etagOf(written.text), current.etag);
  assert.ok((await read()).body.includes("below the noise"));
});
