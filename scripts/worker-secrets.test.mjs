import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectSecrets, secretNamesIn } from "./worker-secrets.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-secrets.mjs");

test("required, optional and renamed secrets", () => {
  const { secrets, skipped, missing } = collectSecrets(
    ["GATEWAY_SECRET", "CONTROL_PLANE_ORIGIN=CONTROL_PLANE_URL", "?GOOGLE_MAPS_KEY", "!LINQ_API_KEY", "?BRAVE_SEARCH_API_KEY"],
    { GATEWAY_SECRET: "g", CONTROL_PLANE_URL: "https://cp.example", BRAVE_SEARCH_API_KEY: "b", GOOGLE_MAPS_KEY: "" },
  );
  assert.deepEqual(secrets, { GATEWAY_SECRET: "g", CONTROL_PLANE_ORIGIN: "https://cp.example", BRAVE_SEARCH_API_KEY: "b" });
  assert.deepEqual(skipped, [{ name: "GOOGLE_MAPS_KEY", level: "notice" }, { name: "LINQ_API_KEY", level: "warning" }]);
  assert.deepEqual(missing, []);
});

test("a missing required secret is reported by its source, and bad specs throw", () => {
  assert.deepEqual(collectSecrets(["CONTROL_PLANE_ORIGIN=CONTROL_PLANE_URL"], {}).missing, ["CONTROL_PLANE_URL"]);
  assert.throws(() => collectSecrets([], {}), /at least one/);
  assert.throws(() => collectSecrets(["lower"], {}), /is not NAME/);
  assert.throws(() => collectSecrets(["A", "?A"], { A: "x" }), /named twice/);
});

test("the script fails before printing anything when a required secret is missing", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "WS_TEST_REQUIRED", "?WS_TEST_OPTIONAL"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /WS_TEST_REQUIRED must be set/);
});

test("the script prints only the JSON on stdout, and never a value on stderr", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "WS_TEST_A", "WS_TEST_B=WS_TEST_SOURCE", "?WS_TEST_ABSENT"], {
    env: { PATH: process.env.PATH, WS_TEST_A: "value-a", WS_TEST_SOURCE: "value-b" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { WS_TEST_A: "value-a", WS_TEST_B: "value-b" });
  assert.doesNotMatch(run.stderr, /value-/);
  assert.match(run.stderr, /::notice::WS_TEST_ABSENT/);
});

test("the guards read secret names off the workflow line", () => {
  assert.deepEqual(
    secretNamesIn(`node ../../scripts/worker-secrets.mjs GATEWAY_SECRET CONTROL_PLANE_ORIGIN=CONTROL_PLANE_URL '?BRAVE_SEARCH_API_KEY' "!LINQ_API_KEY" | pnpm exec wrangler secret bulk --config "$X"`),
    ["GATEWAY_SECRET", "CONTROL_PLANE_ORIGIN", "BRAVE_SEARCH_API_KEY", "LINQ_API_KEY"],
  );
  assert.deepEqual(secretNamesIn("pnpm exec wrangler deploy"), []);
});
