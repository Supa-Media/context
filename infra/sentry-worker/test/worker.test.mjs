import worker, { ContextTokenBroker } from "../src/worker.js";

let failures = 0;
function check(label, condition) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

const env = {
  SENTRY_WEBHOOK_CLIENT_SECRET: "test-sentry-client-secret",
  CONTEXT_MCP_REFRESH_TOKEN: "crt_test_sentry_writer_00000000000000",
  CONTEXT_MCP_CLIENT_ID: "client_test_sentry_writer",
  CONTEXT_MCP_ENDPOINT: "https://mcp.example.test/@company/mcp",
  SENTRY_PROJECT_SLUG: "context-mobile",
  SENTRY_INCIDENT_PREFIX: "2-products/context/errors",
  CONTEXT_TOKEN_BROKER: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ accessToken: "cat_test_rotated_access_token" }) }),
  },
};

const writes = [];
globalThis.fetch = async (url, init) => {
  check("the bearer token is sent only in an Authorization header", init.headers.Authorization === "Bearer cat_test_rotated_access_token");
  check("the access token is absent from the request URL", !String(url).includes("cat_test_rotated_access_token"));
  const body = JSON.parse(init.body);
  writes.push(body.params.arguments);
  return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "written" }] } });
};

async function signedRequest(payload, { secret = env.SENTRY_WEBHOOK_CLIENT_SECRET, resource = "error" } = {}) {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://worker.example.test/sentry", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sentry-Hook-Resource": resource, "Sentry-Hook-Signature": signature },
    body: raw,
  });
}

const payload = {
  action: "created",
  data: {
    error: {
      issue_id: "987654321",
      event_id: "a".repeat(32),
      short_id: "CONTEXT-MOBILE-7",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "saveWorkspace (features/workspace/save.ts)",
      level: "error",
      web_url: "https://example-org.sentry.io/issues/987654321/?secret=nope",
      project: { slug: "context-mobile" },
      metadata: { type: "TypeError", value: "Cannot read properties of undefined" },
      tags: [{ key: "environment", value: "production" }],
    },
  },
};

const accepted = await worker.fetch(await signedRequest(payload), env);
check("a signed Sentry error is accepted", accepted.status === 202);
check("one error produces one Context write", writes.length === 1);
check("the write lands in the configured error folder", writes[0]?.path === "2-products/context/errors/context-mobile-7.md");
check("the note is explicitly team-visible", writes[0]?.visibility === "team" && writes[0]?.confirm_team_publish === true);
check("the note leads with one human sentence", writes[0]?.content.includes("**What is happening:** TypeError: Cannot read properties of undefined in saveWorkspace (features/workspace/save.ts)."));
check("the note stays short", writes[0]?.content.length < 1_500);
check("Sentry query strings are discarded", !writes[0]?.content.includes("secret=nope"));

const issuePayload = {
  action: "created",
  data: {
    issue: {
      id: "987654323",
      shortId: "CONTEXT-MOBILE-9",
      title: "Network request timed out",
      culprit: "syncNotes",
      level: "error",
      webUrl: "https://example-org.sentry.io/issues/987654323/",
      project: { slug: "context-mobile" },
      metadata: { type: "TimeoutError", value: "Network request timed out" },
    },
  },
};
const issueAccepted = await worker.fetch(await signedRequest(issuePayload, { resource: "issue" }), env);
check("the configured issue.created subscription is accepted", issueAccepted.status === 202 && writes[1]?.path.endsWith("context-mobile-9.md"));

const forged = await worker.fetch(await signedRequest(payload, { secret: "attacker-secret" }), env);
check("a forged signature is refused before a write", forged.status === 401 && writes.length === 2);

const oversized = new Request("https://worker.example.test/sentry", {
  method: "POST",
  headers: { "Content-Length": "256001", "Sentry-Hook-Signature": "a".repeat(64) },
  body: "{}",
});
check("an oversized payload is refused before it is read", (await worker.fetch(oversized, env)).status === 413 && writes.length === 2);

const foreign = structuredClone(payload);
foreign.data.error.project.slug = "another-project";
foreign.data.error.short_id = "OTHER-1";
const ignored = await worker.fetch(await signedRequest(foreign), env);
check("another Sentry project cannot write into this inbox", ignored.status === 202 && writes.length === 2);

const secretPayload = structuredClone(payload);
secretPayload.data.error.short_id = "CONTEXT-MOBILE-8";
secretPayload.data.error.issue_id = "987654322";
secretPayload.data.error.metadata.value = "API_KEY=definitely-not-a-real-credential failed";
await worker.fetch(await signedRequest(secretPayload), env);
check("credential-shaped error text is redacted", writes[2]?.content.includes("[redacted]") && !writes[2]?.content.includes("definitely-not-a-real-credential"));

const unconfigured = await worker.fetch(await signedRequest(payload), { ...env, CONTEXT_MCP_REFRESH_TOKEN: "" });
check("an unconfigured deployment is inert", unconfigured.status === 404);

globalThis.fetch = async () => Response.json({ jsonrpc: "2.0", id: "x", result: { isError: true } });
const rpcFailure = await worker.fetch(await signedRequest(payload), env);
check("an MCP tool refusal tells Sentry to retry", rpcFailure.status === 503);

globalThis.fetch = async () => new Response("down", { status: 503 });
const retry = await worker.fetch(await signedRequest(payload), env);
check("a failed Context write tells Sentry to retry", retry.status === 503);

const tokenState = new Map();
const broker = new ContextTokenBroker({ storage: {
  get: async (key) => tokenState.get(key),
  put: async (key, value) => tokenState.set(key, value),
} }, env);
let refreshes = 0;
globalThis.fetch = async (url, init) => {
  refreshes += 1;
  const params = new URLSearchParams(init.body);
  check("the broker refreshes against the Context origin", String(url) === "https://mcp.example.test/oauth/token");
  check("the OAuth refresh is bound to the MCP resource", params.get("resource") === env.CONTEXT_MCP_ENDPOINT);
  check("the dedicated client and seed refresh token are used", params.get("client_id") === env.CONTEXT_MCP_CLIENT_ID && params.get("refresh_token") === env.CONTEXT_MCP_REFRESH_TOKEN);
  return Response.json({ access_token: "cat_rotated", refresh_token: "crt_rotated", expires_in: 3600 });
};
const firstToken = await broker.fetch(new Request("https://internal/token"));
const secondToken = await broker.fetch(new Request("https://internal/token"));
check("the rotating grant is persisted and reused", (await firstToken.json()).accessToken === "cat_rotated" && (await secondToken.json()).accessToken === "cat_rotated" && refreshes === 1 && tokenState.get("oauth")?.refreshToken === "crt_rotated");

if (failures) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS");
