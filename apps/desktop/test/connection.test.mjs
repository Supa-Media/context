/**
 * The credential on this machine: when it is renewed, when it is thrown away,
 * and what a person is told about it.
 *
 * This is the file where a wrong answer costs somebody their meetings. Two
 * failures in particular are silent and permanent, and both are checked here:
 *
 *  - **A rotated refresh token spent twice.** Two concurrent refreshes send the
 *    same refresh token; the second one is refused and the pair is dead. The
 *    machine is signed out and nothing says why until the next meeting fails.
 *  - **A hotel wifi treated as a revocation.** A refresh that failed because
 *    the network is a captive portal must not clear the credential. Clearing it
 *    would strand every queued meeting on a machine that is about to reconnect.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `#inFlight` not shared — one refresh per caller                            1
 *   every refresh failure treated as fatal (the record cleared)                3
 *   the refreshed pair returned before `store.write` was awaited               1
 *   `parseRecord` accepting a record with no tokens at all                     1
 *   an expired token returned as-is rather than refreshed                     11
 */

import { GatewayConnection, RefreshFailed, parseRecord } from "../src/core/sync/connection.ts";
import { memoryTokenStore } from "../src/core/sync/tokenStore.ts";

const REFRESH = "fake-refresh-token-not-a-real-one";
const ACCESS = "fake-access-token-not-a-real-one";

function record(overrides = {}) {
  return {
    endpoint: "https://gateway.example.test/mcp",
    gatewayBaseUrl: "https://gateway.example.test",
    issuer: "https://gateway.example.test",
    clientId: "client-for-this-machine",
    refreshToken: REFRESH,
    accessToken: ACCESS,
    expiresAt: 10_000,
    scope: "context:write context:private",
    ...overrides,
  };
}

/**
 * A store that remembers everything it was ever asked to hold, and is slow.
 *
 * The slowness is the point rather than realism for its own sake: a keychain
 * write is a round trip to another process, and an implementation that hands
 * out a rotated token *before* awaiting the write is indistinguishable from a
 * correct one against a store that resolves in a microtask. With a real tick in
 * the way, "returned before it was saved" is observable, which is what makes
 * the check a check.
 */
function spyStore(initial = null) {
  const inner = memoryTokenStore(initial);
  const writes = [];
  let cleared = 0;
  return {
    encrypted: false,
    read: () => inner.read(),
    async write(value) {
      writes.push(value);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await inner.write(value);
    },
    async clear() {
      cleared += 1;
      await inner.clear();
    },
    writes,
    clears: () => cleared,
  };
}

