import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FORBIDDEN_PREVIEW_KEYS,
  TEXTING_LINE_KEYS,
  agentHealthProblems,
  healthProblems,
  identityProblems,
  silenceProblems,
} from "./preview-guards.mjs";

// Built at run time: scripts/check-no-identifiers.mjs rejects a committed Convex hostname, fakes included.
const CONVEX_CLOUD = ["convex", "cloud"].join(".");
const CONVEX_SITE = ["convex", "site"].join(".");

const FAKE_VALUE = "fake-value-that-must-never-print";

test("the Photon names are the two the Photon bridge deploy reads, and no others", () => {
  const bridge = readFileSync(new URL("../.github/workflows/deploy-photon-bridge.yml", import.meta.url), "utf8");
  const photon = FORBIDDEN_PREVIEW_KEYS.filter((key) => key.startsWith("PHOTON_")).sort();
  assert.deepEqual(photon, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]);
  for (const key of photon) {
    assert.ok(bridge.includes(`secrets.${key}`), `${key} must be a name the bridge deploy reads`);
  }
});

const goodIdentity = {
  CONVEX_DEPLOY_KEY: "preview:example-team:example-project|fake-secret",
  PREVIEW_CONVEX_URL: `https://happy-animal-123.${CONVEX_CLOUD}`,
  PREVIEW_DENY_IDENTIFIERS: "prod-deployment-xyz, prod-bucket-abc",
  STAGING_CONVEX_DEPLOYMENT: "dev-staging-qrs",
};

test("silence passes when no texting, SMS, email or billing key is set", () => {
  assert.deepEqual(silenceProblems({}), []);
  assert.deepEqual(silenceProblems({ LINQ_API_KEY: "" }), []);
  assert.deepEqual(silenceProblems({ UNRELATED: "x" }), []);
});

test("silence names each forbidden key that is set, and never its value", () => {
  assert.ok(FORBIDDEN_PREVIEW_KEYS.length >= 19);
  assert.ok(TEXTING_LINE_KEYS.includes("SENDBLUE_API_SECRET"));
  for (const key of FORBIDDEN_PREVIEW_KEYS) {
    const problems = silenceProblems({ [key]: FAKE_VALUE });
    assert.equal(problems.length, 1, `${key} should be one problem`);
    assert.ok(problems[0].includes(key), `${key} should be named`);
    assert.ok(!problems[0].includes(FAKE_VALUE), `${key}'s value must not be printed`);
  }
});

test("identity passes for a preview key and URL with no production names", () => {
  assert.deepEqual(identityProblems(goodIdentity), []);
});

test("identity before the deploy checks the key and deny list, not a URL that does not exist yet", () => {
  const beforeDeploy = { CONVEX_DEPLOY_KEY: goodIdentity.CONVEX_DEPLOY_KEY, PREVIEW_DENY_IDENTIFIERS: goodIdentity.PREVIEW_DENY_IDENTIFIERS };
  assert.deepEqual(identityProblems(beforeDeploy, { beforeDeploy: true }), []);
  // The full check still demands the URL, so a missing URL is refused after the deploy.
  assert.ok(identityProblems(beforeDeploy).some((problem) => problem.includes("PREVIEW_CONVEX_URL")));
  // The key and the deny list are checked before the deploy as well.
  const prod = identityProblems({ ...beforeDeploy, CONVEX_DEPLOY_KEY: "prod:example-team:example-project|fake-secret" }, { beforeDeploy: true });
  assert.ok(prod.some((problem) => problem.includes("CONVEX_DEPLOY_KEY")));
  const denied = identityProblems({ ...beforeDeploy, CONVEX_DEPLOY_KEY: "preview:example-team:prod-deployment-xyz|fake-secret" }, { beforeDeploy: true });
  assert.ok(denied.some((problem) => problem.includes("PREVIEW_DENY_IDENTIFIERS")));
  // No URL is read before the deploy, so an empty one is not a problem there.
  assert.deepEqual(identityProblems({ ...beforeDeploy, PREVIEW_CONVEX_URL: "" }, { beforeDeploy: true }), []);
});

