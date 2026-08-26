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

/**
 * Sweep answered and abandoned invitations.
 *
 * `workspaceInvitations` gains a row for every person anybody ever tried to
 * invite. They are inert once expired — every reader and every writer checks
 * `expiresAt`, and the sweep only touches rows that have been dead for an hour
 * — but they are permanent without this, and an invitation that was declined,
 * withdrawn or ignored is precisely a row nobody reads.
 *
 * Daily rather than hourly: invitations expire in a week, not in ten minutes,
 * so there is no backlog worth chasing more often.
 */
crons.interval(
  "sweep expired invitations",
  { hours: 24 },
  internal.functions.invitations.purgeExpiredInvitations,
  {},
);

/**
 * Sweep spent and abandoned ingestion tickets.
 *
 * `ingestionTickets` gains a row for every inbound message that resolved to a
 * real personal context. The arrival rate is set by whoever is sending mail
 * rather than by our own customers, which is what makes this sweep different in
 * kind from the two above: "it will not grow much" is not something anybody
 * gets to assert about a table a stranger can add rows to.
 *
 * Hourly, matching the authorization sweep, and for the same reason — the rows
 * expire in five minutes, so a daily cadence would leave a day of dead ones
 * lying around for no benefit.
 */
crons.interval(
  "sweep expired ingestion tickets",
  { hours: 1 },
  internal.functions.ingestionGateway.purgeExpiredIngestionTickets,
  {},
);

export default crons;