export async function runConnectionChecks(check) {
  // -- a live token is used as it stands ------------------------------------
  {
    let refreshes = 0;
    const connection = new GatewayConnection({
      store: memoryTokenStore(JSON.stringify(record())),
      refresh: async () => {
        refreshes += 1;
        throw new Error("should not have been called");
      },
      now: () => 5_000,
    });
    check("a stored grant reads as connected", (await connection.load()) === "connected");
    check("an unexpired access token is used as it stands", (await connection.token()) === ACCESS);
    check("...and nothing was refreshed to get it", refreshes === 0);
    check("the base URL comes from the record, not from settings", connection.baseUrl() === "https://gateway.example.test");
  }

  // -- no credential at all --------------------------------------------------
  {
    const connection = new GatewayConnection({ store: memoryTokenStore(null), refresh: async () => ({}) });
    check("an unconnected machine says so", (await connection.load()) === "disconnected");
    check("...and has no token to offer", (await connection.token()) === null);
    check("...and names no gateway", connection.baseUrl() === null);
  }

  // -- expiry refreshes exactly once, however many ask ----------------------
  {
    const store = spyStore(JSON.stringify(record({ expiresAt: 1_000 })));
    let refreshes = 0;
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const connection = new GatewayConnection({
      store,
      now: () => 5_000,
      refresh: async () => {
        refreshes += 1;
        await gate;
        return { accessToken: "second-access-token", refreshToken: "second-refresh-token", expiresAt: 9_000, scope: "" };
      },
    });

    const both = Promise.all([connection.token(), connection.token(), connection.token()]);
    release();
    const answers = await both;
    check("three callers racing an expired token refresh ONCE", refreshes === 1);
    check("...and all three get the new token", answers.every((token) => token === "second-access-token"));
    check("the rotated refresh token was written down", store.writes.some((raw) => JSON.parse(raw).refreshToken === "second-refresh-token"));
    check(
      "...BY THE TIME THE TOKEN WAS HANDED OUT, so a crash cannot spend a token nobody saved",
      JSON.parse((await store.read()) ?? "{}").accessToken === "second-access-token",
    );
    check("the scope survives a refresh that named none", connection.scope() === "context:write context:private");
  }

  // -- the network is not a revocation --------------------------------------
  {
    const store = spyStore(JSON.stringify(record({ expiresAt: 1_000 })));
    const connection = new GatewayConnection({
      store,
      now: () => 5_000,
      refresh: async () => {
        throw new RefreshFailed("the network is unreachable", false);
      },
    });
    check("a refresh that failed on the network answers with no token", (await connection.token()) === null);
    check("...but the credential is still there", store.clears() === 0);
    check("...and the app still reports itself connected", connection.state() === "connected");
    check("...so a queued meeting is not stranded", (await store.read()) !== null);
  }

  // -- a refused grant is thrown away ---------------------------------------
  {
    const store = spyStore(JSON.stringify(record({ expiresAt: 1_000 })));
    let refreshes = 0;
    const connection = new GatewayConnection({
      store,
      now: () => 5_000,
      refresh: async () => {
        refreshes += 1;
        throw new RefreshFailed("invalid_grant", true);
      },
    });
    check("a revoked grant answers with no token", (await connection.token()) === null);
    check("...the record is cleared from the keychain", store.clears() === 1 && (await store.read()) === null);
    check("...the app says reconnect rather than connected", connection.state() === "revoked");
    check("...and it stops asking", (await connection.token()) === null && refreshes === 1);
  }

  // -- an expired token with nothing to renew it ----------------------------
  {
    const connection = new GatewayConnection({
      store: memoryTokenStore(JSON.stringify(record({ expiresAt: 1_000, refreshToken: null }))),
      now: () => 5_000,
      refresh: async () => {
        throw new Error("should not have been called");
      },
    });
    check("an expired token with no refresh token is a dead credential", (await connection.token()) === null);
    check("...reported as reconnect-me rather than as a network blip", connection.state() === "revoked");
  }

  // -- connect and disconnect ------------------------------------------------
  {
    const store = spyStore(null);
    const connection = new GatewayConnection({ store, refresh: async () => ({}) });
    await connection.connect(record());
    check("connecting stores the record", JSON.parse(store.writes[0] ?? "{}").clientId === "client-for-this-machine");
    check("...and the app is connected without re-reading the keychain", connection.state() === "connected");
    await connection.disconnect();
    check("disconnecting leaves nothing a later read could find", (await store.read()) === null);
    check("...and the app is disconnected, not revoked", connection.state() === "disconnected");
  }

  // -- a damaged keychain entry never crashes the app -----------------------
  check("a truncated record is 'not connected', not an exception", parseRecord("{\"endpoint\":") === null);
  check("an empty entry is not connected", parseRecord("") === null && parseRecord(null) === null);
  check("a record with no tokens is not a connection", parseRecord(JSON.stringify(record({ accessToken: null, refreshToken: null }))) === null);
  check(
    "a record with only a refresh token IS a connection — that is the ordinary state after a restart",
    parseRecord(JSON.stringify(record({ accessToken: null })))?.refreshToken === REFRESH,
  );
  check("a record with no gateway is not a connection", parseRecord(JSON.stringify(record({ gatewayBaseUrl: "" }))) === null);
  {
    const connection = new GatewayConnection({ store: memoryTokenStore("not json at all"), refresh: async () => ({}) });
    check("...and the app starts anyway, asking to be connected", (await connection.load()) === "disconnected");
  }
}
