/**
 * The staff console: platform figures, and the platform's own credentials.
 *
 * Every function here begins with `requireAdmin` (`lib/admin.ts`), which
 * authorizes against an environment allowlist rather than a database flag —
 * the reasoning is in that module and it is the load-bearing decision in this
 * file. **The authorization call stays inline in each handler below, rather
 * than moving into `lib/adminFns/` with the rest of the logic** —
 * `__tests__/adminSurface.test.ts` walks this file's own source and fails on
 * any exported function whose handler does not reach `requireAdmin`,
 * `requireAdminActor` or `viewerIsAdmin` in its own body.
 *
 * ## The one rule that shapes everything below
 *
 * **No public function may reach `decryptSecret`.** That is
 * `__tests__/structure.test.ts`, enforced over the whole call graph rather
 * than over names, and it is why this file has the shape it does:
 *
 *  - `setSecret` is an `action` (it encrypts, which needs a random IV, which a
 *    deterministic mutation may not produce) that hands the finished envelope
 *    to an internal mutation. It never reads one back.
 *  - `listSecrets` returns names, fingerprints, descriptions and authorship.
 *    There is no `getSecret`, and adding one would fail the suite rather than
 *    merely be a bad idea.
 *  - `readIntegrationSecret` — the one function that opens an envelope — is an
 *    `internalAction`, reachable by the provisioner and the payment and mail
 *    integrations, and by nothing a client can call. Its body, including the
 *    `decryptSecret` call, stays in this file for the same reason the
 *    authorization calls do: `__tests__/structure.test.ts` enumerates exactly
 *    which modules may import `decryptSecret` at all, and this file is one of
 *    them.
 *
 * An admin is staff, not an exception to the credential boundary. The console
 * exists so somebody can *set* a token without a deploy, not so anybody can
 * read one out of the product.
 *
 * ## What this file may never grow
 *
 * A function that returns per-note, per-path or per-query figures. The usage
 * tables hold counters by day and nothing else (see `lib/usage.ts`), and the
 * reason is the first non-negotiable: an admin screen is not a licence to
 * hold a record of what customers wrote or searched for.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { decryptSecret, requireKeyset } from "./lib/crypto";
import { normalizeSecretName } from "./lib/appSecrets";
import { requireAdmin, viewerIsAdmin as viewerIsAdminHelper, type AdminActor } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { COUNT_CEILING, usageReportHandler, type CountedTotal, type MetricSeries, countedTotalValidator } from "./lib/adminFns/usage";
import { ROSTER_LIMIT, censusReportHandler, populationValidator } from "./lib/adminFns/census";
import { jevUsageReportHandler, setJevSwitchHandler } from "./lib/jev/admin";
import {
  applySecretHandler,
  deleteSecretHandler,
  listSecretsHandler,
  normalizeSecretInput,
  setSecretHandler,
  type AdminSecretRow,
} from "./lib/adminFns/secrets";

export { COUNT_CEILING, ROSTER_LIMIT };
export type { AdminSecretRow, CountedTotal, MetricSeries };

/**
 * Whether to render a link to `/admin`, and nothing more.
 *
 * Every admin read and write authorizes itself server-side. A client that
 * forces this to `true` gets a screen whose every query throws.
 */
export const amIAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await viewerIsAdminHelper(ctx),
});

// -- the figures ----------------------------------------------------------

/**
 * Daily counters across the requested window.
 *
 * Zero-filled: a day with no rows reads `0` rather than being absent, because
 * a trend line with holes in it is read as missing data and a zero is a fact.
 *
 * The window is clamped (`clampReportDays`) so an argument cannot ask for a
 * full-table scan.
 */
export const usageReport = query({
  args: { days: v.optional(v.number()) },
  returns: v.object({
    days: v.number(),
    window: v.array(v.string()),
    series: v.array(
      v.object({
        metric: v.string(),
        points: v.array(v.object({ day: v.string(), count: v.number() })),
        total: v.number(),
      }),
    ),
    activeContexts: v.object({
      points: v.array(v.object({ day: v.string(), count: v.number() })),
      distinctInWindow: v.number(),
    }),
    totals: v.object({
      workspaces: countedTotalValidator,
      users: countedTotalValidator,
    }),
  }),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    return await usageReportHandler(ctx, args);
  },
});

// -- Jev smarts -----------------------------------------------------------

const jevDayValidator = v.object({
  day: v.string(),
  calls: v.number(),
  failed: v.number(),
  refused: v.number(),
  tokens: v.number(),
  costUsd: v.number(),
});

/**
 * Jev usage and estimated cost per feature, with each kill switch's state.
 * Counts only: no question, answer, path or workspace name. See
 * `lib/jev/README.md`.
 */
