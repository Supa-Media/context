#!/usr/bin/env node
/**
 * Is the gateway actually answering — and answering the way a client needs?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `health-check.yml` shipped as an unedited scaffold: a placeholder
 * deployment URL, its `schedule:` commented out, and — measured on the run
 * list — zero runs in the life of the repository. So nothing watched
 * production, and the first report of an outage was a person failing to
 * connect. That is the shape CLAUDE.md keeps naming: a check that is green, or
 * absent, because it never executed.
 *
 * It would also have watched the wrong plane. That scaffold pings a Convex
 * query; the thing an AI client actually talks to is the gateway Worker. The
 * control plane can be perfectly healthy while the endpoint every customer
 * configured is dead.
 *
 * ── WHY IT NEEDS NO CREDENTIAL ─────────────────────────────────────────────
 *
 * All three probes are unauthenticated by design, so this file names no
 * secret, and a repository secret is not a prerequisite for it to run:
 *
 *   1. RFC 9728 protected-resource metadata — public by specification.
 *   2. RFC 8414 authorization-server metadata — public by specification.
 *   3. `POST /mcp` with no credential, where the *healthy* answer is a 401
 *      carrying a `WWW-Authenticate` challenge. A token would tell us less,
 *      not more: this asserts the auth boundary is intact from the outside.
 *
 * Probe 3 is the load-bearing one. The two metadata documents are built from
 * the request origin and are nearly static, so they can keep answering while
 * the MCP route behind them is broken. Probe 3 exercises the route a client
 * posts to.
 *
 * ── WHAT "HONEST" MEANS HERE ───────────────────────────────────────────────
 *
 * Every one of these is red, not amber and not skipped:
 *
 *   - a network error, a timeout, or a non-2xx where a document is expected;
 *   - a 200 whose body is not the document it claims to be (a CDN error page,
 *     a parked-domain placeholder and an origin-error interstitial are all
 *     served as 200 text/html, so status alone is not liveness);
 *   - a metadata document missing a field a client refuses to proceed without
 *     — `code_challenge_methods_supported` containing `S256` is the explicit
 *     example, because MCP requires a client to give up when it is absent;
 *   - **an unauthenticated 200 from `POST /mcp`**, which is not an outage but
 *     a far worse thing, and must never be reported as health.
 *
 * There is deliberately no "treat 5xx as a flake and retry until green" path.
 * A retry that turns red into green is how a real outage gets averaged away.
 * The workflow runs this often enough that one genuinely transient failure
 * costs a single red run and self-clears on the next tick.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/health-check-gateway.mjs [--origin https://context.lc]
 *   node scripts/health-check-gateway.mjs --self-test
 *
 * `--self-test` proves the assertions still catch what they claim, against
 * synthetic responses, with no network at all. It runs first in CI for the
 * same reason every other checker here does it: a probe whose assertions have
 * silently stopped matching anything reports a healthy service forever.
 */

/** The public endpoint this product documents. Not an account identifier. */
const DEFAULT_ORIGIN = "https://context.lc";

/** Per-request ceiling. A gateway that needs longer than this is not well. */
const TIMEOUT_MS = 15_000;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isNonEmptyArrayOfStrings(v) {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/**
 * Parse a body that is only useful if it is JSON.
 *
 * Returns `{ json }` or `{ problem }` — never throws, because a gateway
 * serving HTML where JSON belongs is the exact failure this is here to report,
 * and a stack trace reads as "the checker is broken" instead.
 */
function asJson(body) {
  try {
    const json = JSON.parse(body);
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return { problem: "body parsed but is not a JSON object" };
    }
    return { json };
  } catch {
    const opening = body.slice(0, 80).replace(/\s+/g, " ").trim();
    return { problem: `body is not JSON (starts: ${JSON.stringify(opening)})` };
  }
}

/**
 * The probes, each with the assertions that make its 200 mean something.
 *
 * `check` receives `{ status, headers, body }` and returns a list of problems.
 * An empty list must mean "the assertions were evaluated and held".
 */
