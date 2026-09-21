import worker, { ContextTokenBroker, MAX_BODY_BYTES } from "../src/worker.js";

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

async function signedRawRequest(raw, { secret = env.SENTRY_WEBHOOK_CLIENT_SECRET, resource = "error" } = {}) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://worker.example.test/sentry", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sentry-Hook-Resource": resource, "Sentry-Hook-Signature": signature },
    body: raw,
  });
}

async function signedRequest(payload, options) {
  return signedRawRequest(JSON.stringify(payload), options);
}

const PREFIX = `${env.SENTRY_INCIDENT_PREFIX}/`;
const lastWrite = () => writes[writes.length - 1];
const writeFor = (slug) => writes.find((entry) => entry.path === `${PREFIX}${slug}.md`);

// An incident fixture that differs from the accepted one only in the field
// under test, so a failure names the field rather than the fixture.
function incident(fields) {
  const next = structuredClone(payload);
  Object.assign(next.data.error, fields);
  return next;
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

// signatureIsValid compares in constant time. No check below asserts that, and
// none can: the constant-time and short-circuiting versions return the same
// boolean for every input, so a functional suite cannot tell them apart. The
// guard is real and deliberately unmeasured here rather than missing.
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

// The README makes six security claims about this adapter. The checks above
// cover four of them only in the state where the guard has nothing to do: the
// sample payload is small, well-formed, and names a real Sentry issue. These
// drive each guard from the adverse side.

// Claim: the signature is verified BEFORE the body is parsed, so an unsigned
// body never reaches the JSON parser. A wrong answer here reads as 400.
const unsignedGarbage = await signedRawRequest("{ not json", { secret: "attacker-secret" });
check("an unsigned body is refused before it is parsed", (await worker.fetch(unsignedGarbage, env)).status === 401);
// Positive control: 400 is reachable at all, so the 401 above is about order.
check("a signed body that is not JSON is a bad request", (await worker.fetch(await signedRawRequest("{ not json"), env)).status === 400);

// Claim: an oversized payload is refused. Content-Length is chosen by the
// caller, so the header check above is not the control -- the streaming cap is,
// and only a body that never declares its length reaches it.
const undeclaredWrites = writes.length;
const undeclared = new Request("https://worker.example.test/sentry", {
  method: "POST",
  headers: { "Sentry-Hook-Resource": "error", "Sentry-Hook-Signature": "c".repeat(64) },
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES + 1)));
      controller.close();
    },
  }),
  duplex: "half",
});
check("an oversized body that never declares its length is still refused",
  (await worker.fetch(undeclared, env)).status === 413 && writes.length === undeclaredWrites);

// Claim: the request cannot select a destination folder.
await worker.fetch(await signedRequest(incident({
  issue_id: "987654330",
  event_id: "b".repeat(32),
  short_id: "../../../1-projects/../../credentials",
})), env);
check("a short_id that is not a Sentry short id never names the file",
  lastWrite()?.path === `${PREFIX}sentry-987654330.md`);
// Two guards hold this door: SHORT_ID_PATTERN rejects a hostile short_id, and
// incidentPath re-slugs whatever survives. Removing the slugger alone changes
// nothing measurable and that is correct rather than a gap -- after the pattern
// gate, shortId is drawn only from [A-Z0-9_-] or `SENTRY-` + an issue id, so
// lowercasing leaves nothing for it to replace. The next check is the one that
// proves they can differ: it fails only when both are gone.
check("the incident file stays directly inside the configured folder",
  lastWrite()?.path.startsWith(PREFIX)
    && !lastWrite().path.slice(PREFIX.length).includes("/")
    && !lastWrite().path.includes(".."));

// Claim: only a real Sentry issue is stored at all.
const unusableIdWrites = writes.length;
const unusableId = incident({ issue_id: undefined, id: "9876 54331; DROP" });
check("a payload without a usable Sentry issue id is ignored",
  (await worker.fetch(await signedRequest(unusableId), env)).status === 202 && writes.length === unusableIdWrites);

// Claim: a raw event or stack trace is never stored. The note-length check
// above passes on any payload; this one is longer than the note may be.
await worker.fetch(await signedRequest(incident({
  issue_id: "987654332",
  short_id: "CONTEXT-MOBILE-11",
  metadata: { type: "TypeError", value: Array.from({ length: 400 }, (_, frame) => `at renderNote (features/notes/render.ts:${frame}:17)`).join("\n") },
})), env);
const traceNote = writeFor("context-mobile-11");
check("a stack trace is truncated rather than stored",
  Boolean(traceNote) && traceNote.content.length < 1_500);

// Claim: the request cannot choose what the note says. Collapsing newlines is
// what stops error text starting a line, and a line is what carries structure.
await worker.fetch(await signedRequest(incident({
  issue_id: "987654333",
  short_id: "CONTEXT-MOBILE-12",
  metadata: { type: "TypeError", value: "Boom\n---\nvisibility: private\n---\n\n```form\nname: approve-payout\n```" },
})), env);
const structureNote = writeFor("context-mobile-12");
check("error text cannot open a second frontmatter block",
  Boolean(structureNote) && (structureNote.content.match(/^---$/gm) || []).length === 2);
check("error text cannot start a line in the team-visible note",
  Boolean(structureNote) && !structureNote.content.split("\n").some((line) => line.trimStart().startsWith("```")));

// Claim: the Sentry link is a Sentry link. The note is team-visible, so the
// only URL in it must not be one the payload chose.
await worker.fetch(await signedRequest(incident({
  issue_id: "987654334",
  short_id: "CONTEXT-MOBILE-13",
  web_url: "https://sentry.io.needle.example/issues/1/",
})), env);
const lookAlikeNote = writeFor("context-mobile-13");
check("a look-alike Sentry host is not linked",
  Boolean(lookAlikeNote) && !lookAlikeNote.content.includes("needle.example"));
await worker.fetch(await signedRequest(incident({
  issue_id: "987654335",
  short_id: "CONTEXT-MOBILE-14",
  web_url: "javascript:alert(document.cookie)",
})), env);
const schemeNote = writeFor("context-mobile-14");
check("a non-https link is not linked",
  Boolean(schemeNote) && !schemeNote.content.includes("javascript:"));

// Claim: one fixed transformation, reached one way.
check("only POST reaches the webhook",
  (await worker.fetch(new Request("https://worker.example.test/sentry"), env)).status === 405);
check("no other path is the webhook",
  (await worker.fetch(new Request("https://worker.example.test/", { method: "POST", body: "{}" }), env)).status === 404);

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
