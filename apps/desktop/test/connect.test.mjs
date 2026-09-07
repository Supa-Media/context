/**
 * How this machine gets a grant — the whole of it, against a real loopback.
 *
 * `main/connect.ts` is the app's credential-acquisition path, and CLAUDE.md is
 * explicit that auth and credential storage get "a test proving the attack
 * fails" rather than a reading. It had none: the module imported `electron` at
 * the top, so no suite on plain Node could load it, and sabotaging its state
 * comparison failed nothing anywhere in this repository. The Electron import is
 * lazy now (see that file's header) and this is the check that was missing.
 *
 * The authorization server is a `fetchImpl`; the browser is a function that
 * fetches the loopback redirect. Everything in between is the real
 * `packages/hook` flow and a real `http` server on `127.0.0.1`, so what is
 * asserted here is what happens on a laptop.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `stateMatches(...)` swapped for `true` (the attack this file exists for)   3
 *   `DESKTOP_SCOPE` narrowed to `context:write`                               2
 *   the endpoint's `credentialUrlOk` check removed                            2
 *   the loopback listener left open after the first callback                  1
 *
 * Before the lazy Electron import, every one of those was **zero** — nothing in
 * this repository loaded this module.
 *
 * The listener sabotage is the one worth a sentence: it takes removing *both*
 * closes, `oauth.js`'s own and `connectMachine`'s `finally`, because either one
 * alone still shuts the socket. Removing one at a time fails nothing, which is
 * what a belt and braces looks like from a test — so the check asserts the
 * property (nothing is listening afterwards) rather than either line.
 */

import { connectMachine, DESKTOP_SCOPE } from "../src/main/connect.ts";

const ENDPOINT = "https://gateway.example.test/mcp";
const ORIGIN = "https://gateway.example.test";

/** A conformant authorization server, and a log of what was asked of it. */
function authorizationServer({ tokenScope = DESKTOP_SCOPE } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return jsonResponse({ resource: ENDPOINT, authorization_servers: [ORIGIN] });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource")) return notFound();
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
      });
    }
    if (url === `${ORIGIN}/oauth/register`) {
      return jsonResponse({ client_id: "client-for-this-machine" });
    }
    if (url === `${ORIGIN}/oauth/token`) {
      return jsonResponse({
        access_token: "fake-access-token-not-a-real-one",
        refresh_token: "fake-refresh-token-not-a-real-one",
        expires_in: 3600,
        scope: tokenScope,
      });
    }
    return notFound();
  };
  return { fetchImpl, calls, of: (path) => calls.filter((call) => call.url === `${ORIGIN}${path}`) };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function notFound() {
  return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
}

/**
 * The browser, as a function.
 *
 * `state` is whatever this hands back to the listener, so a test can return
 * somebody else's — which is the whole of what the state parameter is for.
 */
