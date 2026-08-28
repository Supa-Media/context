/**
 * Connecting a context to Dropbox, as data.
 *
 * The rules live here rather than inside the two components that use them, for
 * the reason `invite.ts` gives: a redirect rule looks right when you click it
 * and is wrong when somebody reloads, so every rule is an exported function
 * with a test rather than an `if` inside something nobody can mount.
 *
 * ## What this path is for
 *
 * Dropbox is the **one-click tier**, and it exists because R2 asks for a
 * payment method before it hands out a free bucket. That is a real wall in
 * front of somebody who has never made a bucket and never will. It does not
 * replace the bucket path: an S3-compatible bucket is still the answer for
 * anybody who wants the storage to answer to nobody but them, and both are on
 * screen together rather than one being the default and the other a link.
 *
 * ## Why the client never sees a verifier, a code challenge, or the app key
 *
 * `startDropboxConnect` returns a URL and nothing else. Everything that proves
 * the flow — the PKCE verifier, the state, the app key — is parked in the
 * control plane. So there is nothing here to steal from, and nothing here that
 * has to be kept out of a public repository's bundle.
 *
 * ## Why the redirect URI is chosen from a fixed list rather than built
 *
 * Dropbox matches `redirect_uri` exactly against what is registered, and only
 * two are: the apex and the local dev server. Handing it
 * `http://localhost:8081/connect/dropbox` — the Expo dev server's usual port —
 * ends on Dropbox's own error page, which says nothing a person can act on and
 * leaves them on a domain that is not ours. So an origin we do not recognise
 * produces `null` and the card says where the flow does work, rather than
 * sending somebody out to find that out.
 */

import { CONSOLE_ROUTE, loginHref } from "../../auth/redirect";
import { settingsHref } from "../nav";
import { connectProgress, type WatchedBinding } from "../../onboarding/verify";
import { describeStorageFailure, type StorageFailure } from "./errors";

/**
 * The path Dropbox sends the browser back to.
 *
 * Registered with Dropbox, so this is not ours to rename on our own — the
 * route file at `app/connect/dropbox.tsx` and the two origins below have to
 * keep agreeing with what the Dropbox app console holds.
 */
export const DROPBOX_CALLBACK_PATH = "/connect/dropbox";

/**
 * The origins whose callback URL Dropbox will accept.
 *
 * `context.lc` is the apex the router fronts (see `infra/router/src/route.ts`:
 * every page path proxies to the Expo web app, so this route is served there),
 * and `localhost:4601` is the local web server. Nothing else is registered.
 */
export const DROPBOX_REDIRECT_ORIGINS: readonly string[] = Object.freeze([
  "https://context.lc",
  "http://localhost:4601",
]);

/**
 * The redirect URI to start a connect with, or `null` where there is not one.
 *
 * `null` is not a failure to handle quietly: it is the answer on a native
 * build (no browser origin at all) and on any web origin Dropbox does not
 * know, and in both cases the honest move is to say where this works instead
 * of starting a flow that cannot finish.
 */
export function dropboxRedirectUri(origin: string | null | undefined): string | null {
  if (typeof origin !== "string") return null;
  // Exact match, for the same reason `redirectUriMatches` and the gateway's
  // origin allow-list are exact: a prefix or suffix rule here is a rule an
  // attacker gets to satisfy with a hostname of their choosing.
  if (!DROPBOX_REDIRECT_ORIGINS.includes(origin)) return null;
  return `${origin}${DROPBOX_CALLBACK_PATH}`;
}

/**
 * This browser's origin, or `null` when there is no browser.
 *
 * React Native defines a global `window` with no `location` on it, so the
 * check is for the property rather than for the global — testing `typeof
 * window` alone reports "we are in a browser" on a phone.
 */
export function browserOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  const origin = location?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : null;
}

/**
 * Is this URL somewhere we are willing to send a person?
 *
 * The URL comes from our own control plane, which built it from a constant.
 * The check runs anyway, for `redirectSafety.ts`'s reason: a navigation target
 * assembled somewhere else is exactly the value you do not hand to a
 * navigation API on trust. A misconfigured or compromised deployment would
 * otherwise turn "Connect Dropbox" into an open redirect that a person clicks
 * on purpose.
 */
export function isDropboxAuthorizeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === "www.dropbox.com" || parsed.hostname === "dropbox.com";
}

/** What the callback URL carries. */
export type DropboxCallback =
  /** Both halves present. Only this one is worth calling the backend with. */
  | { kind: "ready"; code: string; state: string }
  /** Dropbox says the person pressed Cancel. Not a failure; an answer. */
  | { kind: "cancelled" }
  /** Neither a code nor a refusal. Somebody opened the bare path. */
  | { kind: "incomplete" };

/**
 * Expo Router hands back `string | string[]`, and `undefined` when absent.
 *
 * Same shape as `firstParam` in `invite.ts` and for the same reason: a
 * duplicated query parameter arrives as an array, and `?code=` with nothing
 * after it arrives as an empty string, which is not a code.
 */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Read the callback.
 *
 * A refusal is checked **before** the code, because Dropbox sends `state` back
 * with `error=access_denied` too: reading the code first would show somebody
 * who pressed Cancel a spinner and then a failure, when what happened is that
 * they said no.
 *
 * A code with no state is `incomplete`, never `ready`. `state` is the only
 * thing binding this code to the flow that started it — see the docstring on
 * `apps/convex/functions/dropboxConnect.ts` for what happens without one — so
 * sending a bare code up to be exchanged is asking the backend to do something
 * it correctly refuses.
 */
