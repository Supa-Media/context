/**
 * Shared utilities and types for Context.
 *
 * Imported by both the mobile app and the Convex functions. What belongs here
 * is anything **two packages must agree about** — a rule with a copy on each
 * side of a package boundary is a rule that will drift, and its two copies are
 * then tested separately or not at all.
 *
 * A reusable pipeline's path filters cannot see a cross-package import, so a
 * test that reaches across a boundary is generally skipped on exactly the
 * changes it exists to catch. That is true of `consentScopes.test.ts` and is
 * *not* the reason this particular pair moved: `gateway-contracts.yml` carries
 * no `paths` filter and runs the whole control-plane suite on every pull
 * request into `main`, so both halves were already reached. What was wrong was
 * having two copies at all. `packages/shared/**` being in both the `mobile` and
 * `convex` change filters is what makes this a safe place to put the one copy —
 * see `email.ts` for when that was read and where.
 */

export const APP_NAME = "Context";
export const APP_SLUG = "context";

export { normalizeEmail } from "./email";

/**
 * A share link's URL, built in the two places that build one: the console's
 * Copy link, and the control plane answering an agent that asked for a link.
 * See `shareLink.ts` for why it is not two builders.
 */
export {
  MAX_SHARE_SLUG,
  SHARE_ROUTE,
  shareSegment,
  shareSlug,
} from "./shareLink";

/**
 * The one shared workspace every account reaches without an invitation.
 *
 * Here rather than in either app because both sides have to agree about it and
 * neither owns it: the control plane decides who reaches it, and the console
 * decides how it is drawn and — the part a second copy would get wrong — that
 * it does not count as "this person has a context of their own".
 */
export {
  PINNED_CONTEXT_ROLE,
  PINNED_CONTEXT_SLUG,
  isPinnedContextSlug,
} from "./pinnedContext";
export {
  DESTRUCTIVE_ACTION_ACKNOWLEDGEMENT,
  matchesDestructiveActionAcknowledgement,
} from "./acknowledgement";

/**
 * Where Stripe sends somebody back to, built once for both sides.
 *
 * The control plane mints the URL and the app owns the routes, and while the
 * two lived apart the control plane sent a completed payment to a path that is
 * not a route at all. See `checkoutReturn.ts`.
 */
export {
  CHECKOUT_PARAM,
  checkoutOutcomeFrom,
  checkoutReturnPath,
  contextSegment as checkoutContextSegment,
  portalReturnPath,
  premiumSettingsPath,
  type CheckoutOrigin,
  type CheckoutOutcome,
} from "./checkoutReturn";

/**
 * The link engine: what a link between two notes is, and how it is rewritten so
 * a rename or a move does not break it. Used by the control plane's file
 * operations and by the console's editor.
 *
 * Its twin lives in the gateway, which cannot import this package — see the
 * module's own header for why, and for the parity test that keeps the two
 * honest.
 */
export {
  codeRanges,
  dirOf,
  expressLink,
  indexByName,
  normalizeSegments,
  parseLinks,
  relativePath,
  resolveLink,
  rewriteLinks,
  styleOf,
} from "./links";
export type { Link, LinkStyle, RewriteOptions } from "./links";

/**
 * What a workspace shows in its mark: a photo from its own bucket, a single
 * emoji, or nothing, which is the letter it has always drawn.
 *
 * Here because the two sides own different halves of one rule. The control
 * plane decides what may be stored — one emoji and no more, an image type a
 * browser will actually draw — and the console decides what may be offered and
 * has to pre-flight the same limits before it uploads. Two copies of "is this
 * one emoji" is the shape that drifts, and the drift is silent: a picker that
 * offers what the server refuses.
 */
export {
  WORKSPACE_ICON_CONTENT_TYPES,
  WORKSPACE_ICON_EMOJI,
  WORKSPACE_ICON_EXTENSIONS,
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_MAX_EMOJI_LENGTH,
  isSingleEmoji,
  type WorkspaceIcon,
} from "./workspaceIcon";

/**
 * The path-only contract for bucket-backed website routes. Page metadata and
 * source-reference parsing remain separate so an open product decision cannot
 * silently change route ownership.
 */
export {
  DEFAULT_WEBSITE_ROOT,
  WEBSITE_PLATFORM_ROOT_ASSET_PATTERN,
  WEBSITE_RESERVED_FIRST_SEGMENTS,
  compileWebsiteRoutes,
  websiteRouteLookupKey,
  type WebsiteRoute,
  type WebsiteRouteCompilation,
  type WebsiteRouteDiagnostic,
  type WebsiteRouteDiagnosticCode,
  type WebsiteRouteOptions,
} from "./websiteRoutes";
export {
  WEBSITE_CONTRACT_VERSION,
  WEBSITE_STARTER_MARKDOWN,
  summarizeWebsiteRoutes,
} from "./websiteContract";
export type {
  ResolvedWebsitePage,
  WebsiteEnableResult,
  WebsiteNavigationItem,
  WebsiteRouteAudience,
  WebsiteRouteProblem,
  WebsiteRouteProblemCode,
  WebsiteRoutePublicationStatus,
  WebsiteRouteStatus,
  WebsiteRouteSummary,
  WebsiteStateView,
} from "./websiteContract";
