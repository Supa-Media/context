/**
 * When a person's own machine may have its grant minted **without an approve
 * screen**, expressed as one pure function.
 *
 * The owner's reaction to the first end-to-end desktop capture, 2026-09-07:
 * *"I don't love this setup; when installing Granola I didn't have to 'connect'
 * a machine, things just worked."* He was signed in inside the app's own window
 * and the app still asked him to authorise the same person, on the same
 * machine, to the same context.
 *
 * So the **step** goes and the **grant** stays. Non-negotiable #4 is untouched:
 * this still mints an ordinary OAuth grant row, one client per machine, at the
 * scope and tier the desktop asks for, revocable on its own from the
 * connections list, with an audit entry naming the person and the machine. What
 * this file decides is whether the approve screen has anything left to ask.
 *
 * ## The four conditions, and what each one is holding
 *
 *  1. **The client declared itself the desktop shell** (`softwareId`). RFC
 *     7591's `software_id` is *client-asserted* and this file says so out loud
 *     rather than pretending otherwise: anything that can register a client can
 *     claim this string. What it buys is not authentication, it is **scope** —
 *     no client that did not declare itself the shell is ever auto-approved, so
 *     the blast radius of this feature is one declared software id rather than
 *     "every OAuth client that reaches a signed-in console".
 *  2. **The code can only be delivered to this person's own machine.** Every
 *     registered redirect URI, and the one on the parked request, must be
 *     `http://127.0.0.1[:port]/<path>` — literal loopback, never `localhost`
 *     (a name somebody else's DNS can answer) and never a routable host. This
 *     is the condition that carries the weight: a forged `software_id` from a
 *     server on the internet still has nowhere to receive the code, because a
 *     loopback address is the machine the person is sitting at.
 *  3. **The request asks for exactly the default, and no more.** Set equality
 *     with `context:write context:private` — the desktop's `DESKTOP_SCOPE`.
 *     Not a subset, not a superset: a request that added `context:read` is a
 *     different question and gets the screen that asks it, and one that
 *     dropped `context:private` is the tier defect #312 fixed arriving by
 *     another door (a grant without the tier files every meeting team-visible).
 *  4. **The approver's role can actually grant that tier.** An editor or a
 *     member cannot hand over `context:private`, so auto-approving for them
 *     would silently mint the *narrower* grant they did not choose. Narrowing
 *     is exactly what a person is entitled to see, so they get the screen.
 *
 * ## What is deliberately not here
 *
 * Anything about *who is calling*. Identity, membership and the transaction are
 * the mutation's, and this function is handed facts rather than a `ctx` so it
 * can be driven exhaustively by the suite. The mutation must still check
 * membership itself, in the transaction that writes.
 */

import { SCOPE_PRIVATE, grantableTiers, parseScopeList } from "./consentScopes";

/**
 * The `software_id` the desktop shell registers itself with.
 *
 * A stable, public, deliberately boring string. Its twin is `DESKTOP_SOFTWARE_ID`
 * in `apps/desktop/src/main/connect.ts`, and two literals that must agree are
 * two literals that will drift — so both suites read the other file and assert
 * the pair, the way `linkParity.test.ts` already holds the link engine's twin
 * in the gateway.
 */
export const DESKTOP_SOFTWARE_ID = "lc.context.desktop";

/**
 * What the desktop asks for, and the whole of what may be auto-approved.
 *
 * `context:write` because a meeting is not a capture, `context:private`
 * because the tier decides what the meeting is *filed as*. No `context:read`:
 * a laptop credential that could read every note its owner ever wrote is past
 * what this feature is worth, and it is past what anybody would auto-approve.
 */
export const MACHINE_GRANT_SCOPES: readonly string[] = Object.freeze([
  "context:write",
  SCOPE_PRIVATE,
]);

/** Why an auto-approval was refused, as a word for the audit and the tests. */
export type MachineApprovalRefusal =
  /** The client did not declare itself the desktop shell. */
  | "not-the-desktop-shell"
  /** A redirect URI that is not loopback on this machine. */
  | "not-loopback"
  /** The request asked for something other than exactly the default. */
  | "scope-is-not-the-default"
  /** This approver's role cannot hand over the tier the default names. */
  | "tier-not-grantable";

export type MachineApproval =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: MachineApprovalRefusal };

/** Everything the decision reads, and nothing that could stand in for auth. */
export interface MachineApprovalFacts {
  /** `software_id` as the client registered it, or `undefined` for none. */
  clientSoftwareId?: string | null;
  /** Every redirect URI the client registered. All must be loopback. */
  clientRedirectUris: readonly string[];
  /** The redirect URI on the parked request itself. */
  requestRedirectUri: string;
  /** The raw scope string the client asked for. */
  requestScope: string;
  /** The approver's role in the workspace this would grant. */
  role: string;
}

/**
 * Loopback, literally.
 *
 * `127.0.0.1` and nothing else. `localhost` is a name the OS resolves and
 * somebody else's DNS can answer, `127.0.0.2` is still this machine but is not
 * what `packages/hook`'s listener binds, and `127.0.0.1.attacker.invalid` is a
 * routable host that merely reads like loopback. The port is optional because
 * the *registered* URI has none — the OS hands one out per connect and
 * `redirectUriMatches` in the gateway is what allows it to float — while the
 * parked request carries the port the listener actually got.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return url.pathname !== "" && url.pathname !== "/";
}

/**
 * The requested scope, as a set, compared against the default exactly.
 *
 * Literal spellings only. `consentScopes.ts` honours aliases — `*`, `all`,
 * `context.private` all name the private tier — and none of them is normalised
 * here on purpose: the desktop sends two exact strings, so anything else is a
 * request this app did not make and gets the screen rather than a translation.
 * Fail closed, and let the person read what is actually being asked for.
 */
function isDefaultMachineScope(scope: string): boolean {
  const asked = new Set(parseScopeList(scope));
  if (asked.size !== MACHINE_GRANT_SCOPES.length) return false;
  return MACHINE_GRANT_SCOPES.every((entry) => asked.has(entry));
}

/**
 * May this parked request be approved with no screen, for this approver?
 *
 * Every `false` is a fallback rather than a failure: the shell puts the ordinary
 * approve screen in its own window and the person answers it, which is exactly
 * what shipped in #312. Nothing here refuses a *person* anything — it refuses to
 * decide **for** them.
 */
export function decideMachineApproval(facts: MachineApprovalFacts): MachineApproval {
  if (facts.clientSoftwareId !== DESKTOP_SOFTWARE_ID) {
    return { ok: false, reason: "not-the-desktop-shell" };
  }
  if (
    facts.clientRedirectUris.length === 0 ||
    !facts.clientRedirectUris.every(isLoopbackRedirect) ||
    !isLoopbackRedirect(facts.requestRedirectUri)
  ) {
    return { ok: false, reason: "not-loopback" };
  }
  if (!isDefaultMachineScope(facts.requestScope)) {
    return { ok: false, reason: "scope-is-not-the-default" };
  }
  // The tier is not decoration: a grant without `context:private` files every
  // meeting this machine records at team visibility, in the customer's own
  // `privacy.md`. An approver who cannot hand it over is being narrowed, and a
  // narrowing is the thing a person is most entitled to be shown.
  if (!grantableTiers(facts.role).includes("private")) {
    return { ok: false, reason: "tier-not-grantable" };
  }
  return { ok: true, scopes: [...MACHINE_GRANT_SCOPES] };
}
