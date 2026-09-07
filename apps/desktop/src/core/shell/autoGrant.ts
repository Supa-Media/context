/**
 * Getting this machine its grant **without asking a question that has already
 * been answered**, and the two bounded facts that takes.
 *
 * The owner's reaction to the first end-to-end desktop capture, 2026-09-07:
 * *"I don't love this setup; when installing Granola I didn't have to 'connect'
 * a machine, things just worked."* He was signed in inside this app's own
 * window and the app still put an approve screen in front of him to authorise
 * the same person, on the same machine, to the same context.
 *
 * #312 moved that screen into this window. This removes it, and removes
 * **only** it. Everything the grant is stays where it was: `packages/hook`'s
 * flow, dynamic registration of one client per machine, PKCE with S256, a
 * single-use `state`, a loopback listener on the port the OS handed out, and a
 * code exchanged in the main process. What changes is that the person's own
 * session — already loaded, in this window, at the pinned origin — answers the
 * parked request instead of a screen.
 *
 * ## The shape, and why it is this shape
 *
 * The gateway's `/oauth/authorize` **parks** the request and answers `302
 * Location: <console origin>/authorize?request_id=…`. That is the whole reason
 * this is possible without a navigation: the main process can follow that one
 * hop itself, with `redirect: "manual"`, read the id out of the `Location`, and
 * hand *the page* the id. No credential is in that request and none comes back
 * — a parked request id is the address of a question, and the answer to it is a
 * code that is delivered to this process's own loopback listener.
 *
 * So the window is never sent to the authorization server at all in the ordinary
 * case. It stays on the console, at the pinned origin, and makes exactly one
 * navigation: the loopback callback that `core/shell/approval.ts` already
 * bounds three ways. That is a **narrowing** of #312 rather than an addition to
 * it — the approve screen's own hop off the pin is now the fallback path.
 *
 * ## What must not move, and does not
 *
 *  - **The shell never receives the console's session.** It receives a request
 *    id it minted the flow for, and gets back a grant of its own.
 *  - **The page never receives the PKCE verifier**, the state, or the code. It
 *    receives an id and answers with a boolean; the code lands on the loopback
 *    listener, where the verifier that redeems it lives.
 *  - **The control plane decides.** `approveOwnMachineGrant` refuses anything
 *    but this client at this scope for an approver who can grant the tier, and
 *    a refusal is not a failure here: the shell falls back to the approve
 *    screen in its own window, which is exactly what #312 shipped.
 *  - **The pin does not widen.** Nothing here is a navigation rule; the one
 *    navigation this whole feature performs is still `mayNavigateConsoleWindow`'s
 *    to allow, and it still allows only the address this flow's own listener is
 *    on, only while the connect is in flight.
 *
 * Every function here is pure over strings, for the reason every guard in this
 * app is: `test/autoGrant.test.mjs` drives them with no Electron in the room.
 */

/**
 * The path the control plane's consent screen lives at.
 *
 * Not configurable and not read from anywhere: it is the route
 * `consentUrlFor` builds in `apps/convex/functions/lib/gatewayAuth.ts`, and a
 * `Location` that points anywhere else is a redirect this app declines to read
 * an id out of.
 */
const CONSENT_PATH = "/authorize";

