import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  DROPBOX_CALLBACK_PATH,
  DROPBOX_REDIRECT_ORIGINS,
  DROPBOX_TIMEOUT_MESSAGE,
  browserOrigin,
  describeDropboxFailure,
  dropboxCallbackHref,
  dropboxRedirectUri,
  firstParam,
  isDropboxAuthorizeUrl,
  parseDropboxCallback,
  resolveDropboxCallbackView,
  type DropboxAttempt,
  type DropboxCallback,
} from "../features/console/storage/dropbox";
import {
  describeStorageFailure,
  describeThrownStorageError,
} from "../features/console/storage/errors";
import { validateRootPrefix } from "../features/console/storage/connect";
import { connectProgress } from "../features/onboarding/verify";

/**
 * Connecting a context to Dropbox, as rules.
 *
 * Everything here is a pure function on purpose — a redirect rule looks right
 * when you click it and is wrong when somebody reloads, and an OAuth callback
 * is the one screen in the product that is *always* arrived at by reload.
 *
 * The four things worth pinning, each of which is a real failure if it drifts:
 *
 *  1. **An unregistered origin produces no button.** Dropbox matches
 *     `redirect_uri` exactly, so a built-from-the-origin URI on a dev server
 *     ends on Dropbox's own error page — off our domain, with nothing a person
 *     can act on.
 *  2. **A code with no state is never sent.** `state` is the only thing binding
 *     a returned code to the flow that started it; without it the backend
 *     correctly refuses, and asking it to is asking for a refusal.
 *  3. **A refusal is read before a code.** Dropbox returns `state` alongside
 *     `error=access_denied`, so reading the code first shows somebody who
 *     pressed Cancel a spinner and then a failure.
 *  4. **Dropbox failures never name an access key.** The shared copy tells
 *     people to paste one; a Dropbox binding has never had one.
 */

const AUTHED = { isLoading: false, isAuthenticated: true } as const;
const READY: DropboxCallback = { kind: "ready", code: "codeexample", state: "stateexample" };

function view(overrides: Partial<Parameters<typeof resolveDropboxCallbackView>[0]> = {}) {
  return resolveDropboxCallbackView({
    callback: READY,
    auth: AUTHED,
    attempt: undefined,
    binding: undefined,
    slug: null,
    timedOut: false,
    ...overrides,
  });
}

describe("dropboxRedirectUri", () => {
  test("the two registered origins each get their own callback URL", () => {
    expect(dropboxRedirectUri("https://context.lc")).toBe(
      `https://context.lc${DROPBOX_CALLBACK_PATH}`,
    );
    expect(dropboxRedirectUri("http://localhost:4601")).toBe(
      `http://localhost:4601${DROPBOX_CALLBACK_PATH}`,
    );
  });

  /**
   * The point of the whole function. The Expo dev server's usual port is 8081,
   * and a URI built from it is one Dropbox has never been told about — so the
   * flow dies on Dropbox's error page rather than here, where something can be
   * said about it.
   */
  test("an origin Dropbox has not been told about produces nothing", () => {
    expect(dropboxRedirectUri("http://localhost:8081")).toBe(null);
    expect(dropboxRedirectUri("https://staging.context.lc")).toBe(null);
    expect(dropboxRedirectUri("https://context.lc.evil.example")).toBe(null);
  });

  test("matching is exact, not by prefix or suffix", () => {
    expect(dropboxRedirectUri("https://context.lc/")).toBe(null);
    expect(dropboxRedirectUri("https://www.context.lc")).toBe(null);
    expect(dropboxRedirectUri("http://context.lc")).toBe(null);
  });

  test("no origin at all — a native build — produces nothing", () => {
    expect(dropboxRedirectUri(null)).toBe(null);
    expect(dropboxRedirectUri(undefined)).toBe(null);
    expect(dropboxRedirectUri("")).toBe(null);
  });

  test("the registered list is frozen, so nothing widens it at runtime", () => {
    expect(Object.isFrozen(DROPBOX_REDIRECT_ORIGINS)).toBe(true);
  });

  // jsdom gives this test file a `location`, which is exactly the shape the
  // browser branch reads. On a phone there is a global `window` with no
  // `location` on it, which is why the check is for the property.
  test("browserOrigin reads a real origin where there is one", () => {
    expect(browserOrigin()).toBe(globalThis.location?.origin ?? null);
  });
});

