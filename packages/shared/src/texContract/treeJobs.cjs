/**
 * Which folder does each built-in job, as the tree's facts say (`factJobs`):
 * moved verbatim from `apps/mcp/src/tree/facts.js`, which re-exports it. It
 * asks only the store it is handed (`store.treeFacts`), so Tex reads it here.
 */
"use strict";

/**
 * Which folder does each built-in job (`apps/convex/functions/lib/nodes/folderJobs.ts`),
 * as far as this connection can see: `{jobs, roots}` in the shape
 * `folderJobs` gives (`packages/shared/src/folderRoles.cjs`), or `null` when
 * the facts cannot answer. A folder this connection cannot see is `null`.
 *
 * @param {object} store
 * @returns {Promise<{ jobs: Record<string, string | null>, roots: string[] } | null>}
 */
async function factJobs(store) {
  if (typeof store?.treeFacts !== "function") return null;
  let answer;
  try {
    answer = await store.treeFacts({ ask: "jobs" });
  } catch {
    return null;
  }
  if (answer?.served !== true || !answer.jobs || typeof answer.jobs !== "object" || !Array.isArray(answer.roots)) return null;
  const jobs = {};
  for (const [job, path] of Object.entries(answer.jobs)) jobs[job] = typeof path === "string" && path !== "" ? path : null;
  return { jobs, roots: answer.roots.filter((name) => typeof name === "string") };
}

module.exports = { factJobs };
