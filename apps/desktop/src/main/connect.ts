/**
 * "Connect this machine to your context" — the browser half, once.
 *
 * Everything OAuth here is `packages/hook`'s. That package already ships a
 * reviewed native-client flow against this exact gateway: RFC 9728 discovery,
 * dynamic client registration, a loopback redirect on `127.0.0.1` with the port
 * the OS hands out, PKCE with S256, constant-time state comparison, and a
 * refusal to send a credential to any URL that is not https or loopback. A
 * second implementation in this app would be a second chance to get the state
 * comparison wrong, so there is not one — this file is the four calls in order
 * plus what is specific to a desktop app.
 *
 * ## What is specific to this app: the scope
 *
 * The hook asks for `context:capture`, because it writes to `0-inbox/` and must
 * never be able to read a note. This app is asking for something wider and the
 * reason is worth stating rather than assuming:
 *
 *  - **`context:write`** because a meeting is not a capture. Finalizing writes
 *    a note, re-finalizing must find the one it already wrote, and the session
 *    record under `.meetings/` is read back between requests. `scopeForMeetingRequest`
 *    in the gateway requires write for every POST on these routes.
 *  - **`context:private`** because it decides what a meeting is *filed as*. The
 *    gateway's `visibilityTierForGrant` reads a grant without it as `team`, and
 *    `publishMeetingNote` files the note at the connection's own tier. A
 *    recorder that asked for the narrower thing would file every meeting its
 *    owner recorded as team-visible — a privacy default nobody chose, arrived
 *    at by asking for less. So it is asked for, and the consent screen names it.
 *
 * It does not ask for `context:read`. This app never reads the context: it
 * writes meetings and reads back its own session records, which the write scope
 * covers. A laptop credential that could read every note its owner ever wrote
 * is past what the feature is worth.
 *
 * ## The endpoint is the person's own
 *
 * There is no hard-coded gateway. A self-hoster types their own MCP endpoint
 * and everything else is discovered from it, which is the whole point of RFC
 * 9728 — and `credentialUrlOk` refuses to walk to an `http` one that is not
 * loopback, so a discovery document cannot redirect this flow onto a plaintext
 * token endpoint.
 *
 * ## Why `electron` is imported late, at the one line that needs it
 *
 * This file is the app's whole credential-acquisition path, and CLAUDE.md's
 * rule for that is a test proving the attack fails — which a module with a
 * top-level `import { shell } from "electron"` cannot have, because the suite
 * runs on plain Node and Electron is not importable there. `main/transcribe.ts`
 * already made this trade the other way and said why: "imports no Electron —
 * deliberately, so the request that puts somebody's meeting on a network is
 * checked here rather than by holding one." The same argument is stronger here,
 * since what this file gets wrong is not a request, it is the grant.
 *
 * So the only Electron in it is a dynamic `import("electron")` inside the
 * default browser opener, reached only when no `openBrowser` was injected —
 * `esbuild` keeps `electron` external either way, so the bundle is unchanged.
 * `test/connect.test.mjs` then drives the real flow against a real loopback
 * listener, and the state check has a check behind it.
 */

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import {
  authorizeUrl,
  createPkce,
  credentialUrlOk,
  discover,
  exchangeCode,
  listenForCode,
  refreshTokens,
  registerClient,
  stateMatches,
} from "@supa-media/context-hook/src/oauth.js";
import { RefreshFailed, gatewayBaseFrom, isFatalOAuthError } from "../core/sync/connection.ts";
import type { ConnectionRecord, RefreshedTokens } from "../core/sync/connection.ts";

/**
 * What this machine asks a person to approve. See the header for each half.
 *
 * `context:private` is the one that would be tempting to drop, and dropping it
 * is not a narrowing — it silently changes what every meeting is filed as.
 */
export const DESKTOP_SCOPE = "context:write context:private";

export interface ConnectOptions {
  /** The MCP endpoint, as the person typed it. */
  endpoint: string;
  /** Told where to send the browser, in case it does not open. */
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  openBrowser?: (href: string) => Promise<void>;
}

