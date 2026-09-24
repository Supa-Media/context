/**
 * The package's publish scope, the stub server/temp-dir setup shared by every
 * later file, transport security (no credential ever crosses the network in
 * the clear) and the transcript-to-markdown capture boundary. See `test.mjs`
 * for the suite's overall shape and the sabotage record.
 */

import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as commands from "../src/commands.js";
import { transcriptToMarkdown, messageFromEntry } from "../src/transcript.js";
import { discover } from "../src/oauth.js";
import { credentialEndpointKey } from "../src/config.js";

import { check, startStubServer, SECRETS, TRANSCRIPT } from "./harness.mjs";

export async function runSetupAndTransportChecks(ctx) {
  /**
   * This org publishes exactly one npm scope, `@supa-media`, through
   * `supa-framework`'s own pipeline — see docs/decisions/repository-and-review.md,
   * "Every package this org publishes is `@supa-media/*`, through the
   * framework's pipeline". A product-specific scope (this package's own name,
   * for one PR, before anyone asked) is the simplification that section names
   * and the cost it names for reversing it. This is the test that fails if it
   * is reversed: rename the package back to `@context-lc/hook`, or to any
   * other scope, and this is red — in the same suite `prepublishOnly` runs
   * before every publish, not silently in a registry nobody checks until an
   * install breaks.
   */
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  check(
    "the package publishes under the org's one npm scope, @supa-media",
    pkg.name.startsWith("@supa-media/")
  );

  /* ---------------------------------- run ---------------------------------- */

  const server = await startStubServer();
  const home = await mkdtemp(join(tmpdir(), "context-hook-"));
  const configPath = join(home, "hook.json");
  const settingsPath = join(home, "claude-settings.json");
  process.env.CONTEXT_HOOK_CLAUDE_SETTINGS = settingsPath;

  const said = [];
  const log = (line = "") => said.push(String(line));

  ctx.server = server;
  ctx.home = home;
  ctx.configPath = configPath;
  ctx.settingsPath = settingsPath;
  ctx.said = said;
  ctx.log = log;

  // -- what leaves the machine

  // -- an authorization server may not arrive over plain http
  //
  // `discover` follows RFC 9728: the resource names the authorization server,
  // and that server's metadata names where the code and the token go. Every one
  // of those is a string off the wire, and the credential at the end of it is
  // the one that sits unattended on a laptop. Loopback stays permitted — the
  // suite's own stub is `http://127.0.0.1`, and RFC 8252 carves it out — but a
  // routable `http://` host means the code and the PKCE verifier cross the
  // network in the clear.
  const discoveryError = async (servers, metadata) => {
    const fetchImpl = async (target) =>
      String(target).includes("oauth-protected-resource")
        ? { ok: true, json: async () => ({ resource: "https://ctx.example/mcp", authorization_servers: servers }) }
        : { ok: true, json: async () => metadata };
    return discover("https://ctx.example/mcp", { fetchImpl }).then(
      () => null,
      (error) => error
    );
  };
  const discoveryResult = async (metadata) => {
    const fetchImpl = async (target) =>
      String(target).includes("oauth-protected-resource")
        ? { ok: true, json: async () => ({ resource: "https://ctx.example/mcp", authorization_servers: ["https://ctx.example"] }) }
        : { ok: true, json: async () => metadata };
    return discover("https://ctx.example/mcp", { fetchImpl });
  };
  const httpsMeta = (origin) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
  });
  // The metadata here is entirely https, so ONLY the issuer check can refuse
  // this. Written with http endpoints too, the endpoint check caught it and the
  // issuer check could be deleted with the suite still green.
  // -- the endpoint the PERSON hands in is a credential URL too
  //
  // The checks below cover what DISCOVERY names. They do not cover the endpoint
  // discovery starts from, and that is the one the access token is sent to on
  // every capture: `capture` POSTs `Authorization: Bearer <token>` to
  // `new URL("/inbox", endpoint)`. It usually gets there without touching
  // `discover` at all — `accessTokenFor` returns a cached, unexpired token
  // before the discovery call — so a check living only in `discover` would miss
  // the common path. `endpointKey` is the choke point instead: save, load,
  // forget and the not-signed-in message all resolve through it.
  const endpointRefused = (value) => {
    try {
      credentialEndpointKey(value);
      return false;
    } catch {
      return true;
    }
  };
  // THE PLACEMENT IS THE CLAIM, AND THE THREE CHECKS BELOW DO NOT PROVE IT.
  // They exercise the predicate directly. What this fix actually asserts is that
  // the credential-bearing paths RESOLVE THROUGH it — and that is enforced only
  // by call-graph structure, so a `loadEndpoint` that canonicalises inline
  // instead of calling the guarded key passes every one of them while the token
  // goes out in the clear. This drives the real path end to end, and asserts the
  // shape that matters: refused AND zero network calls, because a refusal after
  // the POST would be worthless.
  {
    const httpEndpoint = "http://evil.example/mcp";
    const leakHome = await mkdtemp(join(tmpdir(), "context-hook-http-"));
    const leakConfig = join(leakHome, "hook.json");
    await writeFile(
      leakConfig,
      JSON.stringify({
        endpoints: {
          [httpEndpoint]: { accessToken: "SECRET-TOKEN", expiresAt: Date.now() + 3_600_000 },
        },
      }),
      "utf8"
    );
    const seen = [];
    const recordingFetch = async (target, init) => {
      seen.push({ target: String(target), auth: init?.headers?.Authorization || null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const transcript = join(leakHome, "t.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), "utf8");
    let refused = false;
    try {
      await commands.capture({
        endpoint: httpEndpoint,
        configPath: leakConfig,
        stdin: [JSON.stringify({ transcript_path: transcript })],
        fetchImpl: recordingFetch,
        log: () => {},
      });
    } catch {
      refused = true;
    }
    check(
      "capture refuses an http endpoint without putting the token on the wire",
      refused && seen.length === 0
    );
  }

  // `authorize` checks before it discovers, and only a CALL COUNT can see that:
  // remove the guard and install still refuses — `loadEndpoint` and the metadata
  // checks both backstop it — but only after two cleartext `.well-known`
  // requests have told a passive observer that this machine is installing
  // against that endpoint. No token is involved in any variant, which is why
  // this is metadata rather than credential; it is asserted because otherwise
  // nothing at all notices the line going away.
  {
    const seen = [];
    let refused = false;
    try {
      await commands.authorize({
        endpoint: "http://evil.example/mcp",
        configPath: join(home, "unused.json"),
        fetchImpl: async (target) => {
          seen.push(String(target));
          return { ok: false, status: 404, json: async () => ({}) };
        },
        log: () => {},
      });
    } catch {
      refused = true;
    }
    check(
      "install refuses an http endpoint before it makes any request at all",
      refused && seen.length === 0
    );
  }

  check(
    "a plain-http endpoint is refused before a token can ever be sent to it",
    endpointRefused("http://evil.example/mcp")
  );
  check("an https endpoint is accepted", !endpointRefused("https://ctx.example/mcp"));
  check(
    "and a loopback endpoint is accepted, because self-hosting runs on it",
    !endpointRefused("http://127.0.0.1:8787/mcp")
  );

  check(
    "a routable http authorization server is refused",
    Boolean(await discoveryError(["http://evil.example"], httpsMeta("https://ctx.example")))
  );
  // The carve-out is by resolved HOST, not by substring. This hostname is
  // routable and merely contains the loopback digits; a `includes("127.0.0.1")`
  // carve-out accepts it, and nothing else in this file would notice.
  check(
    "a routable host that merely contains the loopback address is refused",
    Boolean(
      await discoveryError(
        ["http://127.0.0.1.evil.example"],
        httpsMeta("https://ctx.example")
      )
    )
  );
  // One assertion per endpoint, because a loop that checks N keys is proven by
  // N assertions and not by one: with only the token case, `authorization_endpoint`
  // could be dropped from the walk and the whole suite stayed green.
  check(
    "an https server that names an http authorization endpoint is refused",
    Boolean(
      await discoveryError(["https://ctx.example"], {
        ...httpsMeta("https://ctx.example"),
        authorization_endpoint: "http://evil.example/oauth/authorize",
      })
    )
  );
  // Not in the original two-key list, and part of the same walk: `registerClient`
  // POSTs the machine name here and trusts the `client_id` that comes back.
  check(
    "an http registration endpoint is refused too, though it carries no token",
    Boolean(
      await discoveryError(["https://ctx.example"], {
        ...httpsMeta("https://ctx.example"),
        registration_endpoint: "http://evil.example/oauth/register",
      })
    )
  );
  // The carve-out is "http on loopback", not "anything on loopback". Without the
  // protocol gate this passes: the host is fine and the scheme is never checked.
  check(
    "a non-http scheme is refused even on loopback",
    Boolean(
      await discoveryError(["https://ctx.example"], {
        ...httpsMeta("https://ctx.example"),
        token_endpoint: "ftp://127.0.0.1/oauth/token",
      })
    )
  );
  check(
    "an https server that names an http token endpoint is refused",
    Boolean(
      await discoveryError(["https://ctx.example"], {
        ...httpsMeta("https://ctx.example"),
        token_endpoint: "http://evil.example/oauth/token",
      })
    )
  );
  // The scheme loop SKIPS a non-string rather than refusing it, so the refusal
  // has to live elsewhere — and these two pin the two places it lives. Without
  // them, wrapping a URL in brackets walks past every check above: `fetch`
  // stringifies `["http://evil.example/x"]` back into that exact URL.
  check(
    "a non-string token endpoint is refused, not stringified into the credential path",
    Boolean(
      await discoveryError(["https://ctx.example"], {
        ...httpsMeta("https://ctx.example"),
        token_endpoint: ["http://evil.example/oauth/token"],
      })
    )
  );
  check(
    "a non-string registration endpoint never reaches the network",
    (
      await discoveryResult({
        ...httpsMeta("https://ctx.example"),
        registration_endpoint: ["http://evil.example/register"],
      })
    ).registrationEndpoint === null
  );
  check(
    "and loopback http still works, because the carve-out is what self-hosting runs on",
    (await discoveryError(["http://127.0.0.1:8787"], httpsMeta("http://127.0.0.1:8787"))) === null
  );

  const converted = transcriptToMarkdown(TRANSCRIPT);
  check("only user-visible messages survive the transcript", converted.messages === 4);
  check(
    "a turn the person actually typed still travels, origin and all",
    converted.markdown.includes("And keep the tests honest.")
  );
  for (const [name, secret] of Object.entries(SECRETS)) {
    check(`the ${name} never reaches the capture`, !converted.markdown.includes(secret));
  }
  check(
    "what the person did say is kept, on both sides",
    converted.markdown.includes("Rename the orient tool.") &&
      converted.markdown.includes("I will rename it and update the tests.") &&
      converted.markdown.includes("Done — 484 checks pass.")
  );
  check(
    "a half-written last line is skipped rather than failing the capture",
    converted.markdown.includes("Done —")
  );
  check(
    "a tool_result's nested text is not mistaken for a message",
    messageFromEntry({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "x" }] }] },
    }) === null
  );
}
