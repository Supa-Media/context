import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  FORBIDDEN_PREVIEW_KEYS,
  PREVIEW_WORKER_SECRET_NAMES,
  TEXTING_LINE_KEYS,
  agentHealthProblems,
  healthProblems,
  identityProblems,
  silenceProblems,
  workerSecretListProblems,
  workflowSilenceProblems,
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

const SCRIPT = new URL("./preview-guards.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;

test("the real deploy-preview workflow passes the static silence check", () => {
  const text = readFileSync(new URL("../.github/workflows/deploy-preview.yml", import.meta.url), "utf8");
  assert.deepEqual(workflowSilenceProblems(text), []);
});

test("a workflow that maps any forbidden key into an environment fails and names it", () => {
  const base = readFileSync(new URL("../.github/workflows/deploy-preview.yml", import.meta.url), "utf8");
  for (const key of FORBIDDEN_PREVIEW_KEYS) {
    const text = `${base}\n          ${key}: \${{ secrets.${key} }}\n`;
    const problems = workflowSilenceProblems(text);
    assert.ok(problems.length > 0, `${key} should fail`);
    assert.ok(problems.some((problem) => problem.includes(key)), `${key} should be named`);
    assert.ok(problems.every((problem) => !problem.includes(FAKE_VALUE)));
  }
});

test("a forbidden key that appears only in a comment line passes", () => {
  const base = readFileSync(new URL("../.github/workflows/deploy-preview.yml", import.meta.url), "utf8");
  const text = `${base}\n      # RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}\n`;
  assert.deepEqual(workflowSilenceProblems(text), []);
});

test("a forbidden name in a wrangler secret put or convex env set fails; an allowed one passes", () => {
  assert.ok(workflowSilenceProblems("run: wrangler secret put RESEND_API_KEY --env preview\n").some((p) => p.includes("RESEND_API_KEY")));
  assert.deepEqual(workflowSilenceProblems("run: wrangler secret put CONVEX_ORIGIN --env preview\n"), []);
  assert.ok(workflowSilenceProblems("run: convex env set TWILIO_ACCOUNT_SID x\n").some((p) => p.includes("TWILIO_ACCOUNT_SID")));
});

test("a worker-secrets argument outside the allowlist fails, and an allowed one passes", () => {
  const bad = workflowSilenceProblems(
    "node scripts/worker-secrets.mjs GATEWAY_SECRET '?TWILIO_API_KEY_SECRET' | wrangler secret bulk --env preview\n",
  );
  assert.equal(bad.length, 1);
  assert.ok(bad[0].includes("TWILIO_API_KEY_SECRET"));
  assert.deepEqual(
    workflowSilenceProblems("node scripts/worker-secrets.mjs CONTROL_PLANE_URL=PREVIEW_CONTROL_PLANE_URL '!AGENT_WORKER_SECRET' | wrangler secret bulk --env preview\n"),
    [],
  );
});

test("a worker-secrets line with a line-continuation backslash is read without the backslash", () => {
  assert.deepEqual(
    workflowSilenceProblems("node scripts/worker-secrets.mjs GATEWAY_SECRET \\\n  | wrangler secret bulk --env preview\n"),
    [],
  );
});

test("a wrangler secret bulk line without a worker-secrets line fails", () => {
  assert.ok(workflowSilenceProblems("run: wrangler secret bulk --env preview\n").length > 0);
});

const ENV_AND_NAME = "--env and --name";

test("a wrangler secret bulk with both --env and --name fails; without --env it passes", () => {
  const withEnv = workflowSilenceProblems(
    "node scripts/worker-secrets.mjs GATEWAY_SECRET \\\n  | wrangler secret bulk --config w.toml --env preview --name \"context-mcp-pr$PR\"\n",
  );
  assert.equal(withEnv.length, 1);
  assert.ok(withEnv[0].includes(ENV_AND_NAME));
  assert.deepEqual(
    workflowSilenceProblems("node scripts/worker-secrets.mjs GATEWAY_SECRET \\\n  | wrangler secret bulk --config w.toml --name \"context-mcp-pr$PR\"\n"),
    [],
  );
});

test("a wrangler secret list with both --env and --name fails", () => {
  const problems = workflowSilenceProblems("run: wrangler secret list --format json --config w.toml --env preview --name x\n");
  assert.ok(problems.some((p) => p.includes(ENV_AND_NAME)));
});

test("--env and --name split over continuation lines are still caught", () => {
  const problems = workflowSilenceProblems("run: wrangler secret put CONVEX_ORIGIN --config w.toml \\\n  --env preview --name x\n");
  assert.ok(problems.some((p) => p.includes(ENV_AND_NAME)));
});

test("--env on a wrangler deploy with --name is not a secret problem", () => {
  assert.deepEqual(
    workflowSilenceProblems("run: wrangler deploy --config w.toml --env preview --name context-mcp-pr1\n"),
    [],
  );
});

test("the allowlist and the forbidden list do not overlap", () => {
  for (const name of PREVIEW_WORKER_SECRET_NAMES) {
    assert.ok(!FORBIDDEN_PREVIEW_KEYS.includes(name), `${name} must not be both allowed and forbidden`);
  }
});

const SECRET_LIST = (names) => JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));

test("worker-secrets passes a clean list even with a wrangler banner before it", () => {
  const text = `⛅️ wrangler 4.0.0\n${SECRET_LIST(["GATEWAY_SECRET"])}\n`;
  assert.deepEqual(workerSecretListProblems("context-mcp-pr1", text), []);
});

test("worker-secrets names a forbidden secret on the list as forbidden", () => {
  const problems = workerSecretListProblems("context-mcp-pr1", SECRET_LIST(["GATEWAY_SECRET", "TWILIO_ACCOUNT_SID"]));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("TWILIO_ACCOUNT_SID"));
  assert.ok(problems[0].includes("texting, SMS, email or billing"));
});

test("worker-secrets names an unknown secret on the list", () => {
  const problems = workerSecretListProblems("context-mcp-pr1", SECRET_LIST(["GATEWAY_SECRET", "EXTRA_KEY"]));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("EXTRA_KEY"));
});

test("worker-secrets reports text with no readable array as unreadable", () => {
  assert.deepEqual(workerSecretListProblems("context-mcp-pr1", "not json at all"), ["context-mcp-pr1: the secret list could not be read"]);
  assert.deepEqual(workerSecretListProblems("context-mcp-pr1", "[not, json"), ["context-mcp-pr1: the secret list could not be read"]);
});

test("worker-secrets never prints a secret value", () => {
  const text = `[{"name":"GATEWAY_SECRET","type":"secret_text","value":"${FAKE_VALUE}"},{"name":"EXTRA_KEY","type":"secret_text","value":"${FAKE_VALUE}"}]`;
  const problems = workerSecretListProblems("context-mcp-pr1", text);
  assert.equal(problems.length, 1);
  assert.ok(problems.every((problem) => !problem.includes(FAKE_VALUE)));
});

test("the silence CLI ignores the environment and exits 0 with no forbidden name in the workflow", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "silence"], {
    cwd: REPO_ROOT,
    env: { ...process.env, TWILIO_ACCOUNT_SID: FAKE_VALUE },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(FAKE_VALUE) && !result.stderr.includes(FAKE_VALUE));
});

test("the worker-secrets CLI exits 1 and names a forbidden secret on stdin", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "worker-secrets", "context-mcp-pr1"], {
    cwd: REPO_ROOT,
    input: SECRET_LIST(["GATEWAY_SECRET", "RESEND_API_KEY"]),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("RESEND_API_KEY"));
});
