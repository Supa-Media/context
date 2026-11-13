/**
 * Which of Tex's files reach which model area of the replay gate (`replayGate.mjs`). No imports, so the pull
 * request's required check (`scripts/tex-replay-required.mjs`) reads it with no install.
 */
/**
 * Which files reach which model area: Tex's own code and the area's cases. The scorers (`respond.mjs`, `review.mjs`)
 * are not Tex and are proven by their own tests. A file in none reaches only the free plumbing replays.
 */
/**
 * The advisor's shared core (`advisorRoles/core.js`: how every role's ask is sent and its thinking read) reaches every
 * advisor role; each role's own instructions, its brief builder and its cases reach that role alone (Dev2, 2026-11-13:
 * split the advisor by role "so that they can be evaluated separately"; docs/decisions/testing/advisor-roles.md).
 */
const ADVISOR_CORE = /^apps\/mcp\/src\/agent\/advisorRoles\/core\.js$/;
/** What the advisor is told of a job note's mail: both roles that read a job. */
const ADVISOR_KNOWS_MAIL = /^apps\/mcp\/src\/agent\/advisorRoles\/knowsMail\.js$/;

export const AREAS = {
  respond: [/^packages\/shared\/src\/textDecide/, /^apps\/agent\/src\/.*decide/i, /^apps\/mcp\/bench\/respond\//],
  review: [/^apps\/mcp\/src\/agent\/(replyJudge|sendBack|recheck|replyChecks)/, /^apps\/mcp\/bench\/review\//],
  "advisor-chat": [ADVISOR_CORE, /^apps\/mcp\/src\/agent\/advisorRoles\/chat\.js$/, /^apps\/mcp\/src\/agent\/advisor\.js$/, /^apps\/mcp\/bench\/advisor\/chat\.json$/],
  "advisor-job-check": [ADVISOR_CORE, ADVISOR_KNOWS_MAIL, /^apps\/mcp\/src\/agent\/advisorRoles\/jobCheck\.js$/, /^apps\/mcp\/src\/agent\/jobCheck\.js$/, /^apps\/mcp\/bench\/advisor\/job-check\.json$/],
  "advisor-planner": [ADVISOR_CORE, /^apps\/mcp\/src\/agent\/advisorRoles\/planner\.js$/, /^apps\/mcp\/src\/agent\/planBigAsk\.js$/, /^apps\/mcp\/bench\/advisor\/planner\.json$/],
  "advisor-job-mail": [ADVISOR_CORE, ADVISOR_KNOWS_MAIL, /^apps\/mcp\/src\/agent\/advisorRoles\/jobMail\.js$/, /^apps\/mcp\/bench\/advisor\/job-mail\.json$/],
};

/** The model areas a change's files reach, in a fixed order. */
export function areasFor(files) {
  return Object.keys(AREAS).filter((area) => files.some((file) => AREAS[area].some((pattern) => pattern.test(file))));
}
