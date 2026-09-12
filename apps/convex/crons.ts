/**
 * Scheduled maintenance, and — since 2026-09-10 — one scheduled engine.
 *
 * Nothing here may hold a decision. A cron is the wrong place for anything a
 * person would want to see refused in the moment, and that rule is unchanged.
 *
 * What has changed is the second half of the original sentence. This file was
 * written for jobs whose only effect is that the database stops accumulating
 * things nobody reads, and it later gained a job that *restarts* work over a
 * disposable derivative (`restart stalled search backfills`) — still a repair,
 * still nothing a customer's bucket would notice. `sync due Google accounts`
 * is a third kind and it should be named rather than filed quietly beside the
 * sweeps: it calls a third party on a customer's quota and writes canonical
 * Markdown into their bucket, on a clock, with nobody present.
 *
 * That is admitted here rather than argued away, because the honest limit on
 * this file is not "only deletions" — it is that **every job here must hold no
 * decision, and a job that acts outside this database must additionally
 * re-ask, at the moment it acts, everything that could have changed since it
 * was scheduled**. The sync job's own comment below makes that case in full,
 * and `googleForwardSyncJob` is where the re-asking lives. A fourth job of
 * this kind owes the same two paragraphs.
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
/**
 * The rate limiter's own table, which nothing swept.
 *
 * Every other sweep here is housekeeping on rows a *customer* created. This
 * one is on rows created by whoever is being limited, and on the two routes a
 * stranger can drive — email ingestion resolve and client registration — that
 * means the keyspace belongs to them. See the table's docblock in `schema.ts`;
 * a closed window carries no information, so this deletes garbage rather than
 * state.
 *
 * Hourly, matching the authorization sweep it is copied from, because the
 * batch is the same 200 rows and a daily run is a drain ceiling of 200/day.
 * A source producing more distinct networks than that in a day would out-run
 * a daily sweep permanently — which is the exact attacker this exists for, so
 * taking the neighbour's rate costs nothing and removes the question.
 */
crons.interval(
  "sweep closed rate-limit windows",
  { hours: 1 },
  internal.functions.grants.purgeExpiredRateLimits,
  {},
);

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

/**
 * Retire abandoned bucket-provisioning attempts.
 *
 * The only sweep here that is not housekeeping. A `cloudflareProvisioning` row
 * carries the customer's **account-level** Cloudflare credential, sealed, for
 * the length of one attempt — and the two paths that destroy it both require
 * the scheduled provisioning action to reach them. When it does not (a deploy
 * that loses the job, an eviction, a failure while recording a failure) the row
 * sits `pending` forever, holding a credential that CLAUDE.md says has no
 * steady state, and blocking every further attempt by the same owner.
 *
 * Hourly, because the attempt's own deadline is fifteen minutes and a
 * credential nobody is using should not wait a day to stop existing.
 */
crons.interval(
  "sweep abandoned bucket provisioning",
  { hours: 1 },
  internal.functions.cloudflare.purgeExpiredProvisioning,
  {},
);

/**
 * Restart a search backfill that has stopped moving.
 *
 * **The only job here that starts work rather than deleting it**, and the
 * exception is worth stating rather than smuggling. The rule this file opens
 * with is that a cron may hold no decision, and this one holds none: whether a
 * context may have a projection at all is `searchProjectionState`, re-asked by
 * the pass itself before it opens a credential, and whether there is anything
 * to copy is answered by the pass. What the sweep decides is only *when to
 * look*, and the answer is "when nothing else has for a while".
 *
 * It exists because every other trigger needs somebody present. The gateway
 * projects behind a search, and `provisionIndex` schedules a chain when the
 * switch is thrown — so a context that reached `backfilling` before either of
 * those existed, or whose chain was lost to a deploy, waits forever for a
 * search that may never come. Three production contexts were in exactly that
 * state, sitting at "0 notes indexed", and there is no way to reach them
 * through the switch: `enable` returns early for a row that is already opted
 * in and not failed.
 *
 * Hourly, and each run only touches rows nothing has written to in fifteen
 * minutes, so a chain that is working is never overtaken by a second one.
 */
crons.interval(
  "restart stalled search backfills",
  { hours: 1 },
  internal.functions.fastSearch.sweepStalledBackfills,
  {},
);

/**
 * Poll every connected Google account that is due.
 *
 * **The second job here that starts work rather than deleting it**, and it owes
 * the same argument the search sweep above makes. It holds no decision:
 * whether a connection may sync at all — is it still connected, is its context
 * personal, does it enable a product this engine can advance, does this
 * deployment allow reading a restricted scope — is the connection's own state,
 * re-asked by `googleForwardSyncJob` inside the pass, before a credential is
 * opened. What this decides is only *when to look*.
 *
 * One thing is genuinely this job's alone and is not re-asked inside the pass:
 * **due-ness**. The sweep decides a connection is due and the pass then syncs
 * without asking whether it should have waited. That is deliberate — the pass
 * runs minutes later and re-deciding due-ness against a clock that has moved
 * would make a claimed pass refuse itself — but it is worth stating plainly
 * rather than letting "every gate is re-asked" imply more than is true.
 *
 * It exists because nothing else ever looked. Connecting a mailbox recorded a
 * grant and a `historyId` and then nothing advanced it: no cron, no webhook —
 * Google's push path is deliberately not built (`docs/decisions/communications.md`)
 * — and the gateway's `scheduled()` handler has no trigger configured. A
 * person connected Gmail and their mail never arrived.
 *
 * **Five minutes because that is the floor**, not because every account is
 * polled that often. `syncIntervalMinutes` is per connection and defaults to
 * fifteen; the sweep starts a pass only where `now >= lastSyncAt + interval`,
 * which is how one fixed tick serves many different frequencies. Below five
 * the tick would be finer than the shortest interval anybody may choose, and
 * every extra tick is a transaction that reads an index to find nothing.
 *
 * And, as above: each run only touches connections nothing has written to in
 * fifteen minutes, so a pass that is still running is never overtaken by a
 * second one.
 */
crons.interval(
  "sync due Google accounts",
  { minutes: 5 },
  internal.functions.googleSync.sweepDueGoogleSyncs,
  {},
);

export default crons;
