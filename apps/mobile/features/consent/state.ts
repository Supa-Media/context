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
import {
  grantableTiers,
  isTierScope,
  normalizeScopes,
  roleCanGrantScope,
  scopeLine,
  SCOPE_PRIVATE,
  tierOption,
  type GrantableTier,
  type ScopeLine,
  type VisibilityTier,
} from "./scopes";

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
  /**
   * Which requested operations the person has left ticked, or `null` while
   * they have not touched the list.
   *
   * `null` is not the same as `[]`. Untouched means "everything the client
   * asked for that this approver can hand over", which is what the screen
   * arrives showing; an empty array means they unticked all of it, which is a
   * real state the screen has to refuse rather than silently reinterpret.
   */
  chosenScopes: readonly string[] | null;
  /** Which tier the person picked, or `null` while they have not chosen. */
  chosenTier: GrantableTier | null;
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
      contexts: ConsentContext[];
      selectedContextId: string | null;
      /** True when the person genuinely has a choice of context to make. */
      contextIsAChoice: boolean;
      /**
       * One row per operation the client asked for, in the order it asked.
       *
       * `granted` is the tick. `line` describes it at the tier currently
       * selected, so unticking private-tier rewrites the read line in place
       * rather than leaving a sentence that stopped being true.
       */
      scopeChoices: ScopeChoice[];
      /**
       * Operations the client asked for that this approver may not hand over.
       *
       * Shown, never ticked, never granted. Hiding them would mean the screen
       * quietly dropped part of what was asked — and "the client wanted this and
       * you cannot give it" is exactly the thing a person needs told when their
       * AI client half-works afterwards.
       */
      withheldScopes: ScopeChoice[];
      /** How much of the context this approval hands over. */
      tier: TierControl;
      /**
       * Precisely what Approve will send — the ticked operations plus the tier
       * scope when private was chosen.
       *
       * The screen reads this rather than rebuilding it at press time, so what
       * is displayed and what is submitted are the same value.
       */
      grantedScopes: string[];
      canApprove: boolean;
      busy: null | "approve" | "deny";
      error?: ConsentError;
      expiresAt: number;
    }
  /** Decided. The browser is on its way back to the client. */
  | { kind: "leaving"; choice: "approve" | "deny"; redirectTo: string };

/** One requested operation, and whether it is being handed over. */
export interface ScopeChoice {
  /** The raw scope string. The key, because it is what gets submitted. */
  scope: string;
  line: ScopeLine;
  granted: boolean;
}

/** The privacy tier, as a control. */
export interface TierControl {
  /** What this approval would hand over. Never `unknown` once a context is picked. */
  selected: VisibilityTier;
  /**
   * The options to draw. One entry means there is no decision to make and the
   * screen states the tier instead of asking — a radio group with a single
   * option is a control that pretends the person chose.
   */
  options: Array<{ value: GrantableTier; label: string; detail: string }>;
  isAChoice: boolean;
}

/**
 * The safe default, and it is not the approver's ceiling.
 *
 * An owner arriving at this screen is not asked to opt *out* of handing over
 * every private note they have ever written. They are asked to opt in. That
 * inversion is the whole point of the feature: the old behaviour was
 * private-by-default with no way out, and a default that reproduces it with a
 * radio button next to it has changed nothing.
 */
