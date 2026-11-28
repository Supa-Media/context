import assert from "node:assert/strict";

import { RESTART_JOB_TOOL, backgroundSession, runningJobsOf, startedJobs, withBackground } from "../../../../../packages/tex/gateway/agent/background.js";
import { frontDoorChecks } from "../../../../../packages/tex/gateway/agent/untriedWeb.js";
import partEndLib from "../../../../../packages/shared/src/jobPartEnd.cjs";

const NOW = Date.UTC(2026, 10, 6, 0, 58);
const SPLIT = { id: "projects/mail-split-test/overview.md", title: "Split project v2" };
const part = (id, title, state, extra = {}) => ({ id, title, state, startedAt: NOW - 50 * 60_000, finishedAt: NOW - 40 * 60_000, steps: [], status: "", split: SPLIT, ...extra });

export default {
  id: "split-is-one-job",
  incident:
    "2026-11-06: Dev2 said \"I fixed an issue … try again\" about a split across the MacBook, dev2 and the cloud. Only the MacBook's part was picked back up, and it waited twelve minutes on partners that never ran. Then Tex texted \"Sent ✓. The split job now includes the Tex cloud workers as a third part\" when the turn had only passed a text to the MacBook's job.",
  cause:
    "A split was separate jobs: \"try again\" picked back up only the part that had ended, a part waiting on its partners' mail ended or spent its parts, and nothing checked a start claim against what the turn started.",
  path: "1:1 text",
  async run() {
    // "Try again" on the part that stopped picks back up every unfinished part of the split.
    const running = runningJobsOf([part("job-macbook-0001", "MacBook part", "stuck", { on: "mch_macbook" }), part("job-dev2-0001", "dev2 part", "failed", { on: "mch_dev2" }), part("job-cloud-0001", "Cloud reviewer", "waiting")]);
    const background = backgroundSession({ running, job: null, now: NOW });
    await withBackground(background, async () => ({ content: [] }))(RESTART_JOB_TOOL, { titles: ["MacBook part"] });
    assert.deepEqual(startedJobs(background, false).steers.map((steer) => steer.id), ["job-macbook-0001", "job-dev2-0001", "job-cloud-0001"]);
    assert.match(background.runningNow, /- "Split project v2": 3 parts/);

    // A part that ends waiting on its partners sleeps instead of ending, inside the job's time.
    const choice = partEndLib.decidePartEnd({ cause: "waiting", split: true, part: 2, startedAt: NOW - 10 * 60_000, now: NOW, machine: true });
    assert.equal(choice.to, "sleep");

    // "Now includes the cloud workers as a third part" after only a steer goes back, with what the turn did as data.
    const checks = frontDoorChecks({ claims: null, runner: false, texted: true, group: null, question: "restart with cloud workers added?" });
    await checks.wrap(async () => ({ content: [] }))("steer_background_job", { title: "MacBook part", note: "add the cloud workers" });
    const notice = checks.check("Done. The split job now includes the Tex cloud workers as a third part.");
    assert.equal(JSON.parse(notice).check, "start_claim");
  },
};
