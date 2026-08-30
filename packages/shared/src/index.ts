/**
 * Shared utilities and types for Context.
 *
 * Imported by both the mobile app and the Convex functions. What belongs here
 * is anything **two packages must agree about** — a rule with a copy on each
 * side of a package boundary is a rule that will drift, and a reusable
 * pipeline's path filters cannot see a cross-package import, so the tests that
 * would catch the drift are skipped on exactly the changes that cause it.
 * `packages/shared/**` is in both the `mobile` and `convex` change filters, so
 * a change here runs both suites.
 */

export const APP_NAME = "Context";
export const APP_SLUG = "context";

export { normalizeEmail } from "./email";
