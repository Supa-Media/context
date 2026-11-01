/**
 * `orient` for a person who reaches several workspaces: the other workspaces'
 * front pages are fetched alongside this workspace's own survey, each capped
 * in time, and `@context-lc` is opened once per call however many sections
 * read from it.
 *
 * Why: the texting assistant gives a tool call 20 s (`agent/turn.js`), and
 * orient timed out in production for somebody in several workspaces. Each
 * other workspace costs a control-plane round trip (`/gateway/binding`) and
 * then bucket reads, and they used to start only after the own-workspace walk
 * had finished — with `@context-lc` opened a second time, after the global
 * note had already opened it once.
 *
 * The slowness here is injected on `/gateway/binding` for chosen workspaces,
 * which is exactly the step `storeForSession` spends per opened context.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { GLOBAL_ORIENT_PATH } from "../src/orient/globalNote.js";
import { ORIENT_OTHER_WORKSPACE_WAIT_MS } from "../src/orient/tool.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-orient-others.test";
const TOKEN = `cat_orient_others_${"0".repeat(22)}`;
const RULE = "Every agent: keep task statuses current.";
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };

const MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  guides: team\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

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

/** workspaceId -> what `/gateway/binding` waits on before answering for it. */
const holds = new Map();
/** workspaceId -> how many times `/gateway/binding` was asked for it. */
const opens = new Map();

async function orient() {
  const { ctx, settle } = createWorkerCtx();
  const started = Date.now();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orient", arguments: {} } }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  const ms = Date.now() - started;
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: Boolean(body?.result?.isError), ms };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let restore = [];
after(() => {
  for (const undo of restore.reverse()) undo();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());

  // Wrapped last, so it sees every call first: count and, when asked, hold
  // the binding lookup for one workspace.
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${CONTROL_PLANE_ORIGIN}/gateway/binding`) {
      const id = JSON.parse(init?.body || "{}").expectedWorkspaceId;
      if (id) opens.set(id, (opens.get(id) || 0) + 1);
      const hold = id ? holds.get(id) : null;
      if (hold) await hold();
    }
    return inner(input, init);
  };
  restore.push(() => {
    globalThis.fetch = inner;
  });

  // Each workspace's tree is copied from its bucket, so orient can draw its map.
  controlPlane.serveTreesFrom(undefined, { s3 });

  controlPlane.addWorkspace("ws_mine", "mine-many", binding("others-mine", "AA"));
  controlPlane.addWorkspace("ws_pinned", "context-lc", binding("others-pinned", "BB"), { kind: "shared" });
  controlPlane.addWorkspace("ws_alpha", "alpha-team", binding("others-alpha", "CC"), { kind: "shared" });
  controlPlane.addWorkspace("ws_beta", "beta-team", binding("others-beta", "DD"), { kind: "shared" });

  for (const [bucket, title] of [
    ["others-mine", "MINE-FRONT"],
    ["others-pinned", "PINNED-FRONT"],
    ["others-alpha", "ALPHA-FRONT"],
    ["others-beta", "BETA-FRONT"],
  ]) {
    s3.bucketFor(bucket).set("privacy.md", { body: MANIFEST, etag: "p0" });
    s3.bucketFor(bucket).set("index.md", { body: `# ${title}`, etag: "i0" });
    s3.bucketFor(bucket).set("1-projects/a.md", { body: "# a", etag: "a0" });
  }
  s3.bucketFor("others-pinned").set(GLOBAL_ORIENT_PATH, { body: `# For every agent\n\n- ${RULE}\n`, etag: "g0" });

  await controlPlane.addGrant({
    workspaceId: "ws_mine",
    role: "owner",
    userId: "user_many",
    accessToken: TOKEN,
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_orient_others",
    alsoMemberOf: [
      { workspaceId: "ws_pinned", role: "member" },
      { workspaceId: "ws_alpha", role: "member" },
      { workspaceId: "ws_beta", role: "member" },
    ],
  });
});

test("the normal case: every other workspace's front page, the global note, once each", async () => {
  holds.clear();
  opens.clear();
  const { text, isError } = await orient();
  assert.equal(isError, false);
  for (const marker of ["MINE-FRONT", "PINNED-FRONT", "ALPHA-FRONT", "BETA-FRONT", RULE]) {
    assert.ok(text.includes(marker), `orient carries ${marker}`);
  }
  assert.ok(!/map not loaded/i.test(text), "nothing was late");
  assert.ok(text.includes("## Workspaces"));
  // The global note and the pinned workspace's own front page share one open.
  assert.equal(opens.get("ws_pinned"), 1, "@context-lc is opened once per orient");
  assert.equal(opens.get("ws_alpha"), 1);
  assert.equal(opens.get("ws_beta"), 1);
});

test("other workspaces open alongside the own-workspace work, not after it", async () => {
  // The pinned workspace is opened by the global note (inside the first
  // round) and by the other-workspaces step. Holding it and @alpha for one
  // delay each costs one delay when they run together, two when the
  // other-workspaces step waits for the first round to finish.
  const DELAY = 700;
  holds.clear();
  opens.clear();
  holds.set("ws_pinned", () => sleep(DELAY));
  holds.set("ws_alpha", () => sleep(DELAY));
  const { text, ms } = await orient();
  assert.ok(text.includes("ALPHA-FRONT") && text.includes("PINNED-FRONT") && text.includes(RULE));
  assert.ok(ms >= DELAY, `took ${ms} ms, at least one delay`);
  assert.ok(ms < DELAY * 1.6, `took ${ms} ms: one delay of ${DELAY}, not two`);
  holds.clear();
});

test("a workspace slower than the cap is named with a way in, and the call still succeeds", async () => {
  holds.clear();
  opens.clear();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  holds.set("ws_beta", () => gate);
  try {
    const { text, isError, ms } = await orient();
    assert.equal(isError, false);
    assert.ok(text.includes("# Context"));
    assert.ok(text.includes("ALPHA-FRONT"), "the prompt ones are still read");
    assert.ok(!text.includes("BETA-FRONT"), "the late one is not waited for");
    assert.match(text, /### @beta-team — [^\n]+\nMap not loaded in time\. Call orient with context: "@beta-team" to see it\./);
    assert.ok(ms >= ORIENT_OTHER_WORKSPACE_WAIT_MS, `took ${ms} ms`);
    assert.ok(ms < ORIENT_OTHER_WORKSPACE_WAIT_MS + 1500, `took ${ms} ms, capped`);
  } finally {
    holds.clear();
    release();
    // Let the abandoned open finish against the stubs before they are removed.
    await sleep(50);
  }
});
