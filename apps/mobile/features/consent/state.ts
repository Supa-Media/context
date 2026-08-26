/**
 * What the consent screen is showing, as a pure function of what it knows.
 *
 * This is where the screen's honesty lives, so it is testable without a
 * renderer, a router, or a backend.
 *
 * Two rules are encoded here rather than left to the component:
 *
 *  - **Every way a request can be unusable produces the same view.** Expired,
 *    already spent, never existed, belongs to someone else — one message, one
 *    shape. A `requestId` is a capability, and telling whoever is guessing them
 *    which guesses landed is the whole attack. `getAuthorizationRequest`
 *    already collapses these into a single `null`; the screen must not
 *    helpfully un-collapse them by treating "we got null" and "we got a row
 *    that expired while I read it" differently.
 *  - **Nothing is decided in advance.** `ready` carries no default decision, and
 *    the component reads `canApprove` rather than inferring one.
 */

import { loginHref } from "../auth/redirect";
import { scopeSentences, type ScopeLine } from "./scopes";

/** One of the caller's own contexts, as the picker needs it. */
export interface ConsentContext {
  id: string;
  slug: string;
  role: string;
}

/**
 * The parked request, as `getAuthorizationRequest` returns it.
 *
 * `scope` and `scopes` are the same thing twice — the raw OAuth string and the
 * split array. Both are accepted and optional here so the screen survives the
 * backend settling on one; `scopeSentences` takes either.
 */
export interface AuthorizationRequest {
  requestId: string;
  clientName: string;
  /** Where the code would be sent. Shown, because that is what consent is about. */
  redirectUri: string;
  scope?: string | null;
  scopes?: readonly string[] | null;
  /** The slug the client asked for, echoed only when the caller belongs to it. */
  requestedWorkspaceSlug?: string | null;
  /** The context this would grant if approved with no explicit choice. */
  workspaceSlug?: string | null;
  expiresAt: number;
}

/** What the person is part-way through doing. */
export type ConsentDecision =
  | { kind: "idle"; error?: ConsentError }
  | { kind: "submitting"; choice: "approve" | "deny" }
  | { kind: "leaving"; choice: "approve" | "deny"; redirectTo: string };

export interface ConsentError {
  headline: string;
  next?: string;
}

/**
 * The request query's result, as `useQueries` reports it: `undefined` in
 * flight, `Error` when the query threw, `null` when the request is unusable.
 *
 * The `Error` case is not incidental. `getAuthorizationRequest` throws
 * `NO_GRANTABLE_WORKSPACE` for an account with nowhere to grant access to, and
 * that is a screen of its own — "you don't have a context yet" — not a broken
 * link.
 */
export type RequestResult = AuthorizationRequest | null | Error | undefined;

export interface ConsentInputs {
  /** `request_id` from the URL. Absent when someone opened `/authorize` by hand. */
  requestId: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  request: RequestResult;
  /** `undefined` while the workspace list is in flight. */
  contexts: ConsentContext[] | undefined;
  /** Which context the person picked, if they picked one. */
  chosenContextId: string | null;
  decision: ConsentDecision;
  now: number;
}

export type ConsentView =
  /** Auth is still resolving. Render nothing rather than flashing a screen. */
  | { kind: "wait" }
  /** Signed out. The request id rides along so we come back to it. */
  | { kind: "signIn"; href: string }
  /** Signed in; the request or the context list is still loading. */
  | { kind: "loading" }
  /** The one message every unusable request gets. */
  | { kind: "invalid"; headline: string; detail: string }
  /** Signed in against an account with nowhere to grant access to. */
  | { kind: "noContext"; clientName: string | null }
  | {
      kind: "ready";
      clientName: string;
      /** The host of the redirect URI — "which site am I handing this to". */
      redirectHost: string;
      scopeLines: ScopeLine[];
      contexts: ConsentContext[];
      selectedContextId: string | null;
      /** True when the person genuinely has a choice of context to make. */
      contextIsAChoice: boolean;
      canApprove: boolean;
      busy: null | "approve" | "deny";
      error?: ConsentError;
      expiresAt: number;
    }
  /** Decided. The browser is on its way back to the client. */
  | { kind: "leaving"; choice: "approve" | "deny"; redirectTo: string };

const INVALID: Extract<ConsentView, { kind: "invalid" }> = {
  kind: "invalid",
  headline: "This link isn't valid any more",
  detail:
    "Authorization links are single-use and expire after a few minutes. Ask the app to connect again and it will send you a fresh one.",
};

/** The `code` on a thrown `ConvexError`, when there is one. */
export function errorCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The scopes on a request, whichever field name they arrived under. */
export function requestScopes(
  request: AuthorizationRequest,
): string | readonly string[] | null {
  return request.scopes ?? request.scope ?? null;
}

/**
 * Which context should be selected before the person touches anything.
 *
 * `workspaceSlug` is the backend's own resolution — the context it would grant
 * if approved with no explicit choice, already narrowed to the caller's
 * memberships and already refined by whatever the client asked for. So it is
 * the hint, and `requestedWorkspaceSlug` is only a fallback for a contract that
 * omits it.
 *
 * A single context selects itself, because there is no choice being made. More
 * than one and no usable hint means nothing is selected: the screen asks.
 */