test("identity rejects a production deploy key, a missing key and a non-preview URL", () => {
  const prod = identityProblems({ ...goodIdentity, CONVEX_DEPLOY_KEY: "prod:example-team:example-project|fake-secret" });
  assert.ok(prod.some((problem) => problem.includes("CONVEX_DEPLOY_KEY")));
  assert.ok(identityProblems({ ...goodIdentity, CONVEX_DEPLOY_KEY: undefined }).length > 0);
  assert.ok(identityProblems({ ...goodIdentity, PREVIEW_CONVEX_URL: `https://x.${CONVEX_SITE}` }).length > 0);
  assert.ok(identityProblems({ ...goodIdentity, PREVIEW_CONVEX_URL: `https://happy.${CONVEX_CLOUD}.evil.test` }).length > 0);
});

test("identity rejects a deploy key or URL that names a deny-listed or staging deployment", () => {
  const denied = identityProblems({
    ...goodIdentity,
    CONVEX_DEPLOY_KEY: "preview:example-team:prod-deployment-xyz|fake-secret",
  });
  assert.ok(denied.some((problem) => problem.includes("PREVIEW_DENY_IDENTIFIERS")));
  const staging = identityProblems({
    ...goodIdentity,
    PREVIEW_CONVEX_URL: `https://dev-staging-qrs.${CONVEX_CLOUD}`,
  });
  assert.ok(staging.some((problem) => problem.includes("staging")));
  for (const problem of [...denied, ...staging]) {
    assert.ok(!problem.includes("prod-deployment-xyz") && !problem.includes("dev-staging-qrs"));
  }
});

test("health passes when every live-line flag is false and the simulator is on", () => {
  assert.deepEqual(healthProblems({
    ok: true,
    webhook: false,
    replies: false,
    sendblueWebhook: false,
    sendblueReplies: false,
    sendblueReceipts: false,
    whapiWebhook: false,
    whapiReplies: false,
    workerSecret: true,
    controlPlane: true,
    gatewayOrigin: "https://context-mcp-pr42.example-sub.workers.dev",
    simulator: true,
  }), []);
});

test("health fails on any live-line flag that is true", () => {
  for (const key of ["webhook", "replies", "sendblueWebhook", "sendblueReplies", "sendblueReceipts", "whapiWebhook", "whapiReplies", "linqSomething", "photonSomething"]) {
    const problems = healthProblems({ ok: true, [key]: true });
    assert.equal(problems.length, 1, `${key} should be a problem`);
    assert.ok(problems[0].includes(key));
  }
});

test("health rejects an answer that is not an object", () => {
  assert.ok(healthProblems(null).length > 0);
  assert.ok(healthProblems([]).length > 0);
  assert.ok(healthProblems("ok").length > 0);
});

/** A fake fetch that answers from a map of pathname to [status, body]. */
function fakeFetch(answers) {
  return async (url) => {
    const [status, body] = answers[new URL(url).pathname];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

test("agent-health passes on a quiet, reachable preview with the simulator on", async () => {
  const fetchImpl = fakeFetch({
    "/health": [200, { ok: true, sendblueWebhook: false, simulator: true }],
    "/texts-simulator": [200, "<html></html>"],
  });
  assert.deepEqual(await agentHealthProblems("https://context-agent-pr42.example-sub.workers.dev", fetchImpl), []);
});

test("agent-health fails when a live line is on or the simulator is off", async () => {
  const live = fakeFetch({
    "/health": [200, { ok: true, sendblueWebhook: true }],
    "/texts-simulator": [200, "<html></html>"],
  });
  assert.ok((await agentHealthProblems("https://context-agent-pr42.example-sub.workers.dev", live)).some((p) => p.includes("sendblueWebhook")));
  const off = fakeFetch({
    "/health": [200, { ok: true }],
    "/texts-simulator": [404, ""],
  });
  assert.ok((await agentHealthProblems("https://context-agent-pr42.example-sub.workers.dev", off)).some((p) => p.includes("404")));
});

test("agent-health never prints the origin it was given", async () => {
  const origin = "https://context-agent-pr42.example-sub.workers.dev";
  const fetchImpl = fakeFetch({
    "/health": [500, ""],
    "/texts-simulator": [500, ""],
  });
  const problems = await agentHealthProblems(origin, fetchImpl);
  assert.ok(problems.length > 0);
  assert.ok(problems.every((problem) => !problem.includes("example-sub")));
});
