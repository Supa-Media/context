import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gateLines, pullRequestState } from "./still-open.mjs";

const SCRIPT = fileURLToPath(new URL("./still-open.mjs", import.meta.url));

/** A fetch stub that answers with the given status and JSON body, and records the request. */
function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test("an open pull request reads as open", async () => {
  const calls = [];
  const state = await pullRequestState("tok", "owner/repo", "42", { fetchImpl: fakeFetch(200, { state: "open" }, calls) });
  assert.equal(state, "open");
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/pulls/42");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("a closed pull request reads as closed", async () => {
  const state = await pullRequestState("tok", "owner/repo", "42", { fetchImpl: fakeFetch(200, { state: "closed" }) });
  assert.equal(state, "closed");
});

test("a server error reads as unknown, not as closed", async () => {
  const state = await pullRequestState("tok", "owner/repo", "42", { fetchImpl: fakeFetch(500, { state: "closed" }) });
  assert.equal(state, null);
});

test("a fetch that throws reads as unknown", async () => {
  const state = await pullRequestState("tok", "owner/repo", "42", {
    fetchImpl: async () => {
      throw new TypeError("network down");
    },
  });
  assert.equal(state, null);
});

test("a body whose state is not a string reads as unknown", async () => {
  const state = await pullRequestState("tok", "owner/repo", "42", { fetchImpl: fakeFetch(200, { state: 1 }) });
  assert.equal(state, null);
  const missing = await pullRequestState("tok", "owner/repo", "42", { fetchImpl: fakeFetch(200, {}) });
  assert.equal(missing, null);
});

test("gateLines sets the gate for a closed pull request", () => {
  const lines = gateLines("closed", "42");
  assert.equal(lines.env, "PREVIEW_PR_CLOSED=true");
  assert.match(lines.message, /#42 closed while its preview deployed/);
});

test("gateLines sets nothing for an open pull request", () => {
  assert.deepEqual(gateLines("open", "42"), {
    env: null,
    message: "Pull request #42 is still open; deploying on.",
  });
});

test("gateLines warns and sets nothing when the state is unknown", () => {
  const lines = gateLines(null, "42");
  assert.equal(lines.env, null);
  assert.ok(lines.message.startsWith("::warning::"), lines.message);
  assert.match(lines.message, /carries on/);
});

test("importing the script does not run it", () => {
  // Run in a child with no GITHUB_ENV or PR: if main ran on import it would fail or write.
  const dir = mkdtempSync(join(tmpdir(), "still-open-"));
  try {
    const envFile = join(dir, "github_env");
    writeFileSync(envFile, "");
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(SCRIPT)}); console.log("imported");`],
      { env: { PATH: process.env.PATH, GITHUB_ENV: envFile }, encoding: "utf8" },
    );
    assert.equal(output.trim(), "imported");
    assert.equal(readFileSync(envFile, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
