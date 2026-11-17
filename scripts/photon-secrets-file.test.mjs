import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { photonSecrets } from "./photon-secrets-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "photon-secrets-file.mjs");

function codeOf(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

test("both secrets, or neither", () => {
  assert.equal(photonSecrets({}), null);
  assert.equal(photonSecrets({ PHOTON_PROJECT_ID: "id" }), null);
  assert.deepEqual(photonSecrets({ PHOTON_PROJECT_ID: "id", PHOTON_PROJECT_SECRET: "sec$ret" }), {
    PHOTON_PROJECT_ID: "id",
    PHOTON_PROJECT_SECRET: "sec$ret",
  });
});

test("the script writes JSON and never prints a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "photon-secrets-"));
  const file = join(dir, "secrets.json");
  try {
    const run = spawnSync(process.execPath, [SCRIPT, file], {
      env: { PATH: process.env.PATH, PHOTON_PROJECT_ID: "proj-1", PHOTON_PROJECT_SECRET: "sec$ret" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.doesNotMatch(run.stderr, /proj-1|sec\$ret/);
    assert.equal(readFileSync(file, "utf8"), '{"PHOTON_PROJECT_ID":"proj-1","PHOTON_PROJECT_SECRET":"sec$ret"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing secret writes nothing and fails before deploy could send a half pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "photon-secrets-"));
  const file = join(dir, "secrets.json");
  try {
    const run = spawnSync(process.execPath, [SCRIPT, file], {
      env: { PATH: process.env.PATH, PHOTON_PROJECT_ID: "proj-1" },
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.throws(() => readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge deploy sends secrets with the code, not in a later secret put", () => {
  const prod = codeOf(readFileSync(join(ROOT, ".github/workflows/deploy-photon-bridge.yml"), "utf8"));
  assert.match(prod, /wrangler deploy --secrets-file/);
  assert.doesNotMatch(prod, /wrangler secret put/);
  const staging = codeOf(readFileSync(join(ROOT, ".github/workflows/deploy-staging.yml"), "utf8"));
  assert.match(staging, /photon-secrets-file\.mjs/);
  assert.doesNotMatch(staging, /secret put PHOTON_PROJECT/);
});