const DEFAULT_TIER: GrantableTier = "team";

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

  // Everything below depends on the *selected* context's role, not on the
  // account. Someone who owns one context and is a member of another gets a
  // different set of controls as they move the picker, and both are true.
  // `null` when nothing is picked yet, which the tier says out loud rather than
  // guessing at.
  const chosenRole = inputs.contexts.find((context) => context.id === chosen)?.role ?? null;
  const tier = resolveTier(chosenRole, inputs.chosenTier, chosen !== null);
  const { granted, withheld } = splitRequestedScopes(
    request,
    chosenRole,
    inputs.chosenScopes,
    tier.selected,
  );

  // The tier rides along as a scope, because that is how it is recorded and
  // enforced. Appending it here rather than at press time means the list the
  // screen shows and the list it submits are literally the same array.
  const grantedScopes = granted
    .filter((choice) => choice.granted)
    .map((choice) => choice.scope);
  if (tier.selected === "private") grantedScopes.push(SCOPE_PRIVATE);

  return {
    kind: "ready",
    clientName: request.clientName,
    redirectHost: redirectHost(request.redirectUri),
    contexts: inputs.contexts,
    selectedContextId: chosen,
    contextIsAChoice: inputs.contexts.length > 1,
    scopeChoices: granted,
    withheldScopes: withheld,
    tier,
    grantedScopes,
    // An approval with no operation ticked grants nothing, so it is not an
    // approval. The backend refuses it too — this only spares somebody the
    // round trip, and must never be the only place it is refused.
    canApprove:
      chosen !== null && busy === null && granted.some((choice) => choice.granted),
    busy,
    error: inputs.decision.kind === "idle" ? inputs.decision.error : undefined,
    expiresAt: request.expiresAt,
  };
}

/**
 * The scope set after one tick box changes.
 *
 * Derived from the rows the screen is currently showing rather than from
 * whatever was last stored, because the first toggle is also what turns
 * "untouched" into an explicit set — and "untouched" has no array to add to or
 * remove from. Reading the rows means the answer is always exactly what is on
 * screen, including the rows this approver's role already removed.
 *
 * Exported so the screen is a thin wrapper over it: a narrowing that only
 * exists inside a component is a narrowing no test can reach.
 */
export function toggleScopeSelection(
  choices: readonly ScopeChoice[],
  scope: string,
  next: boolean,
): string[] {
  return choices
    .filter((choice) => (choice.scope === scope ? next : choice.granted))
    .map((choice) => choice.scope);
}

/**
 * The tier this approval would grant, and whether it is a choice at all.
 *
 * Defaults to `team` for everybody, including an owner. A person who has not
 * picked a context yet gets `unknown` — the screen says so rather than naming a
 * tier it cannot stand behind — and no options, because there is nothing yet to
 * choose between.
 *
 * A choice that names a tier this role cannot grant is discarded rather than
 * honoured: the picker can move after a tier was picked, and an owner's
 * `private` must not survive a switch into a context where they are a member.
 * The backend clamps too; this keeps the screen from displaying a promise the
 * backend is about to break.
 */
function resolveTier(
  role: string | null,
  chosen: GrantableTier | null,
  contextPicked: boolean,
): TierControl {
  if (!contextPicked || role === null) {
    return { selected: "unknown", options: [], isAChoice: false };
  }
  const available = grantableTiers(role);
  const selected =
    chosen !== null && available.includes(chosen) ? chosen : DEFAULT_TIER;
  return {
    selected,
    options: available.map((value) => ({ value, ...tierOption(value) })),
    isAChoice: available.length > 1,
  };
}

/**
 * The requested operations, split into what this approver can hand over and
 * what they cannot.
 *
 * The tier scope is filtered out of both halves. A client may legitimately ask
 * for `context:private`, but on this screen the tier is its own control, and
 * listing it twice — once as a permission to tick and once as a privacy setting
 * — would let a person tick one, clear the other, and have no idea which won.
 *
 * `chosen === null` means the person has not touched the list, so everything
 * grantable arrives ticked: the screen opens showing what the client asked for,
 * and narrowing is something they do, not something they have to undo.
 */
function splitRequestedScopes(
  request: AuthorizationRequest,
  role: string | null,
  chosen: readonly string[] | null,
  tier: VisibilityTier,
): { granted: ScopeChoice[]; withheld: ScopeChoice[] } {
  const requested = normalizeScopes(requestScopes(request)).filter(
    (scope) => !isTierScope(scope),
  );
  const ticked = chosen === null ? null : new Set(chosen);

  const granted: ScopeChoice[] = [];
  const withheld: ScopeChoice[] = [];
  for (const scope of requested) {
    const line = scopeLine(scope, tier);
    if (role !== null && !roleCanGrantScope(role, scope)) {
      withheld.push({ scope, line, granted: false });
      continue;
    }
    granted.push({ scope, line, granted: ticked === null || ticked.has(scope) });
  }
  return { granted, withheld };
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
