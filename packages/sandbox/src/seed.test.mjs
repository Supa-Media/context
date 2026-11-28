import test from "node:test";
import assert from "node:assert/strict";

import { getFunctionName } from "convex/server";

import { cliFailureReason, issuePersonaCode, probeCloudflare, runConvexSeed, seedPlan, storeStorageToken, writeFixtureNote } from "./seed.mjs";

test("a failed CLI run names its cause from stderr", () => {
  const reason = cliFailureReason(
    "noise\n✖ Error: Uncaught Error: staging personas are issued codes only on staging\n",
    1,
  );
  assert.match(reason, /staging personas/);
});

test("digit runs and preview deploy keys never reach the failure reason", () => {
  const reason = cliFailureReason("Error: bad key preview:team|abc123 for code 123456\n", 1);
  assert.doesNotMatch(reason, /123456/);
  assert.doesNotMatch(reason, /abc123/);
  assert.doesNotMatch(reason, /team\|abc123/);
  assert.match(reason, /preview:…/);
});

test("with no stderr the reason falls back to the exit status", () => {
  assert.equal(cliFailureReason("", 2), "exit 2");
});

test("a failed run throws with the redacted reason and never the stdout", () => {
  const run = () => ({
    status: 1,
    error: undefined,
    stdout: '{"code":"493817"}',
    stderr: "Error: Uncaught Error: not found for preview:team|abc123\n",
  });
  assert.throws(
    () => issuePersonaCode("alpha@supa.media", { deployment: "pr1-ctx", deployKey: "preview:team|abc123", run }),
    (error) => {
      assert.match(error.message, /^Issuing a preview code failed: /);
      assert.match(error.message, /not found/);
      assert.doesNotMatch(error.message, /493817/);
      assert.doesNotMatch(error.message, /abc123/);
      return true;
    },
  );
});

test("the Convex seed runs functions/seed:preview on the named deployment with the deploy key", () => {
  let captured;
  const run = (command, args, options) => {
    captured = { command, args, options };
    return { status: 0, error: undefined, stdout: "", stderr: "" };
  };
  runConvexSeed({ deployment: "example-preview-123", deployKey: "preview:team|key456", run });
  assert.deepEqual(captured.args.slice(1), ["run", "--deployment", "example-preview-123", "functions/seed:preview", "{}"]);
  assert.equal(captured.options.env.CONVEX_DEPLOY_KEY, "preview:team|key456");
  assert.equal(captured.options.env.CONVEX_DEPLOYMENT, "");
});

test("a failed Convex seed throws with the redacted reason", () => {
  const run = () => ({
    status: 1,
    error: undefined,
    stdout: "",
    stderr: "Uncaught Error: Preview seed: alpha's account is missing.\n",
  });
  assert.throws(
    () => runConvexSeed({ deployment: "example-preview-123", deployKey: "preview:team|key456", run }),
    /Seeding the preview deployment failed: .*account is missing/,
  );
});

test("the storage token is stored through the seed action, with the minimal environment", () => {
  let captured;
  const run = (command, args, options) => {
    captured = { command, args, options };
    return { status: 0, error: undefined, stdout: "", stderr: "" };
  };
  storeStorageToken({ deployment: "example-preview-123", deployKey: "preview:team|key456", token: "cf-token-fixture", run });
  assert.deepEqual(captured.args.slice(1), [
    "run",
    "--deployment",
    "example-preview-123",
    "functions/seed:previewStorageToken",
    JSON.stringify({ token: "cf-token-fixture" }),
  ]);
  assert.equal(captured.options.env.CONVEX_DEPLOY_KEY, "preview:team|key456");
  assert.equal(captured.options.env.CONVEX_DEPLOYMENT, "");
  for (const name of Object.keys(captured.options.env)) {
    assert.ok(["PATH", "HOME", "CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "NO_COLOR"].includes(name), `${name} must not be passed`);
  }
});

test("storing the storage token refuses a missing or blank token without running anything", () => {
  let called = false;
  const run = () => {
    called = true;
    return { status: 0 };
  };
  for (const token of [undefined, "", "   "]) {
    assert.throws(
      () => storeStorageToken({ deployment: "example-preview-123", deployKey: "preview:team|key456", token, run }),
      /PREVIEW_R2_API_TOKEN is not set: the preview cannot create its storage\./,
    );
  }
  assert.equal(called, false);
});

test("a failed storage token store names the exit status, never stderr or the token", () => {
  const token = "cf-token-secret-fixture";
  const run = () => ({
    status: 1,
    error: undefined,
    stdout: "",
    stderr: `Uncaught Error: rejected ${token} in account text\n`,
  });
  assert.throws(
    () => storeStorageToken({ deployment: "example-preview-123", deployKey: "preview:team|key456", token, run }),
    (error) => {
      assert.equal(error.message, "Storing the preview's storage token failed (exit 1).");
      assert.doesNotMatch(error.message, /cf-token-secret-fixture/);
      assert.doesNotMatch(error.message, /rejected/);
      return true;
    },
  );
});

test("the Cloudflare probe asks the five paths with the bearer token and returns status and codes only", async () => {
  const token = "cf-token-probe-fixture";
  const accountId = "a".repeat(32);
  const message = "secret account detail text";
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push({ url, auth: options.headers.Authorization, method: options.method });
    if (url.endsWith("/user/tokens/verify")) return { status: 200, json: async () => ({ success: true, errors: [] }) };
    if (url.includes("/tokens/verify")) return { status: 403, json: async () => ({ errors: [{ code: 1000, message }] }) };
    if (url.includes("/r2/buckets")) return { status: 403, json: async () => ({ errors: [{ code: 10000, message }, { code: 9109 }] }) };
    if (url.endsWith("/user/tokens/permission_groups")) throw new TypeError(`fetch failed for ${token}`);
    return { status: 200, json: async () => { throw new SyntaxError("not json"); } };
  };
  const results = await probeCloudflare({ token, accountId, fetchImpl });

  assert.deepEqual(asked.map((call) => call.url.replace(accountId, "ACCOUNT")), [
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    "https://api.cloudflare.com/client/v4/accounts/ACCOUNT/tokens/verify",
    "https://api.cloudflare.com/client/v4/accounts/ACCOUNT/r2/buckets?per_page=1",
    "https://api.cloudflare.com/client/v4/accounts/ACCOUNT/tokens/permission_groups",
    "https://api.cloudflare.com/client/v4/user/tokens/permission_groups",
  ]);
  for (const call of asked) {
    assert.equal(call.auth, `Bearer ${token}`);
    assert.equal(call.method, "GET");
  }

  assert.deepEqual(results, [
    { label: "user token verify", status: 200, codes: [] },
    { label: "account token verify", status: 403, codes: [1000] },
    { label: "R2 bucket list", status: 403, codes: [10000, 9109] },
    { label: "account token permission groups", status: 200, codes: [] },
    { label: "user token permission groups", status: "network", codes: [] },
  ]);
  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, /secret account detail|fetch failed|not json/);
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, new RegExp(accountId));
});

