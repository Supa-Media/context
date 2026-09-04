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
