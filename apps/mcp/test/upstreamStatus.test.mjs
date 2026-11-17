/**
 * A Tex page the control plane refuses, and a workspace with no binding
 * (`http/texPage/page.js`, `http/route.js`).
 *
 * Convex answers both on HTTP 200. A page `{ status: "refused" }` is a definite
 * no, so the route answers 403 and an HTTP client does not retry it. `{ binding:
 * null }` is the same bytes for an unknown token and a workspace with no bucket,
 * so that one stays 503, with Retry-After, and the log says which path and what
 * the body was. A thrown control-plane call stays 503 too.
 *
 * The log is a code and a status. A token, a phone number, or a secret in the
 * body does not get a line.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { createControlPlane } from "../src/controlPlane/index.js";
import { loadPage, PageRefusal } from "../src/http/texPage/page.js";

const TOKEN = "cat_secret_token_000000";

function plane(response) {
  const fetchImpl = async () => response;
  return createControlPlane({ CONTROL_PLANE_URL: "https://control.example.test", GATEWAY_SECRET: "gw-secret-not-real" }, { fetchImpl });
}

async function logged(run) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines.map((line) => JSON.parse(line));
}

test("a refused page is 403, and the log keeps the status and the code", async () => {
  const lines = await logged(async () => {
    await assert.rejects(
      () => loadPage(plane(Response.json({ status: "refused", reason: TOKEN, phone: "+15555550100" })), { accessToken: TOKEN }),
      (error) => {
        assert.ok(error instanceof PageRefusal);
        assert.equal(error.status, 403);
        assert.equal(error.error, "refused");
        const response = error.response();
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("retry-after"), null);
        return true;
      },
    );
  });
  const upstream = lines.filter((line) => line.event === "tex_page_upstream");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].upstream, 200);
  assert.equal(upstream[0].code, "refused");
  assert.equal(typeof upstream[0].ms, "number");
  assert.ok(!JSON.stringify(upstream).includes(TOKEN));
  assert.ok(!JSON.stringify(upstream).includes("15555550100"));
});

test("a control plane that fails stays 503 and says when to retry", async () => {
  const lines = await logged(async () => {
    await assert.rejects(
      () => loadPage(plane(new Response("nope", { status: 500 })), { accessToken: TOKEN }),
      (error) => {
        assert.ok(error instanceof PageRefusal);
        assert.equal(error.status, 503);
        assert.equal(error.error, "unavailable");
        assert.equal(error.response().headers.get("retry-after"), "5");
        return true;
      },
    );
  });
  const upstream = lines.filter((line) => line.event === "tex_page_upstream");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].upstream, 500);
  assert.equal(upstream[0].code, "status_500");
  assert.ok(!JSON.stringify(upstream).includes(TOKEN));
});

test("a page body that is not a page stays 503", async () => {
  const lines = await logged(async () => {
    await assert.rejects(() => loadPage(plane(Response.json({ status: "pwned" })), { accessToken: TOKEN }), (error) => error instanceof PageRefusal && error.status === 503);
  });
  const upstream = lines.find((line) => line.event === "tex_page_upstream");
  assert.equal(upstream.upstream, 200);
  assert.equal(upstream.code, "pwned");
});

test("a machines list with no binding stays 503, names the path, and does not carry the token", async () => {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_unbound", "unbound", null);
  await controlPlane.addGrant({ accessToken: TOKEN, workspaceId: "ws_unbound", role: "owner", scopes: ["context:read", "context:write"], clientId: "context_console", userId: "user_unbound" });
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    const { ctx } = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://mcp.context.test/machines/app/list", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_unbound" }),
      }),
      { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
      ctx,
    );
    const text = await response.text();
    assert.equal(response.status, 503, text);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(JSON.parse(text).error, "storage_unavailable");
    const page = await worker.fetch(
      new Request("https://mcp.context.test/tex/page", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "unbound", chat: "me" }),
      }),
      { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
      ctx,
    );
    assert.equal(page.status, 503);
    assert.equal(page.headers.get("retry-after"), "5");
  } finally {
    console.error = original;
    restore();
  }
  const noted = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "storage_not_bound");
  assert.deepEqual(noted.map((line) => line.path), ["/machines/app/list", "/tex/page"]);
  for (const line of noted) {
    assert.equal(line.upstream, 200);
    assert.equal(line.code, "binding_null");
    assert.equal(typeof line.ms, "number");
    assert.ok(line.ms >= 0);
  }
  assert.ok(!JSON.stringify(noted).includes(TOKEN));
});
