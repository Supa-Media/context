/**
 * The machine's own connection to a context: one OAuth client, one grant.
 *
 * ## Why this app authenticates the way the hook does
 *
 * The gateway authenticates MCP clients by **per-client OAuth grant**
 * (non-negotiable #4), and this app is exactly such a client — it is not the
 * phone. The phone signs in to the *control plane* with `@convex-dev/auth` and
 * writes a meeting the way it writes a note (`convexGateway.ts` in the mobile
 * app says so at length); this app holds no control-plane session and should
 * not: a laptop app that could read every context its owner belongs to is a
 * much larger thing to lose than one that holds a revocable grant on one.
 *
 * So the mechanism is the one `packages/hook` already ships and this repository
 * has already reviewed: dynamic client registration, a **loopback redirect**
 * (RFC 8252 §7.3), PKCE with S256, and a refresh token kept in the OS keychain.
 * `main/connect.ts` performs the browser half by importing that package's
 * `oauth.js` rather than re-implementing it — a second PKCE implementation is a
 * second thing that can get the state comparison wrong.
 *
 * This file is the half that has no browser and no Electron in it: what is
 * stored, when it is refreshed, and what happens when the answer is "no".
 *
 * ## Three rules, enforced here rather than remembered
 *
 * **The renderer never sees any of this.** `preload` exposes no channel that
 * reads a token, and `postEntry` attaches the header in the main process. The
 * record below is a credential in every field that matters — the refresh token
 * *is* the account — so it lives in `TokenStore`, which is the keychain.
 *
 * **A network failure is not a revocation.** A refresh that fails because the
 * wifi is a hotel portal must leave the record exactly where it was: the outbox
 * holds the meeting, `postEntry` reads `null` as "not connected yet" and
 * retries with backoff, and the recording is not lost. Only the server saying
 * `invalid_grant` — the one answer that means *this credential is dead* —
 * clears it, and then the app says "reconnect this machine" rather than
 * queueing forever against a grant nobody will ever honour.
 *
 * **One refresh at a time.** A drain posting four entries, and a chunk of audio
 * on its way to be transcribed, all ask for a token at once. Rotating refresh
 * tokens mean the second concurrent refresh spends a token the first already
 * replaced, which invalidates the pair and signs the machine out — so the
 * in-flight promise is shared.
 */

import type { TokenStore } from "./tokenStore.ts";

/* ------------------------- what a meeting needs granted ------------------- *
 *
 * Two scopes, and the second is the one that would be dropped as a tidy-up.
 * `context:write` because a meeting is not a capture, and **`context:private`
 * because the tier is a property of the grant rather than of the write**:
 * `visibilityTierForGrant` in the gateway reads a grant without it as `team`,
 * and `publishMeetingNote` then files the note team-visible and writes that
 * visibility into the customer's own `privacy.md`. A recorder on a team-tier
 * grant does not record less — it records the same meetings and publishes them
 * to everybody the owner ever shared a folder with.
 *
 * `main/connect.ts` asks for both (`DESKTOP_SCOPE`). What is here is the other
 * half of that sentence: **asking is not getting.** The person approving
 * chooses the tier, and a grant that came back without it must stop this
 * machine writing meetings rather than have them written at the wider one.
 * ------------------------------------------------------------------------- */

/**
 * Every spelling of the private tier this app will accept as "granted".
 *
 * The gateway issues the canonical `context:private` (`SUPPORTED_SCOPES` in
 * `apps/mcp/src/session.js`), and the aliases are here for the same reason the
 * console's `scopes.ts` carries them: different parts of this system arrived at
 * different separators, and a client that reads only one spelling holds back a
 * meeting that was in fact granted. A wildcard counts because a wildcard grant
 * is by construction wider than this one.
 */
const PRIVATE_TIER_SPELLINGS: ReadonlySet<string> = new Set([
  "context:private",
  "context.private",
  "private",
  "*",
  "context:*",
  "context.*",
  "all",
]);

const WRITE_SPELLINGS: ReadonlySet<string> = new Set([
  "context:write",
  "context.write",
  "write",
  "*",
  "context:*",
  "context.*",
  "all",
]);

/**
 * Whether this grant may file a meeting at the tier this machine records at.
 *
 * `false` for a grant that carries no private tier, **and for one that says
 * nothing at all**. The empty string is not "probably what we asked for": RFC
 * 6749 lets a token endpoint omit `scope` to mean "as requested", and reading
 * it that way here would make the check answer with the client's own request
 * instead of the server's answer — which is precisely the assertion this
 * function exists to stop the app making. Our gateway always sends `scope`
 * (`tokenResponse` in `apps/mcp/src/oauth.js`), so what this refuses is a
 * server that left the question open, and it refuses it in the safe direction.
 */