function browser({ state: override, code = "an-authorization-code" } = {}) {
  const seen = {};
  return {
    seen,
    open: async (href) => {
      const url = new URL(href);
      seen.href = href;
      seen.scope = url.searchParams.get("scope");
      seen.challenge = url.searchParams.get("code_challenge");
      seen.method = url.searchParams.get("code_challenge_method");
      seen.redirectUri = url.searchParams.get("redirect_uri");
      seen.state = url.searchParams.get("state");
      const callback = new URL(seen.redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", override ?? seen.state);
      const answer = await fetch(callback.href);
      seen.callbackStatus = answer.status;
      await answer.text();
    },
  };
}

async function refused(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

export async function runConnectChecks(check) {
  // -- the happy path, and what it asked for --------------------------------
  const server = authorizationServer();
  const good = browser();
  const record = await connectMachine({
    endpoint: ENDPOINT,
    fetchImpl: server.fetchImpl,
    openBrowser: good.open,
  });

  check("connecting a machine yields a credential", record.accessToken === "fake-access-token-not-a-real-one");
  check("...and the refresh token that renews it", record.refreshToken === "fake-refresh-token-not-a-real-one");
  check(
    "the base URL requests go to is stored WITH the credential, so a token cannot be posted elsewhere",
    record.gatewayBaseUrl === ORIGIN && record.endpoint === ENDPOINT,
  );
  check("this machine is registered as its own client", record.clientId === "client-for-this-machine");

  check(
    "THE SCOPE ASKED FOR IS WRITE AND PRIVATE — a narrower one files every meeting as team",
    good.seen.scope === "context:write context:private" && DESKTOP_SCOPE === "context:write context:private",
  );
  check("...and it never asks to read the context", !good.seen.scope.includes("context:read"));
  const registration = JSON.parse(server.of("/oauth/register")[0].init.body);
  // Spelled out rather than compared to `DESKTOP_SCOPE`: a check that reads the
  // constant it is guarding passes whatever the constant is changed to.
  check(
    "the client is registered for the same scope it then asks for",
    registration.scope === "context:write context:private" && registration.scope === good.seen.scope,
  );
  check("...as a public client with no secret", registration.token_endpoint_auth_method === "none");

  check("PKCE is S256, not plain", good.seen.method === "S256" && typeof good.seen.challenge === "string");
  const exchangeBody = server.of("/oauth/token")[0].init.body;
  const exchange = new URLSearchParams(exchangeBody);
  check("the verifier is what is sent at exchange, and it is not the challenge", exchange.get("code_verifier") !== good.seen.challenge);
  check("...so the challenge never travels twice", !exchangeBody.includes(good.seen.challenge));

  // -- the listener is loopback, and answers once ---------------------------
  const redirect = new URL(good.seen.redirectUri);
  check("the browser is sent back to 127.0.0.1 and nowhere else", redirect.hostname === "127.0.0.1");
  check("...on the path the gateway registered", redirect.pathname === "/context-hook/callback");
  check("...and the port is the OS's, not one anybody could squat first", Number(redirect.port) > 0);

  const replayed = await fetch(good.seen.redirectUri).then(
    () => "answered",
    () => "refused",
  );
  check("THE LISTENER ANSWERS ONCE AND CLOSES, so a code replayed at it has nowhere to land", replayed === "refused");

  // -- the attack: somebody else's code, fed to an open listener -------------
  const attacked = authorizationServer();
  const wrongState = browser({ state: "a-state-this-machine-never-minted" });
  const error = await refused(
    connectMachine({ endpoint: ENDPOINT, fetchImpl: attacked.fetchImpl, openBrowser: wrongState.open }),
  );
  check("A CALLBACK CARRYING THE WRONG STATE IS REFUSED", error !== null);
  check(
    "...with a sentence saying nothing was saved",
    /state/.test(error?.message ?? "") && /nothing was saved/.test(error?.message ?? ""),
  );
  check(
    "...AND THE CODE IS NEVER EXCHANGED, so an injected code buys no grant",
    attacked.of("/oauth/token").length === 0,
  );

  // -- the endpoint itself ---------------------------------------------------
  const plaintext = authorizationServer();
  const overHttp = await refused(
    connectMachine({
      endpoint: "http://gateway.example.test/mcp",
      fetchImpl: plaintext.fetchImpl,
      openBrowser: browser().open,
    }),
  );
  check("A PLAINTEXT GATEWAY IS REFUSED", overHttp !== null);
  check("...before a single request is made to it", plaintext.calls.length === 0);

  const loopbackDev = authorizationServer();
  const localGateway = await refused(
    connectMachine({
      endpoint: "http://127.0.0.1:8787/mcp",
      fetchImpl: loopbackDev.fetchImpl,
      openBrowser: browser().open,
    }),
  );
  check(
    "...but a loopback gateway is not, because that is how a self-hoster runs one locally",
    !/must be https/.test(localGateway?.message ?? ""),
  );

  // -- nothing thrown carries a credential -----------------------------------
  check(
    "no refusal in this flow carries a token",
    [error, overHttp, localGateway].every(
      (thrown) => !String(thrown?.message ?? "").includes("fake-access-token-not-a-real-one"),
    ),
  );
}
