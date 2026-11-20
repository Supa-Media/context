/**
 * THE JOB CHECK NODE "jobcheck": the advisor's verdict on one background job's part. Its code is the Job advisor's
 * check role (`../jobAdvisor/check.js`), shared with node "jobadv", which a Lab draft runs in its place (Dev2,
 * 2026-11-16: a draft's new steps are built in main's code first, unused by live Tex's config).
 */
export { jobcheck, checkOf } from "../jobAdvisor/check.js";
