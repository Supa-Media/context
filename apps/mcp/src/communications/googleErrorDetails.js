/**
 * What a failed Google API response says about itself, for Calendar and Chat
 * as well as Gmail.
 *
 * The three share Google's error body: `error.errors[].reason`
 * (`rateLimitExceeded`, `forbidden`, …) and `error.status`
 * (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, …). A 403 is a rate limit or a
 * refusal depending on which, and a caller that read only the status told a
 * person to reconnect over a limit that lifts in seconds. The reader is
 * Gmail's own (`gmail/api.js`), which keeps those two plain words and none of
 * the body's prose.
 */
export { safeGoogleErrorDetails } from "./gmail/api.js";

/** The reasons Google gives a 403 that is a limit, not a refusal. */
export const GOOGLE_RATE_LIMIT_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

/** Does this 403's body say rate limit rather than refusal? */
export function isGoogleRateLimit(details) {
  return GOOGLE_RATE_LIMIT_REASONS.has(details?.reason ?? "") || details?.googleStatus === "RESOURCE_EXHAUSTED";
}