export function grantCoversMeetings(scope: string | null | undefined): boolean {
  if (typeof scope !== "string") return false;
  const granted = new Set(scope.split(/[\s,]+/).filter((part) => part !== ""));
  let write = false;
  let tier = false;
  for (const part of granted) {
    if (WRITE_SPELLINGS.has(part)) write = true;
    if (PRIVATE_TIER_SPELLINGS.has(part)) tier = true;
  }
  return write && tier;
}

/**
 * What a person is told when this machine is connected at the narrower tier.
 *
 * Written for the card under "This machine", so it says what happened, what it
 * would have cost to carry on, and the one action that fixes it. It names no
 * scope string: "context:private" is not a sentence, and the person chose this
 * on a screen that called it "Everything, including private notes".
 */
export const MEETING_TIER_REFUSAL =
  "This machine was approved for team-visible notes only. Filing a meeting would make it readable by everyone you share with, so it is holding them instead. Disconnect and connect it again, choosing to include private notes.";

/**
 * What one connected machine remembers.
 *
 * Stored whole, as JSON, in the keychain. `gatewayBaseUrl` is not itself a
 * secret and is duplicated into settings so the UI can name where meetings go
 * without unlocking anything — but it is kept here as well, because a record
 * whose token belonged to a different gateway than the one being posted to is
 * the shape that sends a credential somewhere it was never minted for.
 */
export interface ConnectionRecord {
  /** The MCP endpoint discovery started from, e.g. `https://mcp.example/mcp`. */
  endpoint: string;
  /** Origin plus any fixed path the meeting routes hang off. No trailing slash. */
  gatewayBaseUrl: string;
  /** The authorization server, from RFC 9728 discovery. */
  issuer: string;
  /** This machine's own client id. Per machine, so one laptop is revocable alone. */
  clientId: string;
  refreshToken: string | null;
  accessToken: string | null;
  /** Epoch milliseconds. Already carries the refresh skew the token endpoint applied. */
  expiresAt: number;
  /** What was actually granted, which may be narrower than what was asked. */
  scope: string;
}

/** What a refresh answers with. Mirrors `packages/hook`'s `postToken`. */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

/**
 * A refresh that could not be performed, told apart by whether the credential
 * survived it.
 *
 * `fatal` means the authorization server refused the grant itself —
 * `invalid_grant`, a revoked client, a deleted workspace. Anything else is the
 * network, and the network comes back.
 */
export class RefreshFailed extends Error {
  readonly fatal: boolean;

  constructor(message: string, fatal: boolean) {
    super(message);
    this.name = "RefreshFailed";
    this.fatal = fatal;
  }
}

export type Refresher = (record: ConnectionRecord) => Promise<RefreshedTokens>;

/** What the menu bar and the panel are allowed to know about the credential. */
export type ConnectionState =
  /** No grant on this machine. Meetings queue; nothing is transcribed. */
  | "disconnected"
  /** A live grant. */
  | "connected"
  /** There was a grant and the server has refused it. A person must reconnect. */
  | "revoked";

export interface ConnectionDeps {
  store: TokenStore;
  refresh: Refresher;
  now?: () => number;
}

/**
 * The connection, as one object the app holds and the suite can drive.
 *
 * Deliberately not a singleton and deliberately not reading the environment:
 * everything it needs is injected, so every rule above is a check in
 * `test/connection.test.mjs` rather than a paragraph.
 */
export class GatewayConnection {
  #store: TokenStore;
  #refresh: Refresher;
  #now: () => number;
  /** Cached so a drain does not hit the keychain per request. */
  #record: ConnectionRecord | null = null;
  #loaded = false;
  #revoked = false;
  #inFlight: Promise<string | null> | null = null;