export const PROBES = [
  {
    name: "protected-resource metadata",
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    check({ status, body }) {
      const problems = [];
      if (status !== 200) return [`expected 200, got ${status}`];
      const { json, problem } = asJson(body);
      if (problem) return [problem];
      if (!isNonEmptyString(json.resource)) problems.push("no `resource`");
      // MCP raises RFC 9728's OPTIONAL to a MUST and real clients read only the
      // first entry, so an empty list is a client that cannot start a flow.
      if (!isNonEmptyArrayOfStrings(json.authorization_servers)) {
        problems.push("no `authorization_servers`");
      }
      if (!isNonEmptyArrayOfStrings(json.scopes_supported)) {
        problems.push("no `scopes_supported`");
      }
      return problems;
    },
  },
  {
    name: "authorization-server metadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    check({ status, body }) {
      const problems = [];
      if (status !== 200) return [`expected 200, got ${status}`];
      const { json, problem } = asJson(body);
      if (problem) return [problem];
      for (const field of [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
      ]) {
        if (!isNonEmptyString(json[field])) problems.push(`no \`${field}\``);
      }
      // A client MUST refuse to proceed when this is absent, because absence
      // means the server does not support PKCE. Losing it breaks every
      // connection while both metadata documents still return a healthy 200 —
      // which is precisely why it is asserted rather than assumed.
      const pkce = json.code_challenge_methods_supported;
      if (!Array.isArray(pkce) || !pkce.includes("S256")) {
        problems.push("`code_challenge_methods_supported` does not offer S256");
      }
      return problems;
    },
  },
  {
    name: "unauthenticated MCP route",
    method: "POST",
    path: "/mcp",
    // A JSON-RPC initialize, so the route is reached the way a client reaches
    // it. It must never get past the auth boundary, and carries nothing.
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    check({ status, headers }) {
      // Not `!== 401`: an unauthenticated 2xx is a security regression, and
      // saying so in its own sentence keeps it from reading as a plain outage.
      if (status >= 200 && status < 300) {
        return [
          `answered ${status} to an unauthenticated request — ` +
            "the MCP route must challenge, never serve",
        ];
      }
      if (status !== 401) return [`expected a 401 challenge, got ${status}`];
      const challenge = headers.get("www-authenticate") || "";
      const problems = [];
      if (!/bearer/i.test(challenge)) {
        problems.push("401 carries no `Bearer` WWW-Authenticate challenge");
      }
      // Without this pointer a client cannot find the metadata document and
      // discovery dead-ends, so a 401 alone is not a healthy 401.
      if (!/resource_metadata=/i.test(challenge)) {
        problems.push("challenge does not point at `resource_metadata`");
      }
      return problems;
    },
  },
];

/**
 * Turn probe results into problems.
 *
 * Pure, so the assertions can be tested without a network. `results` entries
 * are `{ name, error }` or `{ name, status, headers, body }`.
 */
export function evaluate(results) {
  const problems = [];
  // "Nothing matched" must never read as "all well" — the failure mode every
  // guard in this repository is written against.
  if (!Array.isArray(results) || results.length === 0) {
    return ["no probe ran at all"];
  }
  for (const spec of PROBES) {
    const result = results.find((r) => r.name === spec.name);
    if (!result) {
      problems.push(`${spec.name}: did not run`);
      continue;
    }
    if (result.error) {
      problems.push(`${spec.name}: ${result.error}`);
      continue;
    }
    for (const problem of spec.check(result)) problems.push(`${spec.name}: ${problem}`);
  }
  return problems;
}

