/**
 * The CSRF `state` defence around the OAuth login, and the scope a client
 * declares when it registers itself. See `test.mjs` for the suite's overall
 * shape and the sabotage record.
 */

import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as commands from "../src/commands.js";
import { createPkce, stateMatches, registerClient, HOOK_SCOPE, ORIENT_SCOPE } from "../src/oauth.js";

import { check } from "./harness.mjs";

export async function runStateAndScopeChecks(ctx) {
  const { server, configPath, log } = ctx;

  // -- state, the CSRF defence
  //
  // The unit checks below pass whether or not anything calls the function, which
  // is how the first version of this file let a sabotage through: `stateMatches`
  // was covered and its *use* was not. So the flow is driven with a browser that
  // comes back with somebody else's state, and the login must fail and leave the
  // stored credential alone.
  const goodRecord = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
  let rejected = null;
  try {
    await commands.authorize({
      endpoint: server.endpoint,
      configPath,
      log,
      openBrowser: async (href) => {
        const url = new URL(href);
        server.state.lastAuthorize = url;
        const code = `code_forged_${server.state.codes.size + 1}`;
        server.state.codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          redirectUri: url.searchParams.get("redirect_uri"),
          scope: url.searchParams.get("scope"),
        });
        const back = new URL(url.searchParams.get("redirect_uri"));
        back.searchParams.set("code", code);
        back.searchParams.set("state", "not-the-state-we-sent");
        await fetch(back.href);
      },
    });
  } catch (error) {
    rejected = error;
  }
  check("a login that comes back with the wrong state is refused", rejected !== null);
  check(
    "and the refusal happens before the code is exchanged",
    rejected !== null && /state/i.test(rejected.message)
  );
  check(
    "a refused login leaves the working credential untouched",
    JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`].refreshToken ===
      goodRecord.refreshToken
  );

  check("a state mismatch is not equal", !stateMatches("abc", "abd"));
  check("a state of a different length is not equal", !stateMatches("abc", "abcd"));
  check("the right state matches", stateMatches("abc", "abc"));
  const pkce = createPkce();
  check("a fresh verifier and challenge differ and are long", pkce.verifier !== pkce.challenge && pkce.verifier.length >= 43);

  /**
   * **A CLIENT MUST DECLARE THE SCOPE IT IS ABOUT TO ASK FOR.**
   *
   * `install` picks `ORIENT_SCOPE` or `HOOK_SCOPE`, refuses to reuse a client
   * registered for the other one, and says why: "re-using a client registered for
   * the narrower one would ask for something it never declared. Widening silently
   * is the thing this whole flow exists to not do."
   *
   * The re-registration it then performs did not carry the scope. `registerClient`
   * named `context:capture` whatever the caller wanted, so an `--orient` install
   * registered a capture-only client and immediately asked it to authorize
   * `context:read` — asking for something it never declared, which is the sentence
   * above.
   *
   * Not an escalation today: the consent screen governs what is granted, and the
   * gateway does not currently refuse an authorize request wider than the client
   * record. It costs the two things that record is for. A person auditing their
   * registered clients — the reason each machine registers its own, so revoking
   * the laptop you lost does not sign out the one on your desk — sees "capture"
   * beside a client that holds read. And the day the gateway does enforce the
   * registered scope, every `--orient` install breaks.
   */
  const registrationScopes = [];
  async function registrationScopeFor(scope) {
    const captured = { scope: null };
    await registerClient(
      { registrationEndpoint: "https://ctx.example/oauth/register" },
      {
        clientName: "Context hook (test)",
        scope,
        fetchImpl: async (_url, init) => {
          captured.scope = JSON.parse(init.body).scope;
          return { ok: true, json: async () => ({ client_id: "cid" }) };
        },
      }
    );
    registrationScopes.push(captured.scope);
    return captured.scope;
  }
  check(
    "a capture-only install registers a capture-only client",
    (await registrationScopeFor(HOOK_SCOPE)) === HOOK_SCOPE
  );
  check(
    "an orienting install registers a client that declares the read scope",
    (await registrationScopeFor(ORIENT_SCOPE)) === ORIENT_SCOPE
  );
  check(
    "and with no scope named it still declares the narrow one, never the menu",
    (await registrationScopeFor(undefined)) === HOOK_SCOPE
  );

  /**
   * ...AND THE PRODUCTION CALLER MUST BE THE ONE PASSING IT.
   *
   * The three checks above drive `registerClient` directly, which is exactly the
   * gap the `state` section twenty lines up records: a unit check passes whether
   * or not anything calls the function. Measured -- deleting the `scope,` line
   * from `commands.authorize` leaves all three of them green, because they never
   * go through it, and that is the line the whole section exists to protect.
   *
   * So the flow itself is driven, twice, with a browser that approves, and the
   * assertion is made against the registration body the fake gateway actually
   * received. `state.registered` is appended to by `/oauth/register`, so this
   * cannot pass without a real request having been made.
   *
   * A fresh config path each time, because `authorize` reuses a stored client
   * whose scope already matches and would then register nothing at all.
   */
  async function registrationBodyFrom(orient) {
    const before = server.state.registered.length;
    await commands.authorize({
      endpoint: server.endpoint,
      orient,
      configPath: join(await mkdtemp(join(tmpdir(), "context-hook-scope-")), "config.json"),
      log,
      openBrowser: (href) => server.state.approve(href),
    });
    const registered = server.state.registered.slice(before);
    if (registered.length !== 1) throw new Error(`expected one registration, got ${registered.length}`);
    return registered[0];
  }
  const captureRegistration = await registrationBodyFrom(false);
  check(
    "the install flow registers a capture-only client",
    captureRegistration.scope === HOOK_SCOPE
  );
  const orientRegistration = await registrationBodyFrom(true);
  check(
    "and --orient registers one that declares the read scope it then asks for",
    orientRegistration.scope === ORIENT_SCOPE &&
      server.state.lastAuthorize.searchParams.get("scope") === ORIENT_SCOPE
  );
}
