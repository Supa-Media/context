/**
 * How a customer domain moves between states, as pure functions.
 *
 * The actions ask the world (DNS, Cloudflare); the mutations write rows; the
 * decision between them lives here so it can be tested without either.
 *
 *   pending ──(ownership + routing + https)──▶ active
 *      ▲                                        │
 *      └───────(routing lost / cert failed)─────┘
 *   pending|active ──(workspace stops paying)──▶ suspended ──(pays again)──▶ pending
 *   any ──(owner removes / workspace deleted / unverified claim expires)──▶ removing ──▶ (row deleted)
 *
 * Two rules hold everywhere:
 *
 *  - **Only `active` is served**, and serving re-checks payment at request
 *    time (`resolveHostHandler`), so a lapse stops a domain at once rather
 *    than at the next sweep.
 *  - **Ownership is sticky per claim.** Once this claim's TXT record has been
 *    seen, removing it later does not take the domain down — people tidy DNS
 *    after setup — but a new claim mints a new value, so an old record never
 *    verifies somebody else's.
 */

import type { Doc } from "../../../_generated/dataModel";
import type { ProviderReadiness } from "./provider";

type Row = Doc<"customDomains">;
export type DomainProblem = NonNullable<Row["problem"]>;

/** How long a run of checks continues before it stops and waits for "Check again". */
export const CHECK_DEADLINE_MS = 72 * 60 * 60 * 1000;

/**
 * How long an unverified claim holds its hostname before it is released.
 * Without it, typing somebody else's domain and walking away would block them
 * from connecting it for ever.
 */
export const UNVERIFIED_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a live domain is re-read, to notice DNS moved away or a certificate failed. */
export const ACTIVE_RECHECK_MS = 60 * 60 * 1000;

/** Domains per workspace, for now. */
export const DOMAINS_PER_WORKSPACE = 1;

/**
 * The wait before the next check. Fast at first — most people add the records
 * and watch the screen — then settling to every ten minutes.
 */
export function nextCheckDelay(checkCount: number): number {
  const ladder = [10_000, 20_000, 30_000, 60_000, 120_000, 300_000];
  return ladder[checkCount] ?? 600_000;
}

/** What one check found. `null` in a field means "could not ask". */
export interface CheckFindings {
  ownership: boolean | null;
  readiness: ProviderReadiness | null;
  /** The provider could not be used at all: unconfigured, refused, down. */
  providerProblem?: DomainProblem;
}

export interface CheckOutcome {
  patch: Partial<Row>;
  /** Schedule another check after this many ms, or not at all. */
  checkAgainIn: number | null;
}

/**
 * Fold one check into the row. The caller has already established that the
 * workspace is paying — suspension is decided by the sweep, not here.
 */
export function applyCheck(row: Row, findings: CheckFindings, now: number): CheckOutcome {
  const ownershipVerified = row.ownershipVerified || findings.ownership === true;
  const readiness = findings.readiness;
  const routingVerified = readiness === null ? row.routingVerified : readiness.routing;
  const httpsReady = readiness === null ? row.httpsReady : readiness.https;
  const problem: DomainProblem | undefined =
    findings.providerProblem ?? readiness?.problem ?? undefined;
  const base: Partial<Row> = {
    ownershipVerified,
    routingVerified,
    httpsReady,
    problem,
    checkedAt: now,
    checkCount: row.checkCount + 1,
    updatedAt: now,
  };

  if (row.status === "active") {
    // A live domain stays live through anything short of a real loss: a
    // provider we could not reach, or a certificate mid-renewal, is not a
    // reason to stop serving somebody's site.
    const lost = readiness !== null && (!readiness.routing || readiness.problem !== null);
    if (!lost) return { patch: { ...base, problem: undefined }, checkAgainIn: null };
    return {
      patch: { ...base, status: "pending", checkingSince: now, checkCount: 0 },
      checkAgainIn: nextCheckDelay(0),
    };
  }

  if (ownershipVerified && routingVerified && httpsReady) {
    return {
      patch: { ...base, status: "active", problem: undefined, activatedAt: row.activatedAt ?? now },
      checkAgainIn: null,
    };
  }

  if (now - row.checkingSince >= CHECK_DEADLINE_MS) {
    return { patch: { ...base, problem: problem ?? "TIMED_OUT" }, checkAgainIn: null };
  }
  return { patch: base, checkAgainIn: nextCheckDelay(row.checkCount) };
}

export type SweepAction =
  | { kind: "none" }
  | { kind: "check" }
  | { kind: "suspend" }
  | { kind: "resume" }
  | { kind: "release" }
  | { kind: "deprovision" };

/**
 * What the periodic sweep does with one row. It holds no decision beyond
 * choosing which job to start; each job re-reads the row when it runs.
 */
export function sweepActionFor(row: Row, paying: boolean, now: number): SweepAction {
  if (row.status === "removing") {
    return now - row.updatedAt > 5 * 60 * 1000 ? { kind: "deprovision" } : { kind: "none" };
  }
  if (row.status === "suspended") return paying ? { kind: "resume" } : { kind: "none" };
  if (!paying) return { kind: "suspend" };

  if (row.status === "pending") {
    if (!row.ownershipVerified && now - row.createdAt > UNVERIFIED_CLAIM_TTL_MS) {
      return { kind: "release" };
    }
    // Stopped runs wait for the owner; running ones reschedule themselves, so
    // the sweep only restarts a run whose next check went missing.
    if (row.problem === "TIMED_OUT") return { kind: "none" };
    const last = row.checkedAt ?? row.createdAt;
    return now - last > nextCheckDelay(row.checkCount) + 15 * 60 * 1000
      ? { kind: "check" }
      : { kind: "none" };
  }

  const last = row.checkedAt ?? row.activatedAt ?? row.createdAt;
  return now - last > ACTIVE_RECHECK_MS ? { kind: "check" } : { kind: "none" };
}

/** The stage a pending domain is at, for the three-step progress on screen. */
export type DomainStage = "ownership" | "routing" | "https" | "live";

export function stageOf(row: Pick<Row, "status" | "ownershipVerified" | "routingVerified" | "httpsReady">): DomainStage {
  if (row.status === "active") return "live";
  if (!row.ownershipVerified) return "ownership";
  if (!row.routingVerified) return "routing";
  if (!row.httpsReady) return "https";
  return "live";
}
