/**
 * `context_app_origin` in the authorization server metadata: the app's
 * address, for a CLI that finished signing in on a loopback page and wants to
 * hand the browser to the app's own "connected" screen. Only a deployment that
 * set APP_ORIGIN says it, and only an https one: a self-hosted gateway without
 * it keeps the CLI's plain page, and a metadata document is no place to send a
 * browser anywhere else.
 *
 * In its own file because `tenancy.test.mjs` is past the size allowance.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.js";

async function metadata(env) {
  const response = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-authorization-server"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 200);
  return response.json();
}

test("without APP_ORIGIN the metadata names no app", async () => {
  assert.ok(!("context_app_origin" in (await metadata({}))));
});

test("with APP_ORIGIN the metadata names the app's origin", async () => {
  assert.equal((await metadata({ APP_ORIGIN: "https://app.context.test/" })).context_app_origin, "https://app.context.test");
});

test("...and never a non-https one", async () => {
  assert.ok(!("context_app_origin" in (await metadata({ APP_ORIGIN: "http://app.context.test" }))));
  assert.ok(!("context_app_origin" in (await metadata({ APP_ORIGIN: "not a url" }))));
});