describe("isDropboxAuthorizeUrl", () => {
  test("Dropbox's own authorize URL passes", () => {
    expect(
      isDropboxAuthorizeUrl("https://www.dropbox.com/oauth2/authorize?client_id=x&state=y"),
    ).toBe(true);
    expect(isDropboxAuthorizeUrl("https://dropbox.com/oauth2/authorize")).toBe(true);
  });

  /**
   * The URL comes from our own control plane. The check runs anyway, for
   * `redirectSafety.ts`'s reason: a misconfigured or compromised deployment
   * would otherwise turn "Connect Dropbox" into an open redirect somebody
   * clicks on purpose, and a look-alike host is the whole attack.
   */
  test("a look-alike host, a subdomain trick, and a hostile scheme are all refused", () => {
    expect(isDropboxAuthorizeUrl("https://dropbox.com.evil.example/oauth2/authorize")).toBe(false);
    expect(isDropboxAuthorizeUrl("https://evil.example/www.dropbox.com")).toBe(false);
    expect(isDropboxAuthorizeUrl("http://www.dropbox.com/oauth2/authorize")).toBe(false);
    expect(isDropboxAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(isDropboxAuthorizeUrl("not a url")).toBe(false);
    expect(isDropboxAuthorizeUrl("")).toBe(false);
  });

  /**
   * These three are here because sabotaging the check to
   * `hostname.endsWith("dropbox.com")` left every other assertion in this file
   * green: a *suffix* rule refuses `dropbox.com.evil.example` correctly and
   * happily accepts `evildropbox.com`, which is the domain an attacker
   * actually registers. Same class of bug as matching an allowed origin by
   * prefix, and it took breaking it on purpose to find that the tests could
   * not see it.
   *
   * `https://dropbox.com@evil.example` is the other half: the host is
   * `evil.example` and `dropbox.com` is userinfo, which is why the check reads
   * `hostname` rather than the string.
   */
  test("a suffix or substring of the real host is not the real host", () => {
    expect(isDropboxAuthorizeUrl("https://evildropbox.com/oauth2/authorize")).toBe(false);
    expect(isDropboxAuthorizeUrl("https://notwww.dropbox.com.co/oauth2/authorize")).toBe(false);
    expect(isDropboxAuthorizeUrl("https://dropbox.com@evil.example/oauth2/authorize")).toBe(false);
  });
});

describe("parseDropboxCallback", () => {
  test("both halves present is the only thing worth sending", () => {
    expect(parseDropboxCallback({ code: "c", state: "s" })).toEqual({
      kind: "ready",
      code: "c",
      state: "s",
    });
  });

  /**
   * `state` is the only thing binding this code to the flow that started it.
   * Sending a bare code up is asking the backend for the refusal it is right
   * to give, and showing the person a failure instead of "nothing to finish".
   */
  test("a code with no state is never ready", () => {
    expect(parseDropboxCallback({ code: "c" }).kind).toBe("incomplete");
    expect(parseDropboxCallback({ code: "c", state: "" }).kind).toBe("incomplete");
  });

  test("a state with no code is not ready either", () => {
    expect(parseDropboxCallback({ state: "s" }).kind).toBe("incomplete");
  });

  test("nothing at all is incomplete, not a failure", () => {
    expect(parseDropboxCallback({}).kind).toBe("incomplete");
  });

  /**
   * Dropbox sends `state` back with the refusal too. Reading the code first
   * would leave somebody who pressed Cancel watching a spinner, then reading
   * an error about a connection they deliberately did not make.
   */
  test("a refusal is read before a code, even when both are present", () => {
    expect(
      parseDropboxCallback({ error: "access_denied", state: "s", code: "c" }).kind,
    ).toBe("cancelled");
  });

  test("a duplicated parameter arrives as an array and takes the first", () => {
    expect(parseDropboxCallback({ code: ["c1", "c2"], state: ["s1"] })).toEqual({
      kind: "ready",
      code: "c1",
      state: "s1",
    });
    expect(firstParam([])).toBe(null);
    expect(firstParam(undefined)).toBe(null);
  });
});

describe("dropboxCallbackHref", () => {
  test("carries both halves so sign-in can come back to them", () => {
    expect(dropboxCallbackHref(READY)).toBe(
      "/connect/dropbox?code=codeexample&state=stateexample",
    );
  });

  test("encodes rather than pasting, so a value with an ampersand cannot forge a parameter", () => {
    const href = dropboxCallbackHref({ kind: "ready", code: "a&state=evil", state: "s" });
    expect(href).toBe("/connect/dropbox?code=a%26state%3Devil&state=s");
    expect(new URL(href, "https://context.lc").searchParams.get("state")).toBe("s");
  });

  test("anything not ready is the bare path", () => {
    expect(dropboxCallbackHref({ kind: "cancelled" })).toBe(DROPBOX_CALLBACK_PATH);
    expect(dropboxCallbackHref({ kind: "incomplete" })).toBe(DROPBOX_CALLBACK_PATH);
  });
});

describe("resolveDropboxCallbackView", () => {
  /**
   * Both are answers about the URL itself. Bouncing somebody to sign in to be
   * told they pressed Cancel is ceremony over an answer they already gave, and
   * it happens on the branch where they are *least* likely to have a session.
   */
  test("a refusal and an empty visit are readable with no session at all", () => {
    const signedOut = { isLoading: false, isAuthenticated: false };
    expect(view({ callback: { kind: "cancelled" }, auth: signedOut }).kind).toBe("cancelled");
    expect(view({ callback: { kind: "incomplete" }, auth: signedOut }).kind).toBe("incomplete");
    expect(view({ callback: { kind: "cancelled" }, auth: { isLoading: true, isAuthenticated: false } }).kind).toBe(
      "cancelled",
    );
  });

  /**
   * THERE IS NO SIGN-IN WALL, and this pins its absence.
   *
   * The first live run lost the session on the OAuth round trip, and the wall
   * that used to be here cost enough OTP time that Dropbox's single-use code
   * expired — it was the only thing that made the connect fail. The exchange
   * needs no session (PKCE binds the code to the parked attempt), so a
   * signed-out arrival starts working immediately instead of being sent to
   * `/login`.
   */
  test("a signed-out arrival starts the exchange, never a sign-in wall", () => {
    const resolved = view({ auth: { isLoading: false, isAuthenticated: false } });
    expect(resolved.kind).toBe("working");
    // Even while auth is still resolving: the exchange does not wait on it.
    expect(view({ auth: { isLoading: true, isAuthenticated: false } }).kind).toBe("working");
  });

  /**
   * The one part that does need a session is *watching* the binding, which is
   * members-only. A signed-out finisher gets the honest terminal state — the
   * connection is finishing server-side — with a way into their console.
   */
  test("queued while signed out says it is finishing, and offers sign-in", () => {
    const resolved = view({
      auth: { isLoading: false, isAuthenticated: false },
      attempt: { kind: "queued", workspaceId: "w1" },
    });
    expect(resolved.kind).toBe("finishing");
    if (resolved.kind !== "finishing") throw new Error("unreachable");
    expect(resolved.href).toContain("/login");
  });

  test("before and during the exchange it says what it is doing", () => {
    expect(view({ attempt: undefined }).kind).toBe("working");
    expect(view({ attempt: { kind: "running" } }).kind).toBe("working");
  });

  test("a refused exchange shows the refusal's own copy", () => {
    const failure = describeDropboxFailure("CONNECT_ATTEMPT_INVALID", undefined);
    const resolved = view({ attempt: { kind: "failed", failure } });
    expect(resolved).toEqual({ kind: "failed", failure });
  });

  /**
   * `completeDropboxConnect` schedules the exchange and returns before the
   * binding is written, so "queued" is not "connected" — the row is the only
   * thing that can say. Same watch the bucket path runs after `bindStorage`.
   */
  test("queued is still working until the row says otherwise", () => {
    const queued: DropboxAttempt = { kind: "queued", workspaceId: "ws_1" };
    expect(view({ attempt: queued, binding: undefined }).kind).toBe("working");
    expect(view({ attempt: queued, binding: null }).kind).toBe("working");
    expect(view({ attempt: queued, binding: { status: "unverified" } }).kind).toBe("working");
  });

  test("a connected row points at the context that was connected", () => {
    const resolved = view({
      attempt: { kind: "queued", workspaceId: "ws_1" },
      binding: { status: "connected" },
      slug: "seyi",
    });
    expect(resolved.kind).toBe("connected");
    if (resolved.kind !== "connected") throw new Error("unreachable");
    expect(resolved.href).toContain("seyi");
  });

  // The slug comes from a second subscription that can be in flight or have
  // failed. `/console` answers for itself — it sends an account with no
  // contexts to `/welcome` — so no branch of this screen can strand anybody.
  test("a connected row with no slug yet still has somewhere to go", () => {
    const resolved = view({
      attempt: { kind: "queued", workspaceId: "ws_1" },
      binding: { status: "connected" },
      slug: null,
    });
    expect(resolved.kind).toBe("connected");
    if (resolved.kind !== "connected") throw new Error("unreachable");
    expect(resolved.href).toBe("/console");
  });

  test("a failed row is described as Dropbox, never as a bucket", () => {
    const resolved = view({
      attempt: { kind: "queued", workspaceId: "ws_1" },
      binding: { status: "error", errorCode: "UNREACHABLE", provider: "dropbox" },
    });
    expect(resolved.kind).toBe("failed");
    if (resolved.kind !== "failed") throw new Error("unreachable");
    expect(resolved.failure.headline).toContain("Dropbox");
    expect(`${resolved.failure.next}`).not.toContain("access key");
  });

  /**
   * Not a failure. `exchangeAndBind` schedules the verification exactly as
   * `bindStorage` does, so a slow answer is a slow answer — and the console
   * reads the binding reactively, so an outcome that lands later shows up
   * without anybody reloading this page.
   */
  test("giving up waiting says so, and says nothing was lost", () => {
    const resolved = view({
      attempt: { kind: "queued", workspaceId: "ws_1" },
      binding: { status: "unverified" },
      timedOut: true,
    });
    expect(resolved).toEqual({ kind: "timeout", message: DROPBOX_TIMEOUT_MESSAGE });
    expect(DROPBOX_TIMEOUT_MESSAGE).toContain("Nothing is lost");
  });

  // The timeout must not outrank a verdict that already arrived.
  test("a verdict beats the clock, in both directions", () => {
    const queued: DropboxAttempt = { kind: "queued", workspaceId: "ws_1" };
    expect(view({ attempt: queued, binding: { status: "connected" }, timedOut: true }).kind).toBe(
      "connected",
    );
    expect(view({ attempt: queued, binding: { status: "error" }, timedOut: true }).kind).toBe(
      "failed",
    );
  });

  // It reuses `connectProgress` rather than growing a second state machine.
  // If that reuse is ever replaced by a copy, this is what notices.
  test("the row is read by the same machine the bucket path uses", () => {
    expect(connectProgress({ submitted: true, binding: { status: "connected" }, timedOut: false }).kind).toBe(
      "connected",
    );
  });
});

describe("the Dropbox failure copy", () => {
  test("every code this flow can throw maps to a fix", () => {
    for (const code of [
      "CONNECT_ATTEMPT_INVALID",
      "NOT_OWNER",
      "DROPBOX_NOT_CONFIGURED",
      "STORAGE_REAUTH_REQUIRED",
      "STORAGE_UNAVAILABLE",
    ]) {
      const failure = describeStorageFailure(code, undefined);
      expect(failure.headline.length).toBeGreaterThan(0);
      expect(failure.next).toBeDefined();
    }
  });

  /**
   * The backend collapses "no such attempt", "expired" and "not yours" into
   * one code, because telling them apart says whether a given state value was
   * ever real. One code, one sentence — and it names the class of thing rather
   * than this attempt.
   */
  test("an expired connection says to start again, and diagnoses nothing", () => {
    const failure = describeStorageFailure("CONNECT_ATTEMPT_INVALID", undefined);
    expect(failure.headline).toContain("expired");
    expect(`${failure.next}`).toContain("Start it again");
    expect(`${failure.headline} ${failure.next}`).not.toMatch(/somebody else|not yours|no such/i);
  });

  test("a deployment with no Dropbox app says the bucket path still works", () => {
    expect(`${describeStorageFailure("DROPBOX_NOT_CONFIGURED", undefined).next}`).toContain(
      "bucket",
    );
  });

  test("a revoked grant says reconnect, and that the files are untouched", () => {
    const failure = describeStorageFailure("STORAGE_REAUTH_REQUIRED", undefined);
    expect(`${failure.next}`).toContain("Reconnect Dropbox");
    expect(`${failure.next}`).toContain("untouched");
  });

  /**
   * The one that matters most. The shared copy for these codes tells somebody
   * to paste an access key and secret — a credential a Dropbox binding has
   * never had. Advice naming a field that is not on the screen is worse than
   * no advice, and it trains the habit ("re-enter your credential to fix an
   * unrelated problem") that `reverifyStorage` exists to stop training.
   */
  test("no Dropbox failure ever tells somebody to paste an access key", () => {
    for (const code of [
      "UNREACHABLE",
      "NOT_WRITABLE",
      "CREDENTIAL_UNAVAILABLE",
      "STORAGE_NOT_CONNECTED",
    ]) {
      const dropbox = describeStorageFailure(code, undefined, "dropbox");
      expect(`${dropbox.headline} ${dropbox.next}`).not.toMatch(/access key|secret/i);
    }
  });

  test("the bucket wording is untouched when no provider is named", () => {
    expect(`${describeStorageFailure("CREDENTIAL_UNAVAILABLE", undefined).next}`).toContain(
      "access key",
    );
    expect(describeStorageFailure("UNREACHABLE", undefined).headline).toContain("bucket");
  });

  // Only the handful that differ are overridden. Everything else has to fall
  // through, or the table forks and the two halves drift.
  test("a code with no Dropbox override still gets the shared answer", () => {
    expect(describeStorageFailure("PROBE_FAILED", undefined, "dropbox")).toEqual(
      describeStorageFailure("PROBE_FAILED", undefined),
    );
  });

  test("an unknown code shrugs in the right vocabulary", () => {
    expect(describeStorageFailure("SOMETHING_NEW", undefined, "dropbox").headline).toContain(
      "Dropbox",
    );
    expect(describeStorageFailure("SOMETHING_NEW", undefined).headline).toContain("bucket");
  });

  test("a thrown ConvexError reaches the same table", () => {
    const failure = describeThrownStorageError(
      new ConvexError({ code: "NOT_OWNER", message: "Only the owner…" }),
      "dropbox",
    );
    expect(failure.headline).toContain("Only an owner");
    expect(failure.detail).toBe("Only the owner…");
  });
});

describe("the folder inside the app folder", () => {
  /**
   * `CLAUDE.md` permits a root prefix **the customer chose** and forbids us
   * deriving one. What it does not permit either way is a traversal, and the
   * Dropbox card asks the same question in different words — so it has to
   * refuse the same shapes as the bucket form rather than growing a second,
   * weaker copy of the rule.
   */
  test("the same rule guards both surfaces", () => {
    expect(validateRootPrefix("", "app folder")).toBe(undefined);
    expect(validateRootPrefix("second/", "app folder")).toBe(undefined);
    expect(validateRootPrefix("/second", "app folder")).toContain("No leading slash");
    expect(validateRootPrefix("a/../../b", "app folder")).toContain("`..`");
  });

  test("the noun follows the surface, so neither names the other's container", () => {
    expect(validateRootPrefix("/x", "app folder")).toContain("app folder");
    expect(validateRootPrefix("/x")).toContain("bucket");
  });
});
