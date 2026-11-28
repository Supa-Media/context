/**
 * The chat's background list with a split job as one job (`packages/shared/src/jobSplit.cjs`): its title and how
 * many parts it has, then each part's own line under it, where each runs and how it is going. A job on its own is
 * its line as before. Facts only: every line but the split's heading is the job's own `line`.
 */
import { groupedJobs } from "../../../shared/src/jobSplit.cjs";

/**
 * @param {Array<object>} running the chat's jobs (`background.js` `runningJobsOf`)
 * @param {(entry: object) => string} line one job's line
 */
export function listedJobs(running, line) {
  return groupedJobs(running)
    .map((group) => ("job" in group ? line(group.job) : [`- "${group.split.title}": ${group.parts.length} parts`, ...group.parts.map((part) => `  ${line(part)}`)].join("\n")))
    .join("\n");
}
