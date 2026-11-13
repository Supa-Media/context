/**
 * Which of Tex's files reach which model area of the replay gate (`replayGate.mjs`). No imports, so the pull
 * request's required check (`scripts/tex-replay-required.mjs`) reads it with no install.
 */
/**
 * Which files reach which model area: Tex's own code and the area's cases. The scorers (`respond.mjs`, `review.mjs`)
 * are not Tex and are proven by their own tests. A file in none reaches only the free plumbing replays.
 */
export const AREAS = {
  respond: [/^packages\/shared\/src\/textDecide/, /^apps\/agent\/src\/.*decide/i, /^apps\/mcp\/bench\/respond\//],
  review: [/^apps\/mcp\/src\/agent\/(replyJudge|sendBack|recheck|replyChecks)/, /^apps\/mcp\/bench\/review\//],
};

/** The model areas a change's files reach, in a fixed order. */
export function areasFor(files) {
  return Object.keys(AREAS).filter((area) => files.some((file) => AREAS[area].some((pattern) => pattern.test(file))));
}
