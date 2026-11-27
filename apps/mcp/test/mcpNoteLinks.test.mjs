/**
 * An MCP client's write and read answer with the note's app link (`notes/appLink.js`).
 *
 * Dev, 2026-11-27: an agent that had just created a note over MCP could not
 * give him a link to it. The link is the one Tex texts,
 * `<APP_ORIGIN>/note/@<slug>/<path>`, in the workspace the call reached.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `appLinks: true` dropped from `handlers.js` `invokeTool`
 *     → "a write answers with the note's app link" and "a fetch answers…" fail
 *   `noteLinkUrl` dropping the segment encoding
 *     → "a write answers with the note's app link" fails
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { withAppLink } from "../src/notes/appLink.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-note-links.test";
const TOKEN = `cat_notelinks_owner_${"0".repeat(20)}`;
const ORIGIN = "https://app.context.test";
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, APP_ORIGIN: ORIGIN };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLENL",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLENL",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function call(name, args, environment = env) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    environment,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

let restoreS3;
let restoreControlPlane;
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace("ws_links", "linker", binding("links-bucket"));
  s3.bucketFor("links-bucket").set("index.md", { body: "# Front page", etag: "i0" });
  {
    await controlPlane.addGrant({
      workspaceId: "ws_links",
      role: "owner",
      userId: "user_linker",
      accessToken: TOKEN,
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_links",
    });
  }
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("a write answers with the note's app link", async () => {
  const written = await call("write", { path: "projects/plan notes.md", content: "# Plan\n" });
  assert.equal(written.isError, false, written.text);
  assert.match(written.text, /^written: projects\/plan notes\.md/);
  assert.ok(written.text.includes(`\nlink: ${ORIGIN}/note/@linker/projects/plan%20notes.md (`), written.text);
});

test("a fetch answers with the note's app link after its path", async () => {
  const read = await call("fetch", { id: "projects/plan notes.md" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, new RegExp(`^etag: [^\\n]*\\npath: projects/plan notes\\.md\\nlink: ${ORIGIN.replace(/\./g, "\\.")}/note/@linker/projects/plan%20notes\\.md\\n`));
});

test("no APP_ORIGIN, no link: a guessed link opens nothing", async () => {
  const { APP_ORIGIN, ...bare } = env;
  const written = await call("write", { path: "projects/bare.md", content: "# Bare\n" }, bare);
  assert.equal(written.isError, false, written.text);
  assert.doesNotMatch(written.text, /\nlink: /);
});

test("a failed call, a mail read and another tool's answer pass through", () => {
  const ok = { content: [{ type: "text", text: "etag: e1\npath: a.md\nvisibility: private\n\n# A" }] };
  const opts = { origin: ORIGIN, slug: "linker" };
  assert.equal(withAppLink("read_note", { mail: true }, ok, opts), ok);
  assert.equal(withAppLink("search_notes", {}, ok, opts), ok);
  const failed = { isError: true, content: [{ type: "text", text: "written: a.md (etag x)" }] };
  assert.equal(withAppLink("write_note", {}, failed, opts), failed);
  assert.equal(withAppLink("write_note", {}, ok, { origin: ORIGIN, slug: null }), ok);
  const page = withAppLink("write_note", {}, { content: [{ type: "text", text: "written: site/home.page.md (etag x)" }] }, opts);
  assert.ok(page.content[0].text.includes(`link: ${ORIGIN}/p/@linker/site/home.page.md`));
});