  constructor(deps: ConnectionDeps) {
    this.#store = deps.store;
    this.#refresh = deps.refresh;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** What the UI may say. Never the token, never part of it. */
  state(): ConnectionState {
    if (this.#revoked) return "revoked";
    return this.#record ? "connected" : "disconnected";
  }

  /** Where this machine posts, for the UI and for `postEntry`'s base URL. */
  baseUrl(): string | null {
    return this.#record?.gatewayBaseUrl ?? null;
  }

  /** Which scopes the grant actually carries, for the "what can this do" line. */
  scope(): string | null {
    return this.#record?.scope ?? null;
  }

  /** Read the keychain once, on first use. */
  async load(): Promise<ConnectionState> {
    if (this.#loaded) return this.state();
    this.#loaded = true;
    const raw = await this.#store.read();
    this.#record = parseRecord(raw);
    return this.state();
  }

  /** Store a fresh authorization. Replaces whatever was there. */
  async connect(record: ConnectionRecord): Promise<void> {
    this.#loaded = true;
    this.#revoked = false;
    this.#record = record;
    await this.#store.write(JSON.stringify(record));
  }

  /** Forget this machine's grant. Leaves nothing a later read could find. */
  async disconnect(): Promise<void> {
    this.#loaded = true;
    this.#revoked = false;
    this.#record = null;
    await this.#store.clear();
  }

  /**
   * A usable access token, or `null`.
   *
   * `null` is a first-class answer and means "this machine cannot authenticate
   * right now" — not connected, offline, or refused. `postEntry` reads it as
   * "queue this", which is the correct behaviour for all three: the meeting is
   * in the outbox and the outbox is what remembers.
   */
  async token(): Promise<string | null> {
    await this.load();
    const record = this.#record;
    if (record === null) return null;
    if (record.accessToken !== null && record.expiresAt > this.#now()) return record.accessToken;
    if (record.refreshToken === null) {
      // An expired access token and nothing to renew it with is a dead
      // credential, which is the same situation as a refused one.
      this.#revoked = true;
      return null;
    }
    // Shared on purpose: see the header. A second concurrent refresh spends a
    // rotated token and signs the machine out.
    this.#inFlight ??= this.#renew(record).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #renew(record: ConnectionRecord): Promise<string | null> {
    let tokens: RefreshedTokens;
    try {
      tokens = await this.#refresh(record);
    } catch (error) {
      if (error instanceof RefreshFailed && error.fatal) {
        // The grant is gone. Clearing it is what turns "every meeting fails
        // silently forever" into a menu bar that says reconnect.
        this.#record = null;
        this.#revoked = true;
        await this.#store.clear();
        return null;
      }
      // Everything else is the network. The record stays exactly as it was.
      return null;
    }

    const next: ConnectionRecord = {
      ...record,
      accessToken: tokens.accessToken,
      // Rotation is assumed, not hoped for: keep whichever refresh token came
      // back, and fall back to the one we sent only when none did.
      refreshToken: tokens.refreshToken ?? record.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || record.scope,
    };
    this.#record = next;
    /*
      Persisted BEFORE it is returned, and awaited.

      A rotating refresh token that is spent and not written down leaves this
      machine permanently unable to authenticate, and the failure surfaces at
      the end of some future meeting where nobody is looking. Same reasoning as
      `packages/hook`'s `accessTokenFor`.
    */
    await this.#store.write(JSON.stringify(next));
    return next.accessToken;
  }
}

/**
 * Whatever was in the keychain, as a record or as nothing.
 *
 * Never throws. A keychain entry written by a newer version, truncated by a
 * crash, or hand-edited resolves to "not connected", which is a state the app
 * already handles perfectly: meetings queue and the menu bar asks to connect.
 * The one thing it may not do is throw on launch — an app that cannot start
 * because of its own credential file is an app somebody deletes.
 */
export function parseRecord(raw: string | null): ConnectionRecord | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const source = parsed as Record<string, unknown>;
  const endpoint = text(source["endpoint"]);
  const gatewayBaseUrl = text(source["gatewayBaseUrl"]);
  const clientId = text(source["clientId"]);
  if (endpoint === null || gatewayBaseUrl === null || clientId === null) return null;
  const accessToken = text(source["accessToken"]);
  const refreshToken = text(source["refreshToken"]);
  // A record with neither token authenticates nothing, and reporting it as a
  // connection would show a connected menu bar over a queue that never drains.
  if (accessToken === null && refreshToken === null) return null;
  return {
    endpoint,
    gatewayBaseUrl,
    issuer: text(source["issuer"]) ?? new URL(gatewayBaseUrl).origin,
    clientId,
    refreshToken,
    accessToken,
    expiresAt: typeof source["expiresAt"] === "number" ? source["expiresAt"] : 0,
    scope: text(source["scope"]) ?? "",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Where the meeting routes live, given the MCP endpoint a person typed.
 *
 * `ROUTES` are **siblings** of `/mcp` rather than children of it, so what a
 * client posts to is the endpoint's origin. Derived in one place because the
 * mobile app derives the same thing (`gatewayOriginFrom`) for the same reason:
 * a self-hoster who moved their gateway moves both, and a client that guessed
 * would post meetings at `…/mcp/meetings/sessions` and get a 404 it could not
 * explain.
 */
export function gatewayBaseFrom(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * OAuth error codes that mean "this grant is dead", as opposed to "try later".
 *
 * RFC 6749 §5.2's list, minus the ones a refresh from a registered public
 * client cannot produce. It lives here rather than in `main/connect.ts` because
 * it is the decision the whole credential lifecycle turns on — a wrong answer
 * either deletes a working credential or queues meetings forever against a
 * revoked one — and `main/` cannot be reached by the suite.
 */
export const FATAL_OAUTH_CODES: readonly string[] = Object.freeze([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
]);

/**
 * Anything unrecognised is **temporary**, and that default is the load-bearing
 * half.
 *
 * A captive portal answering HTML, a proxy answering 502, a DNS failure: none
 * of them is the authorization server saying no, and reading one as a
 * revocation would clear the keychain and strand every queued meeting on a
 * laptop that is thirty seconds from reconnecting.
 */
export function isFatalOAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return FATAL_OAUTH_CODES.some((code) => message.includes(code));
}
