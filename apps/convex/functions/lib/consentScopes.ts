/**
 * What a person may hand an AI client, and what a grant records about it.
 *
 * This is the control plane's half of the scope contract. The gateway has its
 * own copy of the same vocabulary in `apps/mcp/src/session.js` — it is a
 * dependency-free Worker and cannot import this file — and the two enforce the
 * same rule at two different moments: this one decides **what gets written into
 * the grant**, and the gateway decides **what a live request may do with it**.
 * Neither is a substitute for the other. A grant that was never allowed to
 * carry a scope is the durable fix; a gateway clamp is what catches a
 * membership that changed after the grant was written.
 *
 * ## The privacy tier is a scope, and it is the only representation of itself
 *
 * `context:private` is the whole tier mechanism. A grant that carries it
 * reaches notes marked private; a grant that does not, does not. There is no
 * second field, no `visibilityTier` column, and deliberately so: the moment the
 * tier exists in two places, one of them can be right while the other is wrong,
 * and the wrong one silently widens what an AI client can read. The scope list
 * is already the thing that travels — request → authorization row → grant →
 * token response → session — so it is the thing that carries the tier.
 *
 * Its absence is therefore the safe answer, and that is not an accident of
 * encoding but the point of it:
 *
 *  - A grant issued before this feature existed has no `context:private`, so it
 *    resolves to `team`. An owner's already-connected client stops seeing their
 *    private notes until they reconnect and say so. That is a narrowing, which
 *    is always allowed; the alternative — reading "unmarked" as "private" —
 *    would mean every legacy grant keeps the widest tier forever, and would
 *    make the one control this exists to add unenforceable on exactly the
 *    grants that predate it.
 *  - An approval that does not name a tier gets `team`, not the approver's
 *    ceiling.
 *
 * ## Narrowing is always allowed; widening never is
 *
 * `clampScopes` is subtractive and nothing else. It removes what a role may not
 * hold and returns the rest untouched — it never adds a scope, never rewrites
 * one, and never reinterprets a spelling it does not own. A caller that hands
 * it a vocabulary this file has no opinion about gets that vocabulary back,
 * because inventing authority on a caller's behalf is the failure this whole
 * module exists to prevent.
 */

/** Read every note the grant's tier can see. */
export const SCOPE_READ = "context:read";
/** Create, update, move and archive notes. */
export const SCOPE_WRITE = "context:write";
/** Drop a raw capture into `0-inbox` and nothing else. */
export const SCOPE_CAPTURE = "context:capture";
/**
 * Reach notes marked private.
 *
 * Not an operation — it does not let a client *do* anything new. It widens the
 * set of notes every other scope applies to, which is why it is the one scope
 * a person is asked about separately and the one a client's request cannot
 * decide.
 */
export const SCOPE_PRIVATE = "context:private";

/**
 * Everything `/oauth/authorize` will accept and both discovery documents
 * advertise. The gateway holds the same list; they must change together or a
 * client discovers a scope the authorization endpoint then rejects.
 */
export const SUPPORTED_SCOPES: readonly string[] = [
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_CAPTURE,
  SCOPE_PRIVATE,
];

/** How much of a context a grant reaches. There is no third tier, ever. */
export type VisibilityTier = "private" | "team";

/**
 * Every spelling anything in this codebase reads as "reaches private notes".
 *
 * Wider than `SCOPE_PRIVATE` alone on purpose. `/oauth/authorize` only ever
 * lets the canonical name through, so in a real flow the extras are
 * unreachable — but `createGrant` is an internal function whose caller is the
 * gateway, and the console's `describeScopes` renders any of these as "Full
 * access". A grant that makes the console *say* private for somebody who may
 * not have it is a lie on the one screen a person checks, so none of these
 * spellings may survive a non-owner's clamp either.
 */
const PRIVATE_TIER_ALIASES: ReadonlySet<string> = new Set([
  SCOPE_PRIVATE,
  "context.private",
  "private",
  "*",
  "context:*",
  "context.*",
  "all",
]);

/** Every spelling the gateway honours as authority to change a customer's notes. */
const WRITE_ALIASES: ReadonlySet<string> = new Set([SCOPE_WRITE, SCOPE_CAPTURE]);

/** Roles that may change content at all. `member` is read-only, always. */
function roleCanWrite(role: string): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Roles that may hand over notes marked private.
 *
 * Only `owner`. An `editor` can write and a `member` cannot, but neither of
 * them is the person whose private notes these are — they cannot read one
 * themselves, so they certainly cannot delegate reading one.
 */
function roleCanGrantPrivate(role: string): boolean {
  return role === "owner";
}

/**
 * The most this role could ever hand to a client, in canonical spelling.
 *
 * Shown on the consent screen so the options a person sees are the options the
 * backend will actually honour — a checkbox that produces a refusal is worse
 * than no checkbox.
 */
export function grantableScopes(role: string): string[] {
  const scopes = [SCOPE_READ];
  if (roleCanWrite(role)) scopes.push(SCOPE_WRITE, SCOPE_CAPTURE);
  if (roleCanGrantPrivate(role)) scopes.push(SCOPE_PRIVATE);
  return scopes;
}

/** Which tiers this role may grant, widest last. */
export function grantableTiers(role: string): VisibilityTier[] {
  return roleCanGrantPrivate(role) ? ["team", "private"] : ["team"];
}

/**
 * OAuth scope is space-delimited (RFC 6749 §3.3).
 *
 * Splitting on any run of whitespace and dropping empties means a client that
 * sent a tab or a double space does not produce a phantom scope.
 */
export function parseScopeList(scope: string): string[] {
  return scope.split(/\s+/).filter((entry) => entry.length > 0);
}

/** The canonical wire form of a granted set. */
export function formatScopeList(scopes: readonly string[]): string {
  return scopes.join(" ");
}

/**
 * Remove everything this role may not hold. Add nothing.
 *
 * Order and vocabulary are preserved: the result is a subsequence of the input
 * with duplicates dropped. That subsequence property is the whole guarantee —
 * it makes "a grant never exceeds what the approver could do" checkable by
 * inspection rather than by reasoning about a rebuild.
 */
export function clampScopes(requested: readonly string[], role: string): string[] {
  const dropPrivate = !roleCanGrantPrivate(role);
  const dropWrite = !roleCanWrite(role);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const scope of requested) {
    if (seen.has(scope)) continue;
    if (dropPrivate && PRIVATE_TIER_ALIASES.has(scope)) continue;
    if (dropWrite && WRITE_ALIASES.has(scope)) continue;
    seen.add(scope);
    kept.push(scope);
  }
  return kept;
}

/**
 * The tier a scope set records.
 *
 * Reads the grant, never a role. This is the function that makes an owner who
 * chose team-tier keep team-tier on every later request, forever, rather than
 * being re-promoted by whatever their membership happens to say at the time.
 */
export function visibilityTierOf(scopes: readonly string[]): VisibilityTier {
  return scopes.some((scope) => PRIVATE_TIER_ALIASES.has(scope)) ? "private" : "team";
}

/**
 * Whether a granted set lets the client actually do anything.
 *
 * A set of `["context:private"]` names a tier and no operation: it would mint a
 * token that can reach every private note and has no way to read one. That is
 * not a narrower grant, it is an incoherent one, and an approval that produces
 * it is refused rather than stored.
 */
export function hasOperationScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === SCOPE_READ || WRITE_ALIASES.has(scope));
}
