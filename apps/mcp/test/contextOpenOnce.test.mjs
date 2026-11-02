// Opening the other contexts one request reaches: each opened at most once,
// a named one opened beside the default, and the small helpers behind both
// (`onceEach`, `namedContextsOf`, `attachPinnedDoors`).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import worker from "../src/index.js";
import { attachContextOpener, onceEach, namedContextsOf } from "../src/http/contextOpener.js";
import { attachPinnedDoors } from "../src/http/pinnedDoors.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3 = "https://s3.example.test";
const MCP_URL = "https://mcp.context.test/mcp";
const TOKEN = `cat_once_calls_${"0".repeat(22)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };
const BINDING_PATH = "/gateway/binding";
// Every binding round trip takes this long, so overlapping opens are visible.
const BINDING_DELAY_MS = 40;
const N = 10;
const MANIFEST = "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const binding = (bucket, key) => ({ provider: "s3", endpoint: S3, region: "auto", bucket, accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`, secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`, forcePathStyle: true, capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" }, status: "active" });

// One record per /gateway/binding call made since the last reset.
const bindingCalls = [];

before(async () => {
  const s3 = createS3Backend(S3);
  s3.install();
  const cp = createControlPlaneStub();
  cp.install();
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== `${CONTROL_PLANE_ORIGIN}${BINDING_PATH}`) return inner(input, init);
    // The body is JSON text; it names the workspace the gateway expects back.
    const sent = JSON.parse(init?.body || "{}");
    bindingCalls.push({ start: Date.now(), expected: sent.expectedWorkspaceId ?? null });
    await new Promise((resolve) => setTimeout(resolve, BINDING_DELAY_MS));
    return inner(input, init);
  };
  cp.serveTreesFrom(undefined, { s3 });
  const alsoMemberOf = [];
  for (let i = 0; i < N; i++) {
    const id = i === 0 ? "ws_mine" : i === 1 ? "ws_pinned" : `ws_w${i}`;
    const slug = i === 0 ? "mine-many" : i === 1 ? "context-lc" : `team-w${i}`;
    cp.addWorkspace(id, slug, binding(`b-${i}`, String(i).padStart(2, "0")), i === 0 ? {} : { kind: "shared" });
    s3.bucketFor(`b-${i}`).set("privacy.md", { body: MANIFEST, etag: "p0" });
    s3.bucketFor(`b-${i}`).set("index.md", { body: `# front ${i}`, etag: "i0" });
    s3.bucketFor(`b-${i}`).set("1-projects/a.md", { body: `# a ${i}\n\nhello world`, etag: "a0" });
    if (i > 0) alsoMemberOf.push({ workspaceId: id, role: "member" });
  }
  await cp.addGrant({ workspaceId: "ws_mine", role: "owner", userId: "user_once", accessToken: TOKEN, scopes: ["context:read", "context:write"], clientId: "mcp_client_once", alsoMemberOf });
});

