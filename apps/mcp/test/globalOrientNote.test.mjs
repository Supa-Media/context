/**
 * The Context.LC-wide note every `orient` carries: `guides/agents.md` in the
 * pinned `@context-lc` workspace, shown first, capped at fifty lines.
 *
 * It is read *through the caller's own reach* into that workspace — the
 * same `openContext` hop `orient` already makes for sibling front pages —
 * so it is only ever what the caller could read there with `read_note`. Who
 * may change it is who may write `@context-lc` (staff); nothing here grants
 * anyone a write.
 *
 * A fixture of its own, in its own file, because the orientation suite is
 * split across files already at their size allowance.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { GLOBAL_ORIENT_LINE_CAP, GLOBAL_ORIENT_PATH, PINNED_CONTEXT_NAME } from "../src/orient/globalNote.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-global-orient.test";
const TOKEN_READER = `cat_global_reader_${"0".repeat(22)}`;
const TOKEN_LONELY = `cat_global_lonely_${"0".repeat(22)}`;
const TOKEN_STAFF = `cat_global_staff__${"0".repeat(22)}`;
const TOKEN_HIDDEN = `cat_global_hidden_${"0".repeat(22)}`;

function manifest(extra = "") {
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n  index.md: team\n  guides: team\n  1-projects: team\n\nnote_overrides:\n${extra || "  # none\n"}` +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function call(token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result?.content?.[0]?.text || "";
}

const orient = (token, args) => call(token, "orient", args);

const RULE = "Update a task's status the moment it changes, not at the end.";
let pinnedBucket;

let restoreS3;
let restoreControlPlane;
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_mine", "mine", binding("global-mine", "AA"));
  controlPlane.addWorkspace("ws_pinned", "context-lc", binding("global-pinned", "BB"), { kind: "shared" });
  controlPlane.addWorkspace("ws_other", "other-team", binding("global-other", "CC"), { kind: "shared" });

  for (const bucket of ["global-mine", "global-pinned", "global-other"]) {
    s3.bucketFor(bucket).set("privacy.md", { body: manifest(), etag: "p0" });
    s3.bucketFor(bucket).set("index.md", { body: `# Front page of ${bucket}`, etag: "i0" });
  }
  pinnedBucket = s3.bucketFor("global-pinned");
  pinnedBucket.set(GLOBAL_ORIENT_PATH, {
    body: `---\nupdated: 2026-09-29\n---\n\n# For every agent\n\n- ${RULE}\n`,
    etag: "g0",
  });
  // The note exists, but privacy.md holds it back from team: a member must
  // not be handed it through orient when read_note would refuse it.
  s3.bucketFor("global-other").set(GLOBAL_ORIENT_PATH, { body: "not the pinned context", etag: "o0" });

  // Somebody who reaches @context-lc only as a member (the pin).
  await controlPlane.addGrant({
    workspaceId: "ws_mine",
    role: "owner",
    userId: "user_reader",
    accessToken: TOKEN_READER,
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_global_reader",
    alsoMemberOf: [
      { workspaceId: "ws_other", role: "member" },
      { workspaceId: "ws_pinned", role: "member" },
    ],
  });
  // A self-hosted deployment: no pinned context at all.
  await controlPlane.addGrant({
    workspaceId: "ws_mine",
    role: "owner",
    userId: "user_lonely",
    accessToken: TOKEN_LONELY,
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_global_lonely",
  });
  // Staff, connected to @context-lc itself.
  await controlPlane.addGrant({
    workspaceId: "ws_pinned",
    role: "owner",
    userId: "user_staff",
    accessToken: TOKEN_STAFF,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_global_staff",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_mine",
    role: "owner",
    userId: "user_hidden",
    accessToken: TOKEN_HIDDEN,
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_global_hidden",
    alsoMemberOf: [{ workspaceId: "ws_pinned", role: "member" }],
  });
});

test("the gateway's pinned name is the control plane's pinned slug", () => {
  const shared = readFileSync(new URL("../../../packages/shared/src/pinnedContext.ts", import.meta.url), "utf8");
  const slug = /PINNED_CONTEXT_SLUG\s*=\s*"([^"]+)"/.exec(shared)?.[1];
  assert.equal(PINNED_CONTEXT_NAME, `@${slug}`);
});

test("orient carries the global note first, for a member who reaches it through the pin", async () => {
  const text = await orient(TOKEN_READER);
  assert.ok(text.includes(RULE), "the rule is in orient");
  const global = text.indexOf(RULE);
  assert.ok(global < text.indexOf("## Front page"), "before the person's own front page");
  assert.ok(!text.includes("updated: 2026-09-29"), "frontmatter is not shown");
});

test("...and in an orient addressed to another context, too", async () => {
  const text = await orient(TOKEN_READER, { context: "@other-team" });
  assert.ok(text.includes("Front page of global-other"), "it is the other context's orient");
  assert.ok(text.includes(RULE));
  assert.ok(!text.includes("not the pinned context"), "only the pinned context's note is global");
});

test("...and for staff orienting the pinned context itself", async () => {
  assert.ok((await orient(TOKEN_STAFF)).includes(RULE));
});

test("a deployment with no pinned context gets no section and no error", async () => {
  const text = await orient(TOKEN_LONELY);
  assert.ok(!text.includes(RULE));
  assert.ok(!/## .*every workspace/i.test(text));
  assert.ok(text.includes("# Orientation"));
});

test("it is capped at the line limit and says where the rest is", async () => {
  const lines = Array.from({ length: GLOBAL_ORIENT_LINE_CAP + 25 }, (_, n) => `- line ${n + 1}`);
  pinnedBucket.set(GLOBAL_ORIENT_PATH, { body: lines.join("\n"), etag: "g1" });
  try {
    const text = await orient(TOKEN_READER);
    assert.ok(text.includes(`- line ${GLOBAL_ORIENT_LINE_CAP}\n`));
    assert.ok(!text.includes(`- line ${GLOBAL_ORIENT_LINE_CAP + 1}\n`));
    assert.match(text, /truncated/);
    assert.ok(text.includes(GLOBAL_ORIENT_PATH));
  } finally {
    pinnedBucket.set(GLOBAL_ORIENT_PATH, { body: `# For every agent\n\n- ${RULE}\n`, etag: "g2" });
  }
});

test("a note privacy.md holds back from members is not handed to them", async () => {
  pinnedBucket.set("privacy.md", { body: manifest(`  ${GLOBAL_ORIENT_PATH}: private\n`), etag: "p1" });
  try {
    assert.ok(!(await orient(TOKEN_HIDDEN)).includes(RULE));
    // Its owner still sees it: the rule is the privacy engine's, not ours.
    assert.ok((await orient(TOKEN_STAFF)).includes(RULE));
  } finally {
    pinnedBucket.set("privacy.md", { body: manifest(), etag: "p2" });
  }
});

test("an unreachable pinned bucket never fails orient", async () => {
  const saved = pinnedBucket.get("privacy.md");
  pinnedBucket.delete("privacy.md");
  try {
    const text = await orient(TOKEN_READER);
    assert.ok(text.includes("# Orientation"));
  } finally {
    pinnedBucket.set("privacy.md", saved);
  }
});

test("a member of the pinned context still cannot write the global note", async () => {
  const result = await call(TOKEN_READER, "write_note", {
    context: PINNED_CONTEXT_NAME,
    path: GLOBAL_ORIENT_PATH,
    content: "# hijacked",
  });
  assert.match(result, /denied|not allowed|cannot|read-only|permission/i);
  assert.ok(!pinnedBucket.get(GLOBAL_ORIENT_PATH).body.includes("hijacked"));
});