/**
 * Run the whole flow and answer with the record to store.
 *
 * Deliberately does **not** write anything: `GatewayConnection.connect` owns
 * the keychain, so a flow that half-succeeded cannot leave a half-credential
 * behind. Throws with a sentence a person can read; nothing it throws carries
 * a token, because everything it throws is composed here or by `oauth.js`,
 * which is written to the same rule.
 */
export async function connectMachine(options: ConnectOptions): Promise<ConnectionRecord> {
  const endpoint = options.endpoint.trim();
  // Refused before the first discovery request rather than after: no credential
  // is in that request, and it is still enough to tell a passive observer that
  // this machine is connecting to that endpoint over plaintext.
  if (!credentialUrlOk(endpoint)) {
    throw new Error("that endpoint must be https (or a loopback address for a local gateway)");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});

  const discovery = await discover(endpoint, { fetchImpl });
  const registration = await registerClient(discovery, {
    // One client per machine, so revoking the laptop you lost does not sign out
    // the one on your desk. The hostname is what a person will recognise in the
    // console's connections list.
    clientName: `Context on ${hostname()}`,
    scope: DESKTOP_SCOPE,
    fetchImpl,
  });

  const listener = await listenForCode();
  const pkce = createPkce();
  const state = randomBytes(24).toString("base64url");
  const href = authorizeUrl(discovery, {
    clientId: registration.clientId,
    redirectUri: listener.redirectUri,
    challenge: pkce.challenge,
    state,
    scope: DESKTOP_SCOPE,
  });

  log(`Opening your browser to approve this machine.\nIf it does not open: ${href}`);
  try {
    await (options.openBrowser ?? openInSystemBrowser)(href);
  } catch {
    // A machine whose browser will not open is a real case. The URL has already
    // been logged, and the listener is still waiting.
  }

  let returned: { code: string; state: string };
  try {
    returned = await listener.waitForCode();
  } finally {
    listener.close();
  }
  // The state check is what stops somebody else's authorization code being fed
  // to this listener while it is open. Constant time, and fatal.
  if (!stateMatches(state, returned.state)) {
    throw new Error("the browser came back with the wrong state; nothing was saved");
  }
  if (!returned.code) throw new Error("the browser came back without an authorization code");

  const tokens = await exchangeCode(
    discovery,
    {
      clientId: registration.clientId,
      code: returned.code,
      verifier: pkce.verifier,
      redirectUri: listener.redirectUri,
    },
    { fetchImpl },
  );

  return {
    endpoint,
    gatewayBaseUrl: gatewayBaseFrom(endpoint),
    issuer: discovery.issuer,
    clientId: registration.clientId,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope || DESKTOP_SCOPE,
  };
}

/**
 * The one line in this file that needs Electron, loaded when it is reached.
 *
 * A dynamic import so the module above can be imported by a suite that has no
 * Electron; the bundler leaves `electron` external, so the packaged app resolves
 * it from the runtime exactly as a static import would.
 */
async function openInSystemBrowser(href: string): Promise<void> {
  const { shell } = await import("electron");
  await shell.openExternal(href);
}

/**
 * The refresher `GatewayConnection` is constructed with.
 *
 * The only decision in it is which failures are fatal, and it is the decision
 * the whole credential lifecycle turns on: `invalid_grant` and friends mean the
 * grant is gone and the app must ask to be reconnected; everything else is a
 * network the app should wait out with its queue intact. `oauth.js` relays the
 * server's own error **code** rather than its prose, which is what makes this
 * a match on a code rather than on a sentence.
 */
export function browserlessRefresher(fetchImpl: typeof fetch = fetch) {
  return async (record: ConnectionRecord): Promise<RefreshedTokens> => {
    if (record.refreshToken === null) throw new RefreshFailed("no refresh token", true);
    const discovery = await discover(record.endpoint, { fetchImpl }).catch(() => {
      // Discovery failing is the network, not a refusal: the authorization
      // server has said nothing at all.
      throw new RefreshFailed("the gateway could not be reached", false);
    });
    try {
      return await refreshTokens(
        discovery,
        { clientId: record.clientId, refreshToken: record.refreshToken },
        { fetchImpl },
      );
    } catch (error) {
      throw new RefreshFailed("the gateway refused this machine's credential", isFatalOAuthError(error));
    }
  };
}
