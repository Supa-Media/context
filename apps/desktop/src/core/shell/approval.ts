/**
 * Approving this machine **inside the app's own window**, and the guard that
 * makes that one navigation and not a hole in the origin pin.
 *
 * The OAuth flow is unchanged and is still `packages/hook`'s: dynamic client
 * registration, PKCE with S256, a single-use `state`, a loopback listener on
 * `127.0.0.1` with the port the OS handed out, and a code exchanged in the main
 * process. What changes is **where the person sees the approve screen**. It
 * used to be the system browser, where they arrive signed out of a console they
 * are already signed in to here, sign in a second time, approve, and then read
 * "you can close this tab" in a window that is not the app. This routes the
 * same authorize URL into the console window, which already holds the session,
 * so the whole of it is: press Connect, press Approve.
 *
 * ## What is *not* moved by that, and must never be
 *
 *  - **The decision is still the control plane's.** The window is navigated to
 *    the authorization server's own `authorization_endpoint`; the shell renders
 *    no approve screen of its own and has no way to answer for one.
 *  - **The console's session is not sent to the gateway.** The window navigates;
 *    it does not carry anything. Cookies and stored tokens in the
 *    `persist:console` partition are the console origin's, and the gateway
 *    origin cannot read them — that is the same-origin policy, not a promise
 *    this file makes.
 *  - **Nothing credential-shaped crosses the bridge.** The code arrives at a
 *    loopback listener in the main process and is exchanged there. The page
 *    holds a URL for as long as it takes to navigate away from it, exactly as
 *    the system browser held one.
 *  - **The pin does not widen.** While the window sits on the gateway's
 *    authorize page, `pinnedOriginFor` answers "" and the bridge refuses that
 *    frame on every channel — a page at an origin we did not pin gets nothing,
 *    which is the rule `docs/decisions/desktop.md` already states.
 *
 * ## The one navigation this adds, and why it is bounded three ways
 *
 * The approve screen ends by navigating the window to the client's redirect
 * URI, which for a native client is `http://127.0.0.1:<port>/…`. The console
 * window's `will-navigate` guard refuses everything but the pinned origin and
 * the offline mirror, so that navigation has to be allowed — and it is allowed
 * *only*:
 *
 *  1. **while a connect is in flight** — `createApprovalRoute()` holds the
 *     target between `begin()` and `end()`, and answers `null` at every other
 *     moment, so a page that navigates itself to a loopback address on an
 *     ordinary afternoon is cancelled like any other off-origin target;
 *  2. **to the exact address this machine's listener is on** — origin *and*
 *     path, so neither another port on this machine (something else is
 *     listening there) nor another path on ours is a target;
 *  3. **as a loopback address** — `127.0.0.1`, never `localhost` resolved
 *     through DNS and never a hostname that merely contains it.
 *
 * The address is not typed anywhere: it is read out of the `redirect_uri` of
 * the authorize URL the flow itself just built from its own listener, so the
 * allowance cannot name a port the listener is not on.
 *
 * ## Why this module holds no Electron
 *
 * The same reason `main/connect.ts` imports it late and `main/consoleBridge.ts`
 * imports none: this is a guard, CLAUDE.md asks a guard for a test proving the
 * attack fails, and a module that imports `electron` cannot be loaded by a
 * suite that runs on plain Node. Every decision here is a pure function over
 * strings; `windows.ts` supplies the window and nothing else.
 */

import { isAllowedConsoleNavigation } from "./mirror.ts";

/**
 * The loopback hosts a redirect URI may name.
 *
 * `127.0.0.1` only, and deliberately not `localhost`: the name is resolved by
 * the OS and can be pointed at something that is not this machine, while the
 * literal cannot. `packages/hook`'s listener binds the literal, so nothing is
 * given up by refusing the name here.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1"]);

/** Where the window is sent, and the one address it may come back to. */
export interface ApprovalTarget {
  /** The authorization server's own authorize URL, with its query intact. */
  authorize: string;
  /** `http://127.0.0.1:<port><path>` — origin and path, without a query. */
  callback: string;
}