/** Send one JSON body to the gateway and return its parsed answer, after deferred work settles. */
async function postJson(payload) {
  bindingCalls.length = 0;
  const { ctx, settle } = createWorkerCtx();
  const request = new Request(MCP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await worker.fetch(request, env, ctx);
  const answer = JSON.parse(await response.text());
  await settle();
  return answer;
}

/** A `tools/call` message for the `fetch` tool. */
const fetchCall = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fetch", arguments: args } });

test("a batch naming the same workspace twice opens it once", async () => {
  const args = { id: "1-projects/a.md", context: "@team-w2" };
  const answer = await postJson([fetchCall(1, args), fetchCall(2, args)]);
  assert.ok(Array.isArray(answer), "a batch is answered with an array");
  assert.equal(answer.length, 2);
  for (const reply of answer) assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
  // One open for the default workspace and one for @team-w2, however many calls name it.
  assert.equal(bindingCalls.length, 2, JSON.stringify(bindingCalls));
  assert.equal(bindingCalls.filter((call) => call.expected === "ws_w2").length, 1);
});

test("a named workspace starts opening beside the default", async () => {
  const answer = await postJson(fetchCall(1, { id: "1-projects/a.md", context: "@team-w2" }));
  assert.notEqual(answer.result?.isError, true, JSON.stringify(answer));
  assert.equal(bindingCalls.length, 2, JSON.stringify(bindingCalls));
  assert.ok(bindingCalls.some((call) => call.expected === "ws_w2"), "one open is for @team-w2");
  // Compare the two opens by when they started. The later one must have
  // started before the earlier one would have finished, so they overlapped.
  const [earlier, later] = [...bindingCalls].sort((a, b) => a.start - b.start);
  assert.ok(later.start < earlier.start + BINDING_DELAY_MS, `opens did not overlap: ${later.start - earlier.start} ms apart`);
});

test("a name the person does not reach opens nothing extra", async () => {
  const answer = await postJson(fetchCall(1, { id: "1-projects/a.md", context: "@nobody-here" }));
  assert.equal(bindingCalls.length, 1, JSON.stringify(bindingCalls));
  assert.equal(answer.result?.isError, true);
  assert.match(answer.result.content[0].text, /no access to that context/);
});

test("onceEach forgets a failed open and holds a successful one", async () => {
  let runs = 0;
  // The first open fails; every later open succeeds.
  const openStore = async (target) => {
    runs += 1;
    if (runs === 1) throw new Error("open failed");
    return { workspaceId: target.workspaceId, run: runs };
  };
  const openOnce = onceEach(openStore);
  const target = { workspaceId: "w1" };

  await assert.rejects(openOnce(target), /open failed/);
  assert.equal(runs, 1);
  // The failure was forgotten, so this call opens again.
  await openOnce(target);
  assert.equal(runs, 2, "a failed open must not be remembered");

  // The successful open is held: asking for w1 again opens nothing.
  await openOnce(target);
  assert.equal(runs, 2, "a successful open is remembered");

  // Parallel calls on a fresh workspace share one open.
  const fresh = { workspaceId: "w3" };
  const [a, b] = [openOnce(fresh), openOnce(fresh)];
  assert.equal(a, b, "parallel calls get the same promise");
  await Promise.all([a, b]);
  assert.equal(runs, 3, "parallel calls open once");

  // A different workspace is opened separately.
  await openOnce({ workspaceId: "w2" });
  assert.equal(runs, 4);
});

test("namedContextsOf reads the three naming arguments and nothing else", async () => {
  const url = "https://mcp.context.test/mcp";
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "write", arguments: { context: "@a", source_context: "@b", destination_context: "@c", path: "x.md" } },
  };
  const text = JSON.stringify(message);
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
  assert.deepEqual(await namedContextsOf(request), ["@a", "@b", "@c"]);
  // The original body is still there for the transport to read.
  assert.equal(await request.text(), text);

  assert.deepEqual(await namedContextsOf(new Request(url, { method: "GET" })), []);
  const broken = new Request(url, { method: "POST", body: "{not json" });
  assert.deepEqual(await namedContextsOf(broken), []);
  // A body over 256 KB is not peeked at.
  const huge = JSON.stringify({ ...message, params: { name: "write", arguments: { context: "@a", pad: "x".repeat(260 * 1024) } } });
  assert.deepEqual(await namedContextsOf(new Request(url, { method: "POST", body: huge })), []);
});

test("attachPinnedDoors opens each door once, and only when the grant carries it", async () => {
  // A grant whose setup reach is a group chat's pinned context, with the
  // chat-reads grant and a home, so both doors exist.
  const session = {
    workspaceId: "ws_mine",
    grantScopes: ["context:read", "context:write"],
    workspaces: [],
    setupReach: { workspaceId: "ws_pinned", slug: "context-lc", kind: "shared", role: "owner", grantedNames: ["#reads-as-chat"], chatHome: "tex/groups/example.md" },
  };
  const opened = [];
  const openStore = async (doorSession) => {
    opened.push(doorSession.workspaceId);
    return { tag: doorSession.workspaceId };
  };
  const store = {};
  attachPinnedDoors(store, session, openStore);
  assert.equal(typeof store.openPinnedSetup, "function");
  assert.equal(typeof store.openChatHome, "function");

  const setup = await store.openPinnedSetup();
  await store.openPinnedSetup();
  assert.equal(setup.session.workspaceId, "ws_pinned");
  assert.equal(setup.store.tag, "ws_pinned");
  await store.openChatHome();
  await store.openChatHome();
  // Two doors, each opened once: two opens in total.
  assert.deepEqual(opened, ["ws_pinned", "ws_pinned"]);

  // Without a setup reach, neither door is attached.
  const bare = {};
  attachPinnedDoors(bare, { ...session, setupReach: null }, openStore);
  assert.equal(bare.openPinnedSetup, undefined);
  assert.equal(bare.openChatHome, undefined);
});

test("a held store reads the turn's search settings and held passes as they are now", async () => {
  // The store is held for the whole request, so what a turn lays on its own
  // store after the first open must still reach the opened one.
  const session = {
    workspaceId: "ws_mine",
    grantScopes: ["context:read"],
    workspaces: [{ workspaceId: "ws_w2", slug: "team-w2", kind: "shared", role: "member" }],
  };
  Object.defineProperty(session, "accessToken", { value: "fake-token" });
  const controlPlane = { reportSearchIndexProgress: async () => {}, notifyFormSubmission: async () => {} };
  const store = { searchSettings: { before: true } };
  let opens = 0;
  const openOnce = onceEach(async () => {
    opens += 1;
    return {};
  });
  attachContextOpener(store, session, { env: {}, controlPlane, origin: "https://mcp.context.test", openOnce, pinnedName: "@context-lc" });
  const first = await store.openContext("@team-w2");
  store.searchSettings = { after: true };
  const hold = () => {};
  store.holdSearchPass = hold;
  const again = await store.openContext("@team-w2");
  assert.equal(again.store, first.store, "the same store, held");
  assert.equal(opens, 1);
  assert.deepEqual(first.store.searchSettings, { after: true });
  assert.equal(first.store.holdSearchPass, hold);
  delete store.holdSearchPass;
  assert.equal(first.store.holdSearchPass, undefined);
});
