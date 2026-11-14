/**
 * The shape of `admin.censusReport`: its `returns` validator and its type.
 *
 * Split out of `functions/admin.ts` (985 lines, past the point where a
 * validator that size is worth reading in place), so the handler's file keeps
 * its one job. The handler itself is `lib/adminFns/census.ts`; the figures
 * behind each field are explained there and in `lib/census.ts`.
 *
 * Metadata only, like the census it describes: counts, dates, an address and
 * a phone for the roster, and @slugs for the mail rows that accept anyone.
 */

import { v } from "convex/values";
import { populationValidator } from "./census";
import { censusWaitlistValidator } from "./censusWaitlist";

export const censusReportValidator = v.object({
  days: v.number(),
  window: v.array(v.string()),
  truncated: v.boolean(),
  accounts: v.object(populationValidator),
  contexts: v.object({
    ...populationValidator,
    personal: v.number(),
    shared: v.number(),
    perAccount: v.union(v.number(), v.null()),
    membersPerShared: v.union(v.number(), v.null()),
  }),
  storage: v.object({
    managed: v.number(),
    customer: v.number(),
    unbound: v.number(),
    byProvider: v.array(
      v.object({
        provider: v.string(),
        managed: v.number(),
        customer: v.number(),
      }),
    ),
    byStatus: v.array(v.object({ status: v.string(), count: v.number() })),
  }),
  plans: v.object({
    paying: v.number(),
    pastDue: v.number(),
    canceled: v.number(),
    unresolved: v.number(),
    free: v.number(),
    mrrCents: v.number(),
    servingManagedStorage: v.number(),
    servingFastSearch: v.number(),
    provisioningRunning: v.number(),
    provisioningFailed: v.number(),
  }),
  clients: v.array(
    v.object({
      clientId: v.string(),
      clientName: v.string(),
      active: v.number(),
      revoked: v.number(),
      contexts: v.number(),
      accounts: v.number(),
      lastUsedAt: v.union(v.number(), v.null()),
    }),
  ),
  sources: v.object({
    googleAccounts: v.number(),
    gmail: v.number(),
    calendar: v.number(),
    chat: v.number(),
    mailOpen: v.number(),
    mailAllowlisted: v.number(),
    obsidian: v.number(),
    /** @slugs of the workspaces whose mail list accepts anyone, sorted, at most 20. */
    mailOpenSlugs: v.array(v.string()),
  }),
  funnel: v.array(v.object({ step: v.string(), count: v.number() })),
  /** Everyone, against four thresholds counted independently (`lib/adminFns/censusGrowth.ts`). */
  growthFunnel: v.array(v.object({ step: v.string(), count: v.number() })),
  /** Who may text Tex: `canText` has a texting link; `phoneButOff` has a sign-in phone and none. */
  texAccess: v.object({ canText: v.number(), phoneButOff: v.number() }),
  roster: v.array(
    v.object({
      joinedAt: v.number(),
      email: v.optional(v.string()),
      contexts: v.number(),
      owned: v.number(),
      connectedStorage: v.number(),
      clients: v.number(),
      plan: v.string(),
      lastSeenAt: v.union(v.number(), v.null()),
      /** Jev cost in the census window, over owned workspaces (`lib/jev/spend.ts`). */
      aiSpendMicroUsd: v.number(),
      /** The read hit its budget, so `aiSpendMicroUsd` is a floor. */
      aiSpendPartial: v.boolean(),
      /** When staff let this address in from the waitlist (`lib/adminFns/censusWaitlist.ts`). */
      letInAt: v.union(v.number(), v.null()),
      /** Texting-linked phone, else the confirmed sign-in phone. */
      phone: v.union(v.string(), v.null()),
    }),
  ),
  waitlist: censusWaitlistValidator,
});

export type CensusReport = typeof censusReportValidator.type;