/** Run one probe, turning any transport failure into a reportable result. */
async function runProbe(origin, spec) {
  const url = `${origin}${spec.path}`;
  try {
    const response = await fetch(url, {
      method: spec.method,
      headers: spec.body
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      body: spec.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      name: spec.name,
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS}ms` : error?.message;
    return { name: spec.name, error: `${spec.method} ${spec.path} failed — ${reason}` };
  }
}

/* --------------------------------- self-test ------------------------------ */

/** Minimal stand-in for the one header the probes read. */
function headersOf(object = {}) {
  return new Headers(object);
}

const HEALTHY = () => [
  {
    name: "protected-resource metadata",
    status: 200,
    headers: headersOf(),
    body: JSON.stringify({
      resource: "https://example.test/mcp",
      authorization_servers: ["https://example.test"],
      scopes_supported: ["context:read"],
      resource_name: "Context",
    }),
  },
  {
    name: "authorization-server metadata",
    status: 200,
    headers: headersOf(),
    body: JSON.stringify({
      issuer: "https://example.test",
      authorization_endpoint: "https://example.test/oauth/authorize",
      token_endpoint: "https://example.test/oauth/token",
      registration_endpoint: "https://example.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
    }),
  },
  {
    name: "unauthenticated MCP route",
    status: 401,
    headers: headersOf({
      "WWW-Authenticate": 'Bearer resource_metadata="https://example.test/.well-known/x"',
    }),
    body: "",
  },
];

/** Replace one probe's result, leaving the other two healthy. */
function withResult(name, patch) {
  return HEALTHY().map((r) => (r.name === name ? { ...r, ...patch } : r));
}

function selfTest() {
  const cases = [];
  const expectClean = (label, results) =>
    cases.push({ label, results, want: 0 });
  const expectCaught = (label, results, matching) =>
    cases.push({ label, results, want: 1, matching });

  expectClean("a healthy gateway", HEALTHY());

  // Each sabotage below is a real regression this has to survive.
  expectCaught("no probe ran", [], /no probe ran/);
  expectCaught(
    "a probe missing from the results",
    HEALTHY().filter((r) => r.name !== "unauthenticated MCP route"),
    /did not run/
  );
  expectCaught(
    "the host is unreachable",
    withResult("protected-resource metadata", {
      status: undefined,
      body: undefined,
      error: "GET /… failed — connect ECONNREFUSED",
    }),
    /ECONNREFUSED/
  );
  expectCaught(
    "a 5xx where a document belongs",
    withResult("authorization-server metadata", { status: 502, body: "" }),
    /expected 200, got 502/
  );
  expectCaught(
    "a 200 serving an error page",
    withResult("protected-resource metadata", {
      body: "<!doctype html><title>Origin unreachable</title>",
    }),
    /not JSON/
  );
  expectCaught(
    "a 200 serving a JSON array",
    withResult("protected-resource metadata", { body: "[]" }),
    /not a JSON object/
  );
  expectCaught(
    "metadata that lost its authorization server",
    withResult("protected-resource metadata", {
      body: JSON.stringify({ resource: "https://example.test/mcp", scopes_supported: ["a"] }),
    }),
    /authorization_servers/
  );
  expectCaught(
    "an empty authorization-server list",
    withResult("protected-resource metadata", {
      body: JSON.stringify({
        resource: "https://example.test/mcp",
        authorization_servers: [],
        scopes_supported: ["a"],
      }),
    }),
    /authorization_servers/
  );
  expectCaught(
    "PKCE quietly dropped",
    withResult("authorization-server metadata", {
      body: JSON.stringify({
        issuer: "https://example.test",
        authorization_endpoint: "https://example.test/oauth/authorize",
        token_endpoint: "https://example.test/oauth/token",
        registration_endpoint: "https://example.test/oauth/register",
        code_challenge_methods_supported: ["plain"],
      }),
    }),
    /S256/
  );
  expectCaught(
    "the token endpoint gone from the document",
    withResult("authorization-server metadata", {
      body: JSON.stringify({
        issuer: "https://example.test",
        authorization_endpoint: "https://example.test/oauth/authorize",
        registration_endpoint: "https://example.test/oauth/register",
        code_challenge_methods_supported: ["S256"],
      }),
    }),
    /token_endpoint/
  );
  expectCaught(
    "the MCP route serving an unauthenticated caller",
    withResult("unauthenticated MCP route", { status: 200 }),
    /must challenge, never serve/
  );
  expectCaught(
    "a 401 with no challenge header",
    withResult("unauthenticated MCP route", { headers: headersOf() }),
    /no `Bearer`/
  );
  expectCaught(
    "a challenge that dead-ends discovery",
    withResult("unauthenticated MCP route", { headers: headersOf({ "WWW-Authenticate": "Bearer" }) }),
    /resource_metadata/
  );
  expectCaught(
    "the route 404ing after a bad route change",
    withResult("unauthenticated MCP route", { status: 404 }),
    /expected a 401 challenge, got 404/
  );

  let failures = 0;
  for (const { label, results, want, matching } of cases) {
    const problems = evaluate(results);
    const enough = want === 0 ? problems.length === 0 : problems.length >= want;
    const matched = !matching || problems.some((p) => matching.test(p));
    if (enough && matched) {
      console.log(`  ok   ${label}`);
      continue;
    }
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       problems: ${JSON.stringify(problems)}`);
    if (matching) console.error(`       expected one matching ${matching}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${cases.length} self-test cases failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} self-test cases held.`);
}

/* ----------------------------------- main --------------------------------- */

function resolveOrigin(argv) {
  const index = argv.indexOf("--origin");
  if (index === -1) return DEFAULT_ORIGIN;
  const value = argv[index + 1];
  if (!isNonEmptyString(value)) {
    console.error("--origin needs a value, e.g. --origin https://context.lc");
    process.exit(2);
  }
  return value.replace(/\/+$/, "");
}

async function main() {
  const argv = process.argv.slice(2);

  // An unrecognised flag exits rather than falling through to the default
  // thing — the same reason `check-workflow-shell.mjs` refuses one. A typo'd
  // `--selftest` that probed production would be a confusing kind of green.
  const known = new Set(["--self-test", "--origin"]);
  for (const arg of argv) {
    if (arg.startsWith("--") && !known.has(arg)) {
      console.error(`Unrecognised flag: ${arg}`);
      process.exit(2);
    }
  }

  if (argv.includes("--self-test")) {
    console.log("Self-testing the gateway health assertions:\n");
    selfTest();
    return;
  }

  const origin = resolveOrigin(argv);
  console.log(`Probing ${origin}\n`);

  const results = [];
  for (const spec of PROBES) {
    const result = await runProbe(origin, spec);
    const shown = result.error ? "unreachable" : `HTTP ${result.status}`;
    console.log(`  ${spec.method.padEnd(4)} ${spec.path} → ${shown}`);
    results.push(result);
  }

  const problems = evaluate(results);
  if (problems.length === 0) {
    console.log(`\nThe gateway is answering, and answering correctly.`);
    return;
  }

  console.error(`\nThe gateway is not healthy:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

await main();
