/**
 * `GET /` on the gateway's host names the MCP endpoint and links the guide,
 * and takes nothing from the routes beside it: the MCP transport, the OAuth
 * discovery documents and the OAuth routes answer as they did.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { worker, env, accessTokenFor } from "./harness.mjs";

const production = { ...env, PUBLIC_ORIGIN: "https://mcp.context.lc", APP_ORIGIN: "https://context.lc" };
const ctx = { waitUntil() {} };
const ask = (path, init = {}, useEnv = production) => worker.fetch(new Request(`https://mcp.context.lc${path}`, init), useEnv, ctx);

test("GET / is a 200 page naming the endpoint and linking the guide", async () => {
  const response = await ask("/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.ok(html.includes("https://mcp.context.lc/mcp"));
  assert.ok(html.includes('<a href="https://context.lc/mcp">'));
  assert.ok(html.includes("Streamable HTTP"));
  assert.ok(html.includes("OAuth (no API key)"));
  assert.doesNotMatch(html, /noindex/i);
});

test("HEAD / is the same answer with no body, and the page is the same for a signed-in caller", async () => {
  const head = await ask("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const anonymous = await (await ask("/")).text();
  const signedIn = await (await ask("/", { headers: { Authorization: `Bearer ${accessTokenFor("priv-token")}` } })).text();
  assert.equal(signedIn, anonymous);
});

test("a self-hosted gateway names its own origins, and a malformed app origin never reaches the page", async () => {
  const own = await (await ask("/", {}, { ...env, PUBLIC_ORIGIN: "https://mcp.example.test", APP_ORIGIN: "https://notes.example.test/" })).text();
  assert.ok(own.includes("https://mcp.example.test/mcp"));
  assert.ok(own.includes('<a href="https://notes.example.test/mcp">'));
  const hostile = await (await ask("/", {}, { ...production, APP_ORIGIN: 'javascript:alert(1)//"><script>' })).text();
  assert.ok(!hostile.includes("<script>"));
  assert.ok(hostile.includes('<a href="https://context.lc/mcp">'));
});

test("only GET and HEAD on the bare path are the page", async () => {
  for (const [path, init] of [
    ["/", { method: "POST", body: "{}" }],
    ["/", { method: "DELETE" }],
    ["/nothing-here", {}],
    ["/@alpha/", {}],
    ["/@alpha", {}],
  ]) {
    const response = await ask(path, init);
    assert.equal(response.status, 404, `${init.method ?? "GET"} ${path}`);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
});

test("the MCP transport is untouched: POST answers, GET is still 405, no token is still 401", async () => {
  const answered = await ask("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessTokenFor("priv-token")}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }),
  });
  assert.equal(answered.status, 200);
  const body = await answered.json();
  assert.equal(body.id, 7);
  assert.notEqual(body.result, undefined);

  const unsigned = await ask("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }) });
  assert.equal(unsigned.status, 401);
  assert.ok((unsigned.headers.get("WWW-Authenticate") ?? "").includes('resource_metadata="https://mcp.context.lc/.well-known/oauth-protected-resource/mcp"'));

  const get = await ask("/mcp");
  assert.equal(get.status, 405);
  assert.ok(!(await get.text()).includes("<html"));
});

test("the OAuth discovery documents and routes are untouched", async () => {
  const resource = await ask("/.well-known/oauth-protected-resource");
  assert.equal(resource.status, 200);
  assert.equal((await resource.json()).resource, "https://mcp.context.lc/mcp");
  const forMcp = await ask("/.well-known/oauth-protected-resource/mcp");
  assert.equal(forMcp.status, 200);
  assert.equal((await forMcp.json()).resource, "https://mcp.context.lc/mcp");
  const server = await ask("/.well-known/oauth-authorization-server");
  assert.equal(server.status, 200);
  const metadata = await server.json();
  assert.equal(metadata.issuer, "https://mcp.context.lc");
  assert.equal(metadata.token_endpoint, "https://mcp.context.lc/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://mcp.context.lc/oauth/register");
  // A wrong method on an OAuth route is still its own 405, never the page.
  assert.equal((await ask("/oauth/token")).status, 405);
  assert.equal((await ask("/oauth/register")).status, 405);
  assert.equal((await ask("/oauth/revoke")).status, 405);
});
