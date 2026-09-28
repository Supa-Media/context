/**
 * OpenAI's plugin-listing domain check: `/.well-known/openai-apps-challenge`
 * answers with the configured token and nothing else, only at the bare
 * origin, and not at all when no token is configured.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import worker from "../src/index.js";

const TOKEN = "oa-challenge_Abc123.xyz";

function get(path, env, method = "GET") {
  return worker.fetch(new Request(`https://mcp.context.test${path}`, { method }), env, { waitUntil() {} });
}

test("serves exactly the configured token as plain text", async () => {
  const response = await get("/.well-known/openai-apps-challenge", { OPENAI_APPS_CHALLENGE: ` ${TOKEN}\n` });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  assert.equal(await response.text(), TOKEN);
});

test("answers 404 when no token, or a malformed one, is configured", async () => {
  assert.equal((await get("/.well-known/openai-apps-challenge", {})).status, 404);
  for (const bad of ["short", "has space in it", "<script>alert(1)</script>", "x".repeat(513)]) {
    assert.equal((await get("/.well-known/openai-apps-challenge", { OPENAI_APPS_CHALLENGE: bad })).status, 404, bad);
  }
});

test("a workspace-prefixed path is a context, not the domain", async () => {
  const response = await get("/@seyi/.well-known/openai-apps-challenge", { OPENAI_APPS_CHALLENGE: TOKEN });
  assert.notEqual(await response.text(), TOKEN);
});

test("refuses anything but GET and HEAD", async () => {
  const response = await get("/.well-known/openai-apps-challenge", { OPENAI_APPS_CHALLENGE: TOKEN }, "POST");
  assert.equal(response.status, 405);
});

test("the product deployment publishes OpenAI's issued challenge token", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /^OPENAI_APPS_CHALLENGE\s*=\s*"[A-Za-z0-9._~-]{8,512}"\s*$/m);
});