test("the production mirror gets storage on a preview, so group chat homes open there, and never its notes", () => {
  // Every group chat's home lives in @context-lc (tex/groups/): with no binding, every group turn on a preview
  // failed opening its store (binding_null), Lab test chats included.
  assert.deepEqual(seedPlan("context-lc"), { storage: true, notes: false });
  assert.deepEqual(seedPlan("lumio"), { storage: true, notes: true });
});

/** A fake Convex client: each function name maps to a handler, and every call is recorded by name. */
function fakeFixtureClient(handlers) {
  const calls = [];
  return {
    calls,
    action: async (reference, args) => {
      const name = getFunctionName(reference);
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected call ${name}`);
      return handler(args);
    },
  };
}

/** An error shaped like a Convex error: `error.data.code` is what the seed reads. */
function convexError(code) {
  return Object.assign(new Error(`convex ${code}`), { data: { code } });
}

test("a fixture create that hits CONFLICT is read back, so the note counts as existing and nothing throws", async () => {
  let reads = 0;
  const note = { path: "projects/plan.md", text: "# Plan", etag: "e-plan" };
  const client = fakeFixtureClient({
    "functions/files:readNote": () => {
      reads += 1;
      if (reads === 1) throw convexError("FILE_NOT_FOUND");
      return note;
    },
    "functions/files:writeNote": () => { throw convexError("CONFLICT"); },
  });
  const result = await writeFixtureNote(client, { workspaceId: "ws1", path: "projects/plan.md", text: "# Plan" });
  assert.deepEqual(result, { existing: note, written: undefined });
  assert.deepEqual(client.calls, ["functions/files:readNote", "functions/files:writeNote", "functions/files:readNote"]);
});

test("a fixture write that fails for another reason is rethrown", async () => {
  const client = fakeFixtureClient({
    "functions/files:readNote": () => { throw convexError("FILE_NOT_FOUND"); },
    "functions/files:writeNote": () => { throw convexError("STORAGE_UNAVAILABLE"); },
  });
  await assert.rejects(
    writeFixtureNote(client, { workspaceId: "ws1", path: "projects/plan.md", text: "# Plan" }),
    (error) => error.data.code === "STORAGE_UNAVAILABLE",
  );
  assert.deepEqual(client.calls, ["functions/files:readNote", "functions/files:writeNote"], "no reread after a non-conflict error");
});

test("a CONFLICT on a write that passed an etag is a real conflict and is rethrown", async () => {
  const client = fakeFixtureClient({
    "functions/files:readNote": () => ({ path: "index.md", text: "# Old front page", etag: "e-old" }),
    "functions/files:writeNote": () => { throw convexError("CONFLICT"); },
  });
  await assert.rejects(
    writeFixtureNote(client, { workspaceId: "ws1", path: "index.md", text: "# New front page staging-personas-v1" }),
    (error) => error.data.code === "CONFLICT",
  );
  assert.deepEqual(client.calls, ["functions/files:readNote", "functions/files:writeNote"], "an etag conflict is not retried by reading again");
});
