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
  // The front door, the prompt and the turn (Dev2, 2026-11-13): the steps every text takes to an answer, the prompt
  // they assemble, and the core set and simple asks that measure them (`coreArea.mjs`).
  core: [
    /^apps\/mcp\/src\/agent\/texEntryPoint(\.js$|\/)/,
    /^apps\/mcp\/src\/agent\/(frontDoor|turn|turnPrompt|turnStages|threadedTurn|loggedTurn|prompt|promptModules|promptFence|promptNames|production|modelPlan|router|advisor|sixTools|customInstructions)\.js$/,
    /^apps\/mcp\/bench\/ai\/tests\/(core|simple-asks)\.md$/,
  ],
  // A background job end to end (`jobTasks.mjs`): how a job is started, asked, carried on and reported, the pages it
  // writes, the Worker's job runner, and the tasks and the scripted sites they run on. Its own budget (`AREA_LIMITS.jobs`).
  jobs: [
    /^apps\/mcp\/src\/agent\/(background|jobs|jobStart|jobNote|jobReport|jobPages|jobSlots|chatJobs|lastRound|openAsk|stopsShort|workPage|progress)\.js$/,
    /^apps\/mcp\/src\/(pages|pageSkill)\.js$/,
    /^apps\/agent\/src\/job[A-Za-z]*\.ts$/,
    /^apps\/mcp\/bench\/job-tasks\//,
    /^apps\/mcp\/bench\/ai\/sites\/(caterers|halls|lunch|orders|retreat|eats)\.example\.md$/,
  ],
};

/** The model areas a change's files reach, in a fixed order. */
export function areasFor(files) {
  return Object.keys(AREAS).filter((area) => files.some((file) => AREAS[area].some((pattern) => pattern.test(file))));
}