/**
 * What a parked request id may look like.
 *
 * `randomOpaqueToken` produces base64url, and this app only ever *carries* the
 * value — so the check is a shape check rather than a parse: it is what stops
 * a `Location` that answered with a sentence, a URL, or a path fragment from
 * being handed to a page as though it were an id. A bound on the length for
 * the same reason every other bound in this app exists.
 */
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Read the gateway's redirect, and answer with the parked request id.
 *
 * `null` for everything this shell will not treat as its own flow's parked
 * request, and each refusal is a different thing going wrong:
 *
 *  - **a `Location` at any origin but the one this window is pinned to.** The
 *    console's session is the only thing that can answer this request, and a
 *    session belongs to an origin. A self-hoster who deliberately split the
 *    console and the consent screen onto different origins lands here and gets
 *    the approve screen instead, which is the same direction #312 chose when
 *    the pin refused a hop: *a pin a server can move is not a pin.*
 *  - **a `Location` at another path on that origin.** An open redirect, or a
 *    deployment that answered with something else entirely.
 *  - **no `request_id`, or one that is not shaped like one.** Nothing to hand
 *    over, so nothing is handed over.
 *
 * `consoleOrigin` is the origin the main process pinned the window to. An empty
 * one refuses everything, which is the honest answer from a launch that has no
 * console window: there is no page to answer with.
 *
 * ## The opaque origin is refused by name, on both sides
 *
 * `new URL("data:/authorize?request_id=…").origin` is the **string** `"null"`,
 * and so is a `file:` URL's, an `about:`'s, and every other scheme the URL
 * standard gives no tuple origin. Two of those compare equal to each other, so
 * an origin comparison that does not name the case is a comparison that would
 * hand a `data:` document a parked request id the moment the pinned origin were
 * ever opaque itself. It cannot be today — `consoleUrl` refuses everything but
 * `https` and loopback `http`, so `consoleOrigin` is always a real tuple — and
 * this is here because that is one function away, and because
 * `shouldExposeBridge` already refuses `"null"` by name for exactly this
 * reason. The one origin comparison in this shell that did not was this one.
 */
export function parkedRequestFrom(location: string, consoleOrigin: string): string | null {
  if (consoleOrigin === "" || consoleOrigin === "null") return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.origin === "null") return null;
  if (url.origin !== consoleOrigin) return null;
  if (url.pathname !== CONSENT_PATH) return null;
  const requestId = url.searchParams.get("request_id");
  if (requestId === null || !REQUEST_ID.test(requestId)) return null;
  return requestId;
}

/**
 * Whether this response is the parking redirect, rather than an answer.
 *
 * The gateway answers `302` with a `Location`; anything else — a rendered
 * OAuth error, a 200, a 500 from a deployment mid-restart — means there is no
 * parked request to hand anybody, and the approve screen is where this ends
 * up. `303` and `307` are accepted because a redirect is a redirect and this
 * app is reading a header rather than following anything.
 */
export function isParkingRedirect(status: number): boolean {
  return status === 302 || status === 303 || status === 307;
}

/** The approval this machine has handed to the page, while it holds one. */
export interface PendingApproval {
  /** The parked request the page is being asked to answer. */
  requestId: string;
  /** Where the window goes if the page cannot answer it. */
  authorize: string;
}

/**
 * The one pending approval, held between handing it over and hearing back.
 *
 * Single and module-scoped for `createApprovalRoute`'s reason: there is one
 * console window and `connectThisMachine` already refuses to run twice over.
 * `matches` is what makes a stale answer inert — a page that reloaded, a second
 * window, a message that arrived after the connect gave up — so an answer about
 * a request this machine is not waiting on does nothing at all.
 */
export interface ApprovalHandover {
  begin(pending: PendingApproval): void;
  /** The approval in flight, for the page to ask about. */
  pending(): PendingApproval | null;
  /**
   * The one in flight **if** the answer names it, and close the handover.
   *
   * `null` for an answer about anything else, which is the whole of the
   * staleness rule: acting on it would mean navigating a window on the say-so
   * of a message about a flow that is over.
   */
  take(requestId: string): PendingApproval | null;
  end(): void;
}

export function createApprovalHandover(): ApprovalHandover {
  let held: PendingApproval | null = null;
  return {
    begin(pending) {
      held = pending;
    },
    pending() {
      return held;
    },
    take(requestId) {
      if (held === null || held.requestId !== requestId) return null;
      const taken = held;
      held = null;
      return taken;
    },
    end() {
      held = null;
    },
  };
}