export function parseDropboxCallback(params: {
  code?: string | string[];
  state?: string | string[];
  error?: string | string[];
}): DropboxCallback {
  if (firstParam(params.error) !== null) return { kind: "cancelled" };
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  if (code === null || state === null) return { kind: "incomplete" };
  return { kind: "ready", code, state };
}

/** The callback URL as a path, so sign-in can carry it and come back to it. */
export function dropboxCallbackHref(callback: DropboxCallback): string {
  if (callback.kind !== "ready") return DROPBOX_CALLBACK_PATH;
  const query = new URLSearchParams({ code: callback.code, state: callback.state });
  return `${DROPBOX_CALLBACK_PATH}?${query.toString()}`;
}

/** What `completeDropboxConnect` is doing, on the callback screen. */
export type DropboxAttempt =
  | { kind: "running" }
  | { kind: "failed"; failure: StorageFailure }
  /** The exchange is queued. The binding is what says whether it worked. */
  | { kind: "queued"; workspaceId: string };

/** What the person is doing on a card that starts the flow. */
export type DropboxStartState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; failure: StorageFailure };

export type DropboxCallbackView =
  /** Auth is still resolving. Render nothing rather than flashing a screen. */
  | { kind: "wait" }
  /**
   * Queued by a signed-out finisher. The exchange needs no session — PKCE
   * binds the code to the parked attempt — but *watching* the result does,
   * so the honest terminal state is "finishing; sign in to see it land".
   */
  | { kind: "finishing"; href: string }
  /** They pressed Cancel on Dropbox's own screen. */
  | { kind: "cancelled" }
  /** No code and no refusal — there is nothing here to finish. */
  | { kind: "incomplete" }
  /** The exchange is in flight, or queued and the probe has not reported. */
  | { kind: "working"; message: string }
  | { kind: "connected"; href: string }
  | { kind: "failed"; failure: StorageFailure }
  /** Queued, and nothing came back inside the window. Not a failure. */
  | { kind: "timeout"; message: string };

/**
 * We stopped waiting on the probe.
 *
 * Deliberately not "it failed". `exchangeAndBind` schedules the verification
 * exactly as `bindStorage` does, so a slow answer is a slow answer — and the
 * console reads the binding reactively, so an outcome that lands later shows
 * up there without anybody reloading this page.
 */
export const DROPBOX_TIMEOUT_MESSAGE =
  "Still waiting on Dropbox. Nothing is lost — your context's storage shows the result as soon as the check lands.";

export function resolveDropboxCallbackView(inputs: {
  callback: DropboxCallback;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  /** `undefined` until the exchange has been asked for. */
  attempt: DropboxAttempt | undefined;
  /** The row: `undefined` while loading, `null` when there is none yet. */
  binding: (WatchedBinding & { provider?: string }) | null | undefined;
  /** The slug of the context that was connected, when it is known. */
  slug: string | null;
  timedOut: boolean;
}): DropboxCallbackView {
  // Both of these are answers about the URL itself and need no session to
  // read, so they come first: bouncing somebody to sign in to be told they
  // pressed Cancel is ceremony over an answer they already gave.
  if (inputs.callback.kind === "cancelled") return { kind: "cancelled" };
  if (inputs.callback.kind === "incomplete") return { kind: "incomplete" };

  // THERE IS DELIBERATELY NO SIGN-IN WALL HERE. The first live run lost the
  // session on the OAuth round trip (a refresh-token rotation dropped
  // mid-redirect reads as reuse and kills the grant), and the email OTP that
  // followed cost more time than Dropbox's single-use code lives — the wall
  // was the only thing that made the connect fail. The exchange needs no
  // session: PKCE binds the code to the parked attempt, and the attempt
  // already names the workspace and the person. See `completeDropboxConnect`.
  if (inputs.attempt === undefined || inputs.attempt.kind === "running") {
    return { kind: "working", message: "Finishing the connection with Dropbox…" };
  }
  if (inputs.attempt.kind === "failed") {
    return { kind: "failed", failure: inputs.attempt.failure };
  }

  // Queued. Watching the result is the one part that does need a session —
  // `getStorageBinding` answers only the workspace's own members — so a
  // signed-out finisher gets the truth instead of a watch that cannot run:
  // the connection is finishing server-side, and their console will show it.
  if (inputs.auth.isLoading) return { kind: "wait" };
  if (!inputs.auth.isAuthenticated) {
    return { kind: "finishing", href: loginHref(CONSOLE_ROUTE) };
  }

  // The exchange, the binding write and the probe all happen out of
  // reach of this caller — `completeDropboxConnect` schedules them so that no
  // public function ever has a credential in scope — so the row is the only
  // thing that can say what happened. Same watch the bucket path already runs
  // after `bindStorage`, reusing its state machine rather than a second copy.
  const progress = connectProgress({
    submitted: true,
    binding: inputs.binding,
    timedOut: inputs.timedOut,
  });

  switch (progress.kind) {
    case "connected":
      return {
        kind: "connected",
        href: inputs.slug === null ? CONSOLE_ROUTE : settingsHref(inputs.slug),
      };
    case "failed":
      return { kind: "failed", failure: progress.failure };
    case "timeout":
      return { kind: "timeout", message: DROPBOX_TIMEOUT_MESSAGE };
    default:
      return { kind: "working", message: "Checking that we can read and write that folder…" };
  }
}

/**
 * A binding in `error` on the callback screen, described with the provider in
 * hand.
 *
 * Exported so the screen does not have to reach back into `errors.ts` for the
 * one call it makes, and so the provider argument is not something a caller
 * can forget — a Dropbox failure described as a bucket failure tells somebody
 * to paste an access key they have never had.
 */
export function describeDropboxFailure(
  errorCode: string | undefined,
  message: string | undefined,
): StorageFailure {
  return describeStorageFailure(errorCode, message, "dropbox");
}
