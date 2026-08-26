/**
 * Scheduled maintenance.
 *
 * Nothing here may hold a decision. A cron is the wrong place for anything a
 * person would want to see refused in the moment, so this file is limited to
 * jobs whose only effect is that the database stops accumulating things nobody
 * reads.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Sweep spent and abandoned authorization requests.
 *
 * `oauthAuthorizations` gains a row for every authorization attempt — every
 * approval, every refusal, and every consent screen someone opened and walked
 * away from. They are inert once expired (each reader checks `expiresAt`, and
 * the sweep only touches rows that have been closed for an hour), but they are
 * permanent without this, and the table is on the hot path of every MCP
 * connection.
 *
 * Hourly, with a bounded batch. A backlog drains over several runs rather than
 * in one transaction big enough to hit a limit — and a job that fails halfway
 * has still deleted whatever it deleted, because each run is independent.
 */
crons.interval(
  "sweep expired authorization requests",
  { hours: 1 },
  internal.functions.authorizations.purgeExpiredAuthorizations,
  {},
);

export default crons;
