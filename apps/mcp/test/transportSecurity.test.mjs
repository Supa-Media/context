import { check, call, env, accessTokenFor, worker } from "./harness.mjs";

export async function runTransportSecurityChecks() {
  const CONSOLE_ORIGIN = "https://console.context.test";
  const originEnv = { ...env, ALLOWED_ORIGINS: CONSOLE_ORIGIN };
  const noAllowlistEnv = { ...env, ALLOWED_ORIGINS: undefined };

  async function transportRequest(
    originHeader,
    { token = "priv-token", useEnv = originEnv, path = "/mcp", method = "POST" } = {}
  ) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${accessTokenFor(token)}`;
    if (originHeader !== undefined) headers.Origin = originHeader;
    const init = { method, headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ jsonrpc: "2.0", id: 90210, method: "ping", params: {} });
    }
    return worker.fetch(new Request(`https://x${path}`, init), useEnv, { waitUntil() {} });
  }

  /** Everything a caller can observe about a response, as one comparable string. */
  async function fingerprint(response) {
    const headers = [...response.headers]
      .map(([name, value]) => `${name}: ${value}`)
      .sort()
      .join("\n");
    return `${response.status}\n${headers}\n${await response.text()}`;
  }

  const originAllowed = await transportRequest(CONSOLE_ORIGIN);
  const originAllowedBody = await originAllowed.json();
  check("an allowlisted browser origin reaches the transport", originAllowed.status === 200);
  check(
    "an allowlisted origin gets a real MCP answer, not merely a status",
    originAllowedBody.id === 90210 && originAllowedBody.result !== undefined
  );
  check(
    "a disallowed browser origin is refused",
    (await transportRequest("https://evil.example")).status === 403
  );

  /*
   * The absent-Origin cases.
   *
   * Every non-browser MCP client — Claude Desktop, Codex CLI, ChatGPT — sends no
   * Origin header at all. Absence is not an attack signal, and refusing it is the
   * one mistake here that breaks every real client at once while looking like a
   * tightening.
   *
   * These exist because the behaviour was correct and *unpinned*: inverting
   * `originIsAllowed` to refuse an absent header failed zero checks. Every other
   * origin rule had a test; this one did not, so the regression that costs the
   * most was the only one CI would have missed.
   */
  const originAbsent = await transportRequest(undefined);
  check(
    "a request with no Origin header reaches the transport",
    originAbsent.status === 200
  );
  check(
    "a non-browser client gets a real MCP answer, not merely a status",
    (await originAbsent.json()).id === 90210
  );
  check(
    "no Origin is still accepted when an allowlist IS configured",
    (await transportRequest(undefined, { useEnv: originEnv })).status === 200
  );
  check(
    "no Origin is still accepted when no allowlist is configured",
    (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
  );
  check(
    "absence and empty-string are treated differently — empty is a browser saying nothing",
    (await transportRequest(undefined)).status === 200 &&
      (await transportRequest("")).status === 403
  );
  check(
    "the /inbox path also accepts a headerless client",
    (await transportRequest(undefined, { path: "/inbox" })).status !== 403
  );
  check(
    "a refused origin is told why, without an auth challenge to retry against",
    await (async () => {
      const res = await transportRequest("https://evil.example");
      const body = await res.json();
      return (
        // The spec is specific about this one thing: if a 403 carries a body it
        // must be a JSON-RPC error response with no `id`.
        body.jsonrpc === "2.0" &&
        body.id === null &&
        typeof body.error?.code === "number" &&
        body.result === undefined &&
        !res.headers.has("WWW-Authenticate") &&
        // No CORS header either: the browser should not get to read the refusal.
        !res.headers.has("Access-Control-Allow-Origin")
      );
    })()
  );

  // Rule 1: absence is not an attack signal. Claude Desktop, Codex CLI and the
  // SDKs send no Origin at all; if this check ever fails, every client is down.
  check(
    "a request with no Origin still works (non-browser clients send none)",
    (await transportRequest(undefined)).status === 200
  );
  check(
    "a request with no Origin works even with nothing allowlisted",
    (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
  );
  check(
    "an unconfigured allowlist still refuses a browser origin",
    (await transportRequest("https://evil.example", { useEnv: noAllowlistEnv })).status === 403
  );

  // Rule 2: `null` is present-and-untrusted, not absent. A sandboxed iframe is
  // the one-line bypass this exists to close.
  check(
    "the null origin is refused, not treated as absent",
    (await transportRequest("null")).status === 403
  );
  check(
    "an opaque file:// origin is refused",
    (await transportRequest("file://")).status === 403
  );
  // `new URL("file:///x").origin` is the *string* "null", so an operator who put
  // an opaque scheme in the allowlist would otherwise authorize every sandboxed
  // iframe and local file on the internet at once. Both sides of the comparison
  // have to refuse it. (Found by sabotage: refusing it only on the header side
  // left this open and every other check stayed green.)
  check(
    "an opaque allowlist entry authorizes nothing",
    (
      await transportRequest("file://", { useEnv: { ...env, ALLOWED_ORIGINS: "file:///" } })
    ).status === 403
  );
  check(
    "an opaque allowlist entry does not authorize the null origin either",
    (
      await transportRequest("null", { useEnv: { ...env, ALLOWED_ORIGINS: "file:///" } })
    ).status === 403
  );
  check(
    "an empty Origin header is refused rather than read as absent",
    (await transportRequest("")).status === 403
  );
  check(
    "an Origin that is not a URL at all is refused",
    (await transportRequest("console.context.test")).status === 403
  );

  // Rule 3: exact — scheme, host, port. Every one of these is a real attack
  // shape against a check written with startsWith/endsWith/includes.
  check(
    "a scheme downgrade does not match an https allowlist entry",
    (await transportRequest("http://console.context.test")).status === 403
  );
  check(
    "a different port is a different origin",
    (await transportRequest("https://console.context.test:8443")).status === 403
  );
  check(
    "the default port is not a different origin",
    (await transportRequest("https://console.context.test:443")).status === 200
  );
  check(
    "suffix confusion is refused (https://context.lc.evil.com)",
    (await transportRequest("https://console.context.test.evil.com")).status === 403
  );
  check(
    "an allowed origin's name buried in a hostile URL's path is refused",
    (await transportRequest("https://evil.example/console.context.test")).status === 403
  );
  check(
    "a prefix of an allowed origin is refused",
    (await transportRequest("https://console.context.tes")).status === 403
  );
  check(
    "an unlisted subdomain of an allowed origin is refused",
    (await transportRequest("https://staging.console.context.test")).status === 403
  );
  check(
    "the parent domain of an allowed origin is refused",
    (await transportRequest("https://context.test")).status === 403
  );
  check(
    "a trailing-dot host is a different origin and is refused",
    (await transportRequest("https://console.context.test.")).status === 403
  );
  // Scheme and host are case-insensitive per RFC 6454, so this must be ACCEPTED.
  // Getting it backwards would look like hardening and would break a client.
  check(
    "case differences in scheme and host still match",
    (await transportRequest("HTTPS://CONSOLE.CONTEXT.TEST")).status === 200
  );
  check(
    "an allowlist entry written in mixed case matches a lowercase browser origin",
    (
      await transportRequest(CONSOLE_ORIGIN, {
        useEnv: { ...env, ALLOWED_ORIGINS: "HTTPS://Console.Context.TEST" },
      })
    ).status === 200
  );

  // No wildcards, configured or otherwise. `https://*.console.context.test`
  // parses, so it lands in the allowlist as a host literally named `*.…` — which
  // no browser can send. Inert, and asserted to stay that way.
  check(
    "a wildcard allowlist entry grants no subdomain",
    (
      await transportRequest("https://app.console.context.test", {
        useEnv: { ...env, ALLOWED_ORIGINS: "https://*.console.context.test" },
      })
    ).status === 403
  );
  check(
    "a bare * in the allowlist grants nothing",
    (
      await transportRequest("https://evil.example", {
        useEnv: { ...env, ALLOWED_ORIGINS: "*" },
      })
    ).status === 403
  );
  check(
    "a malformed allowlist entry is dropped without taking the good ones with it",
    (
      await transportRequest(CONSOLE_ORIGIN, {
        useEnv: { ...env, ALLOWED_ORIGINS: `not-a-url, ${CONSOLE_ORIGIN} ,,` },
      })
    ).status === 200
  );
  // The self-origin is whatever the deployment DECLARED, never whatever `Host`
  // the caller claimed. With no `PUBLIC_ORIGIN` there is no declared origin, so
  // there is no self to allow — which is what "unconfigured means non-browser
  // clients only" has always claimed and did not do. Before this, `publicOrigin`
  // fell back to the request's own `Host`, so the allowlist became a function of
  // attacker input in exactly the rebinding case the file exists to stop: a page
  // sending `Host: x` and `Origin: https://x` matched itself.
  check(
    "with no PUBLIC_ORIGIN, a browser origin matching the claimed Host is refused",
    (await transportRequest("https://x", { useEnv: noAllowlistEnv })).status === 403
  );
  check(
    "a declared PUBLIC_ORIGIN is still permitted without being listed",
    (
      await transportRequest("https://x", {
        useEnv: { ...noAllowlistEnv, PUBLIC_ORIGIN: "https://x" },
      })
    ).status === 200
  );
  // Named for what it actually asserts. It was "a claimed Host cannot smuggle
  // itself past a declared PUBLIC_ORIGIN", which passes against the pre-fix code
  // too — `publicOrigin()` always preferred `env.PUBLIC_ORIGIN` when one was set,
  // so the `Host` fallback this change removes was never reached on this path.
  // The check above it is the one that fails on revert; a name promising more
  // than the assertion delivers is how a guard comes to look covered.
  check(
    "a declared PUBLIC_ORIGIN admits itself and nothing else",
    (
      await transportRequest("https://x", {
        useEnv: { ...noAllowlistEnv, PUBLIC_ORIGIN: "https://mcp.context.test" },
      })
    ).status === 403
  );
  check(
    "tightening the self-origin leaves non-browser clients alone",
    (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
  );

  // -- the top-level catch
  //
  // The guard `index.js` grew for the two throws that reached the runtime as a
  // bodyless 1101. Untested it is an assertion in a comment: deleting the whole
  // `try`/`catch` left all 457 checks green, which is precisely the shape this
  // repo's "a guard nobody has checked is not a guard" rule names.
  //
  // `env` is a proxy that throws on first touch, so the throw originates inside
  // `route()` rather than being handed to the catch directly.
  const throwingEnv = new Proxy(
    {},
    {
      get() {
        throw new TypeError("secret-bucket-key-abc123 not readable");
      },
    }
  );
  const loggedLines = [];
  const realConsoleError = console.error;
  console.error = (...parts) => loggedLines.push(parts.join(" "));
  // Caught here, not left to propagate. Removing the guard makes `fetch` throw,
  // and an uncaught throw at this line kills the process — exit 1, zero FAIL,
  // which is the "looks like detection and is the opposite" shape the header of
  // this file warns about. A null response turns it into four named failures.
  let caughtRes = null;
  try {
    caughtRes = await worker.fetch(new Request("https://x/mcp", { method: "POST" }), throwingEnv, {
      waitUntil() {},
    });
  } catch {
    caughtRes = null;
  } finally {
    console.error = realConsoleError;
  }
  check("an unhandled throw becomes a 500, not a dead request", caughtRes?.status === 500);
  const caughtBody = caughtRes ? await caughtRes.text() : "";
  check("the 500 says nothing about what threw", caughtBody === '{"error":"server_error"}');
  check(
    "and the thrown message reaches neither body nor headers",
    caughtRes !== null &&
      !caughtBody.includes("secret-bucket-key-abc123") &&
      ![...caughtRes.headers.values()].some((v) => v.includes("secret-bucket-key-abc123"))
  );
  // Catching removes the throw from Cloudflare's exception stream, and this
  // Worker logs nowhere else. A silent catch would trade a dead request for an
  // invisible one.
  check(
    "the operator gets the error class, and only the class",
    loggedLines.length === 1 &&
      loggedLines[0].includes("TypeError") &&
      !loggedLines[0].includes("secret-bucket-key-abc123")
  );

  // The log line must not be able to defeat the catch it lives in. Both cases
  // need our own code to throw a non-Error, which nothing does today — every
  // `throw` in `src/` raises an `Error` subclass. That is a fact about code
  // somebody will edit, so it is asserted rather than audited.
  async function fetchThrowing(thrown) {
    const lines = [];
    const real = console.error;
    console.error = (...parts) => lines.push(parts.join(" "));
    let res = null;
    try {
      res = await worker.fetch(
        new Request("https://x/mcp", { method: "POST" }),
        new Proxy({}, { get() { throw thrown; } }),
        { waitUntil() {} }
      );
    } catch {
      res = null;
    } finally {
      console.error = real;
    }
    return { status: res?.status ?? null, logged: lines.join(" | ") };
  }

  // A plain object carrying its own `constructor.name` — read unguarded, that
  // name is printed verbatim, and it is whatever the thrower put there.
  const forgedClass = await fetchThrowing({
    constructor: { name: "secret-bucket-key-abc123" },
    name: "secret-bucket-key-abc123",
  });
  check("a thrown non-Error cannot name its own class in the log", forgedClass.status === 500);
  check(
    "and nothing it carries is printed",
    !forgedClass.logged.includes("secret-bucket-key-abc123") && forgedClass.logged.includes("object")
  );

  // Reading a property can throw. Unguarded that throw escapes `fetch` and the
  // request dies as a bodyless 1101 — the guard undone by the input it is for.
  const hostileGetter = await fetchThrowing(
    new Proxy(new TypeError("boom"), {
      get(target, prop) {
        if (prop === "name" || prop === "constructor") throw new Error("nope");
        return Reflect.get(target, prop);
      },
    })
  );
  check("a throw while reading the error still answers 500", hostileGetter.status === 500);

  // A thrown string, number, null: no class to read at all.
  for (const [label, thrown] of [
    ["a string", "secret-bucket-key-abc123"],
    ["null", null],
  ]) {
    const res = await fetchThrowing(thrown);
    check(
      `a thrown ${label} still answers 500 and logs nothing of it`,
      res.status === 500 && !res.logged.includes("secret-bucket-key-abc123")
    );
  }

  // The refusal must not become the oracle the rest of the gateway avoids being.
  const refusalFingerprints = await Promise.all([
    transportRequest("https://evil.example").then(fingerprint),
    transportRequest("https://evil.example", { token: null }).then(fingerprint),
    transportRequest("https://evil.example", { token: "cat_not_a_real_token_00000000000000" }).then(
      fingerprint
    ),
    transportRequest("https://evil.example", { token: "readonly-token" }).then(fingerprint),
    transportRequest("https://evil.example", { path: "/@primary/mcp" }).then(fingerprint),
    transportRequest("https://evil.example", { path: "/@nobody-has-this-name/mcp" }).then(fingerprint),
  ]);
  check(
    "the origin refusal is byte-identical whatever the token or workspace",
    new Set(refusalFingerprints).size === 1
  );
  check(
    "a bad origin is refused as a bad origin, never as an auth failure",
    (await transportRequest("https://evil.example", { token: null })).status === 403
  );

  // Coverage of the transport's other spellings and its neighbour.
  check(
    "the token-in-path transport form is guarded too",
    (
      await transportRequest("https://evil.example", {
        token: null,
        path: `/t/${accessTokenFor("priv-token")}/mcp`,
      })
    ).status === 403
  );
  check(
    "the capture endpoint is guarded too",
    (
      await transportRequest("https://evil.example", { token: "inbox-token", path: "/inbox" })
    ).status === 403
  );
  check(
    "the capture endpoint still serves a client that sends no Origin",
    (await transportRequest(undefined, { token: "inbox-token", path: "/inbox" })).status !== 403
  );

  // The preflight is refused on the same terms as the request it precedes —
  // otherwise the browser is told the call is permitted and then it isn't.
  check(
    "a preflight from a disallowed origin is refused",
    (await transportRequest("https://evil.example", { method: "OPTIONS", token: null })).status === 403
  );
  check(
    "a preflight from an allowed origin succeeds",
    (await transportRequest(CONSOLE_ORIGIN, { method: "OPTIONS", token: null })).status === 204
  );
  check(
    "a preflight for a non-transport path is unaffected",
    (
      await transportRequest("https://evil.example", {
        method: "OPTIONS",
        token: null,
        path: "/.well-known/oauth-protected-resource",
      })
    ).status === 204
  );
  // Discovery is public, unauthenticated, and fetched cross-origin by browser
  // clients before they hold any credential. Guarding it would break the flow it
  // exists to start, and it exposes nothing.
  check(
    "discovery documents stay reachable from any origin",
    (
      await worker.fetch(
        new Request("https://x/.well-known/oauth-protected-resource", {
          headers: { Origin: "https://evil.example" },
        }),
        originEnv,
        { waitUntil() {} }
      )
    ).status === 200
  );


}
