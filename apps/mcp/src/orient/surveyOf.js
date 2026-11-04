/**
 * One workspace's survey for `orient`, with its folder descriptions and built-in jobs, drawn from a listing and a
 * facts store. The gateway draws it this way where the workspace's object cannot (`workspaces.js` `surveyOf`), and the
 * object draws it the same way over its own rows (`workspaceStore/orientSurvey.js`), so both answer alike.
 */

import { surveyContext } from "./survey.js";
import { describeFolders } from "./folderAbout.js";
import { factJobs } from "../tree/facts.js";

/**
 * `listing` answers the tree's keys, `facts` its note facts; a survey the tree cannot answer comes back `unreadable`,
 * which the block says rather than drawing a map of nothing.
 */
export async function surveyLocally(listing, facts, scope, rules, overrides) {
  // Which folder does each built-in job, whatever it is called now; absent where the tree cannot say. Asked beside the
  // survey and the folder descriptions, which never need it.
  const asking = factJobs(facts).catch(() => null);
  const survey = await surveyContext(listing, scope, rules, overrides);
  const [jobs] = await Promise.all([asking, describeFolders(facts, survey)]);
  if (jobs !== null) survey.jobs = jobs.jobs;
  return survey;
}