function parse(value: unknown): URL | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Read an authorize URL, and answer with what the window may do about it.
 *
 * `null` for anything this shell will not navigate its own window to, and each
 * refusal is a different attack:
 *
 *  - **not https, and not a loopback gateway** — the same rule `credentialUrlOk`
 *    applies to the endpoint itself. A discovery document that named an `http`
 *    authorization endpoint would otherwise put a person's approval, and the
 *    code that follows it, on the wire in clear. Loopback is exempted because
 *    that is how a self-hoster runs a gateway on their own machine.
 *  - **no loopback `redirect_uri`** — a flow whose code is not coming back to
 *    this process is not this machine's flow, and there would be nothing to
 *    allow through the navigation guard for it.
 *  - **a `redirect_uri` carrying a query or a fragment** — the callback is
 *    matched later on origin and path, so a target with extra parts in it is
 *    refused here rather than half-compared there.
 *
 * A `null` is not a failure of the connect: `main/index.ts` falls back to the
 * system browser, which is what this app did until now.
 */
export function approvalTargetFor(authorizeHref: string): ApprovalTarget | null {
  const url = parse(authorizeHref);
  if (url === null) return null;
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:") return null;
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  }

  const redirect = parse(url.searchParams.get("redirect_uri"));
  if (redirect === null) return null;
  if (redirect.protocol !== "http:") return null;
  if (!LOOPBACK_HOSTS.has(redirect.hostname)) return null;
  // A port the OS handed out. An absent one would mean port 80, which no
  // listener of ours is ever on.
  if (!(Number(redirect.port) > 0)) return null;
  if (redirect.search !== "" || redirect.hash !== "") return null;
  if (redirect.pathname === "" || redirect.pathname === "/") return null;

  return { authorize: url.href, callback: `${redirect.origin}${redirect.pathname}` };
}

/**
 * Whether this navigation is the callback the in-flight connect is waiting for.
 *
 * Origin **and** path, both exact. The query is not compared because it is
 * where the authorization code and the state live and the server chooses it —
 * and comparing it would be this process deciding whether a code looks right,
 * which is `stateMatches`'s job and happens in `connectMachine` a moment later.
 *
 * `callback === null` is the ordinary state of this app and refuses everything:
 * there is no connect in flight, so there is no loopback address the console
 * window is allowed to walk to.
 */
export function isApprovalCallback(target: string, callback: string | null): boolean {
  if (callback === null) return false;
  const expected = parse(callback);
  const url = parse(target);
  if (expected === null || url === null) return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  return url.origin === expected.origin && url.pathname === expected.pathname;
}

/**
 * The console window's whole navigation rule, in one place.
 *
 * `windows.ts` calls exactly this and cancels everything it refuses, so the
 * rule is checkable without an Electron binary — and so that the loopback
 * allowance can never be read as a second, looser guard sitting beside the
 * origin one. It is the same guard with one more, bounded, target.
 */
export function mayNavigateConsoleWindow(
  target: string,
  liveOrigin: string,
  callback: string | null,
): boolean {
  if (isAllowedConsoleNavigation(target, liveOrigin)) return true;
  return isApprovalCallback(target, callback);
}

/**
 * Where the window goes when the approval is over, however it ended.
 *
 * The loopback listener answers with a page that says "Connected", and leaving
 * somebody there is leaving them on a page served by a socket that has already
 * closed — a dead end wearing a success message. So the window is put back
 * where it was: the console page the person pressed Connect on, when that is
 * still a place this window may be, and the console's own address otherwise.
 *
 * The URL it came from is read off the window, which means it is influenced by
 * whatever the window last navigated to — so it is narrowed by the same guard
 * that decides every other navigation rather than trusted. A window that was
 * somewhere unexpected returns to the console, not to wherever that was.
 */
export function returnAfterApproval(
  from: string,
  consoleAddress: string,
  liveOrigin: string,
): string {
  return isAllowedConsoleNavigation(from, liveOrigin) ? from : consoleAddress;
}

/** The in-flight approval, held for as long as one is. */
export interface ApprovalRoute {
  /** Open the allowance. Answers the URL the window should load. */
  begin(target: ApprovalTarget, returnTo: string): string;
  /**
   * Close it, and say where the window belongs now.
   *
   * `null` when no in-window approval was open — a connect that went to the
   * system browser, or one that never started — so a caller cannot navigate a
   * window it never moved.
   */
  end(): string | null;
  /** The loopback address the window may reach right now, or `null`. */
  callback(): string | null;
}

export function createApprovalRoute(): ApprovalRoute {
  let callback: string | null = null;
  let returnTo: string | null = null;

  return {
    begin(target, back) {
      callback = target.callback;
      returnTo = back;
      return target.authorize;
    },
    end() {
      const back = returnTo;
      callback = null;
      returnTo = null;
      return back;
    },
    callback() {
      return callback;
    },
  };
}