export const jevUsageReport = query({
  args: { days: v.optional(v.number()) },
  returns: v.object({
    usdPerMtok: v.number(),
    allOff: v.boolean(),
    features: v.array(
      v.object({
        feature: v.string(),
        label: v.string(),
        on: v.boolean(),
        disabledByEnv: v.boolean(),
        dailyCallsPerWorkspace: v.number(),
        workspaces: v.number(),
        calls: v.number(),
        failed: v.number(),
        refused: v.number(),
        questions: v.number(),
        tokens: v.number(),
        costUsd: v.number(),
        days: v.array(jevDayValidator),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    return await jevUsageReportHandler(ctx, args);
  },
});

/**
 * The kill switch: one feature, or `"*"` for every Jev feature at once.
 * `off: null` removes the switch, returning the feature to its registry
 * default. Takes effect on the next request; a run in progress finishes the
 * request it is on and is refused the rest only when it next opens a session.
 */
export const setJevSwitch = mutation({
  args: { feature: v.string(), off: v.union(v.boolean(), v.null()), reason: v.optional(v.string()) },
  returns: v.object({ feature: v.string(), off: v.union(v.boolean(), v.null()) }),
  handler: async (ctx, args) => {
    let actor;
    try {
      actor = await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    const result = await setJevSwitchHandler(ctx, args);
    console.log(JSON.stringify({ event: "jev_switch", feature: result.feature, off: result.off, by: actor.userId }));
    return result;
  },
});

// -- the census -----------------------------------------------------------

/**
 * The platform census: who is here, what they built, and what we run for them.
 *
 * See `lib/adminFns/census.ts`'s `censusReportHandler` for why this is not
 * part of `usageReport`, why every figure here is a floor when the page
 * filled, and the standing rule that this stays metadata only.
 */
export const censusReport = query({
  args: { days: v.optional(v.number()) },
  returns: v.object({
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
      dropbox: v.number(),
      mailOpen: v.number(),
      mailAllowlisted: v.number(),
      obsidian: v.number(),
    }),
    funnel: v.array(v.object({ step: v.string(), count: v.number() })),
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
      }),
    ),
  }),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    return await censusReportHandler(ctx, args);
  },
});

// -- the secrets ----------------------------------------------------------

/**
 * Every stored integration credential, as metadata.
 *
 * `encryptedValue` is not selected, not decrypted, and not returned. The
 * envelope never leaves the database through this function — not even in its
 * sealed form, because a sealed envelope plus a leaked key is the credential,
 * and a ciphertext on a client is a ciphertext an attacker can keep.
 */
export const listSecrets = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      fingerprint: v.string(),
      description: v.optional(v.string()),
      updatedAt: v.number(),
      createdAt: v.number(),
      updatedByEmail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx): Promise<AdminSecretRow[]> => {
    try {
      await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    return await listSecretsHandler(ctx);
  },
});

/**
 * Store or replace one integration credential.
 *
 * An action rather than a mutation because `encryptSecret` draws a random IV,
 * which a Convex mutation may not do — the same split `bindStorage` uses for a
 * customer's storage key, and for the same reason.
 *
 * Replacing is deliberately the same call as creating. A separate "rotate"
 * path would be a second place for the envelope to be written, and the
 * difference an operator cares about — did this change, and to what — is the
 * fingerprint, which both paths recompute.
 */
export const setSecret = action({
  args: {
    name: v.string(),
    value: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.object({ name: v.string(), fingerprint: v.string() }),
  handler: async (ctx, args): Promise<{ name: string; fingerprint: string }> => {
    let actor: AdminActor;
    let name: string;
    let value: string;
    let description: string | undefined;
    try {
      // An action has no `ctx.db`, so the authorization is a query call. It is
      // still server-side and still the same predicate — `runQuery` of an
      // internal query that re-derives the identity from the request, never a
      // boolean the client passed in.
      actor = await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
      ({ name, value, description } = normalizeSecretInput(args));
    } catch (error) {
      throw toConvexError(error);
    }

    return await setSecretHandler(ctx, actor, name, value, description);
  },
});

export const deleteSecret = mutation({
  args: { name: v.string() },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args) => {
    let actor: AdminActor;
    let name: string;
    try {
      actor = await requireAdmin(ctx);
      name = normalizeSecretName(args.name);
    } catch (error) {
      throw toConvexError(error);
    }

    return await deleteSecretHandler(ctx, actor, name);
  },
});

// -- internals ------------------------------------------------------------

/**
 * The authorization an action cannot perform for itself.
 *
 * Internal, and it returns the actor rather than a boolean so the calling
 * action cannot proceed having merely *asked* whether the caller is staff.
 */
export const requireAdminActor = internalQuery({
  args: {},
  handler: async (ctx): Promise<AdminActor> => {
    try {
      return await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
  },
});

export const applySecret = internalMutation({
  args: {
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    name: v.string(),
    envelope: v.string(),
    fingerprint: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => applySecretHandler(ctx, args),
});

export const secretEnvelope = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<Doc<"appSecrets"> | null> =>
    await ctx.db
      .query("appSecrets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique(),
});

/**
 * Open one integration credential, for the server code that uses it.
 *
 * **Internal, and it must stay internal.** `__tests__/structure.test.ts` walks
 * the call graph from every public function and fails if one reaches
 * `decryptSecret`; this is the reason that test covers this file. The D1
 * provisioner, the payment integration and the mail integration call it. A
 * screen never does.
 *
 * Returns `null` for an absent name rather than throwing, because "this
 * integration is not configured yet" is an ordinary state a caller should
 * handle with a clear message, not an exception it has to classify.
 */
export const readIntegrationSecret = internalAction({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const name = normalizeSecretName(args.name);
    const row: Doc<"appSecrets"> | null = await ctx.runQuery(
      internal.functions.admin.secretEnvelope,
      { name },
    );
    if (row === null) return null;
    return await decryptSecret(row.encryptedValue, requireKeyset(), {
      platform: "integration",
    });
  },
});