export function preselectSlug(request: AuthorizationRequest): string | null {
  return request.workspaceSlug ?? request.requestedWorkspaceSlug ?? null;
}

export function defaultContextId(
  contexts: readonly ConsentContext[],
  hint: string | null,
): string | null {
  if (contexts.length === 0) return null;
  if (hint !== null) {
    const bare = hint.startsWith("@") ? hint.slice(1) : hint;
    const match = contexts.find((context) => context.slug === bare);
    if (match !== undefined) return match.id;
  }
  if (contexts.length === 1) return contexts[0].id;
  return null;
}

/**
 * How to name the place a code would be sent, in one phrase.
 *
 * For a hosted client that is the host, because "claude.ai" is what a person
 * recognises. For a desktop or CLI client registering a custom scheme it is the
 * scheme too: `URL` parses `cursor://auth/callback` with a host of `auth`, and
 * "Approving sends it back to auth" tells nobody anything, where
 * "cursor://auth" is at least honest about what it is.
 *
 * A URI that will not parse is shown raw rather than hidden. This value is only
 * ever rendered as text.
 */
export function redirectHost(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return uri;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.host;
  return `${parsed.protocol}//${parsed.host}`;
}

export function resolveConsentView(inputs: ConsentInputs): ConsentView {
  if (inputs.decision.kind === "leaving") {
    return {
      kind: "leaving",
      choice: inputs.decision.choice,
      redirectTo: inputs.decision.redirectTo,
    };
  }

  if (inputs.auth.isLoading) return { kind: "wait" };

  if (!inputs.auth.isAuthenticated) {
    // No request id means there is nothing worth coming back for, so the login
    // link is the plain one rather than one carrying an empty parameter.
    const href =
      inputs.requestId === null
        ? loginHref(null)
        : loginHref(`/authorize?request_id=${encodeURIComponent(inputs.requestId)}`);
    return { kind: "signIn", href };
  }

  // Someone typed `/authorize` in by hand, or a client dropped the parameter.
  // Same message as every other unusable case: this screen never confirms or
  // denies that any particular request id exists.
  if (inputs.requestId === null) return INVALID;

  if (inputs.request instanceof Error) {
    const code = errorCodeOf(inputs.request);
    if (code === "NO_GRANTABLE_WORKSPACE") return { kind: "noContext", clientName: null };
    // Anything else — including a session that expired between the redirect and
    // the query — is not something to diagnose on a page holding someone else's
    // request id.
    return INVALID;
  }

  if (inputs.request === undefined || inputs.contexts === undefined) {
    return { kind: "loading" };
  }

  if (inputs.request === null) return INVALID;
  // A request whose window closed while the screen sat open. Approving would
  // fail at the backend anyway; failing here keeps the message identical.
  if (inputs.request.expiresAt <= inputs.now) return INVALID;

  const request = inputs.request;

  if (inputs.contexts.length === 0) {
    return { kind: "noContext", clientName: request.clientName };
  }

  const preselected = defaultContextId(inputs.contexts, preselectSlug(request));
  // An explicit choice wins, but only while it still names a context the person
  // belongs to — a workspace can be left with this screen open.
  const chosen =
    inputs.chosenContextId !== null &&
    inputs.contexts.some((context) => context.id === inputs.chosenContextId)
      ? inputs.chosenContextId
      : preselected;

  const busy = inputs.decision.kind === "submitting" ? inputs.decision.choice : null;

  return {
    kind: "ready",
    clientName: request.clientName,
    redirectHost: redirectHost(request.redirectUri),
    scopeLines: scopeSentences(requestScopes(request)),
    contexts: inputs.contexts,
    selectedContextId: chosen,
    contextIsAChoice: inputs.contexts.length > 1,
    canApprove: chosen !== null && busy === null,
    busy,
    error: inputs.decision.kind === "idle" ? inputs.decision.error : undefined,
    expiresAt: request.expiresAt,
  };
}

/**
 * Turn a thrown Convex error into something to read.
 *
 * A failed *approval* deliberately does not explain which check failed, for the
 * same reason `INVALID` does not: the page is holding a request id, and the
 * difference between "that request was already spent" and "that request never
 * existed" is exactly what someone guessing ids wants told.
 */
export function describeDecisionFailure(
  error: unknown,
  choice: "approve" | "deny",
): ConsentError {
  switch (errorCodeOf(error)) {
    case "AUTHORIZATION_REQUEST_NOT_FOUND":
      return {
        headline: "This link isn't valid any more",
        next: "Ask the app to connect again and it will send you a fresh one.",
      };
    case "NOT_AUTHENTICATED":
      return {
        headline: "Your session ended while this page was open",
        next: "Sign in again and the app can send you a new link.",
      };
    case "NO_GRANTABLE_WORKSPACE":
      return {
        headline: "You don't have a context to share yet",
        next: "Create one from your console, then connect the app again.",
      };
    case "WORKSPACE_NOT_FOUND":
    case "INSUFFICIENT_ROLE":
      return {
        headline: "You don't have access to that context any more",
        next: "Pick a different one, or ask its owner to add you back.",
      };
    default:
      return {
        headline:
          choice === "approve" ? "Couldn't approve this request" : "Couldn't refuse this request",
        next: "Nothing was granted. Check your connection and try again.",
      };
  }
}
