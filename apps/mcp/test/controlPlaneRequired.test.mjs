/**
 * The control plane is required, and the gateway says so before it does
 * anything else. A deployment without `CONTROL_PLANE_URL` or `GATEWAY_SECRET`
 * (or with a control-plane URL that is not https) has no tenants to serve, so
 * every request gets the same JSON refusal, naming the setting that is wrong
 * and never its value.
 *
 * Sabotage record: remove the guard at the top of `fetch` in src/index.js and
 * every request below reaches the router (401s, 404s, a 200 from the OAuth
 * metadata), so the first three checks fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const SECRET = "gateway-secret-value-that-must-never-appear";
const URL_OK = "https://control-plane.example";
const ctx = { waitUntil() {} };

async function fetchWith(env, path = "/mcp", init = { method: "POST", body: "{}" }) {
  return worker.fetch(new Request(`https://gateway.example${path}`, init), env, ctx);
}

test("with no CONTROL_PLANE_URL every request is a 503 JSON answer naming that setting", async () => {
  const env = { GATEWAY_SECRET: SECRET };
  for (const [path, init] of [
    ["/mcp", { method: "POST", body: "{}", headers: { Authorization: "Bearer anything" } }],
    ["/inbox", { method: "POST", body: "{}" }],
    ["/oauth/token", { method: "POST", body: "" }],
    ["/.well-known/oauth-authorization-server", { method: "GET" }],
    ["/internal/mover/page", { method: "POST", body: "" }],
  ]) {
    const response = await fetchWith(env, path, init);
    assert.equal(response.status, 503, `${path} answers 503`);
    assert.match(response.headers.get("content-type") || "", /application\/json/, `${path} answers JSON`);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "control_plane_not_configured", settings: ["CONTROL_PLANE_URL"] });
    assert.ok(!body.includes(SECRET), `${path} does not echo the gateway secret`);
  }
});

test("with no GATEWAY_SECRET the refusal names that setting and no other", async () => {
  const response = await fetchWith({ CONTROL_PLANE_URL: URL_OK });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "control_plane_not_configured", settings: ["GATEWAY_SECRET"] });
});

test("a control-plane URL that is not https is named, and its value is not echoed", async () => {
  const response = await fetchWith({ CONTROL_PLANE_URL: "http://plain.example", GATEWAY_SECRET: SECRET });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body).settings, ["CONTROL_PLANE_URL"]);
  assert.ok(!body.includes("plain.example"), "the URL itself is not echoed");
});

test("with both settings usable the gateway serves as before", async () => {
  const response = await fetchWith(
    { CONTROL_PLANE_URL: URL_OK, GATEWAY_SECRET: SECRET },
    "/.well-known/oauth-authorization-server",
    { method: "GET" }
  );
  assert.equal(response.status, 200);
});
