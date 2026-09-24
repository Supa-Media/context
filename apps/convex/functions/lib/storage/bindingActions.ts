/**
 * What happens to a binding after it is written: asking its bucket where the
 * storage-layout migration got to, re-probing it on an owner's request or on
 * the hourly capability sweep, and forgetting it.
 *
 * Split out of `functions/storage.ts`, which keeps `observeStorageLayout`,
 * `reverifyStorage`, `sweepUnprobedCapabilities` and `disconnectStorage`
 * registered under the same names, kinds and validators and wires these
 * handlers to them; this module registers none. None of them decrypts, and
 * each reaches the bucket only by *scheduling* a job whose result the
 * scheduler discards — see the comments below for why that distinction is the
 * whole design.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../../../_generated/api";
import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { consumeRateLimit } from "../rateLimit";
import { storageLayoutAnswerIsCurrent } from "../storageLayout";
import { requireWorkspaceRole } from "../workspaceAuth";
import { managedBucketName } from "../managedStorage";
import {
  CAPABILITY_SWEEP_BATCH,
  OBSERVE_LAYOUT_LIMIT,
  OBSERVE_LAYOUT_WINDOW_MS,
  REVERIFY_LIMIT,
  REVERIFY_WINDOW_MS,
} from "./limits";

/**
 * Ask this bucket where the storage-layout migration got to, and run nothing.
 *
 * ## Why a context that was already migrated kept being offered the migration
 *
 * `storageBindings.storageLayoutState` was added so the console could stop
 * offering an update that had already run. It was only ever written by a
 * migration *pass*, so it answered for contexts migrated from then on and for
 * nobody else: every context migrated before it existed kept `complete` in its
 * own bucket and nothing in this row, and an empty column reads as "nobody has
 * run this". The notice came back on every device, for ever, for exactly the
 * people who had already done what it was asking. The owner who reported the
 * original nag was one of them.
 *
 * The bucket has always known. Nothing ever asked it outside of a migration.
 * This asks.
 *
 * ## Why it is safe to call whenever the console wonders
 *
 * It schedules `runFileOperation` with `readStorageLayout`, which is one `get`
 * against a single JSON key under `.context/` — no write, no delete, and none
 * of the conditional-write capability `migrateStorage` demands. A bucket that
 * can never *run* the migration can still say whether it already has.
 *
 * It is also self-limiting by construction: the observation sets
 * `storageLayoutCheckedAt`, and the guard below refuses once that is set. One
 * probe per binding, and one more after a rebind, which is a bucket nobody has
 * looked at either.
 *
 * ## A mutation that schedules rather than an action that probes
 *
 * `reverifyStorage`'s reason exactly: `runFileOperation` opens a credential,
 * and a public function that *called* it would have that in its own call
 * graph. The scheduler discards the job's result, so this can cause the read
 * without ever being able to see what it opened. Watch `getStorageBinding` for
 * the outcome.
 *
 * Owner-only, because it spends the workspace's request budget against the
 * workspace's bucket — the same reason `reverifyStorage` is.
 */
export async function observeStorageLayoutHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) return { queued: false };
  /*
    Nothing to ask, or nothing to ask it with. An unverified or errored
    binding is one the console is already telling its owner about in a louder
    notice, and a probe against it would fail for that reason rather than
    teach anybody anything.
  */
  if (binding.status !== "connected") return { queued: false };
  /*
    Already answered — by an observation, or by a migration pass that
    recorded its own outcome. Either way the question is spent.

    Spent *by the current probe*, which is the one distinction this guard
    has to make. An answer with no state in it is only as good as the
    question that produced it, and the first generation asked one that every
    newly scaffolded bucket answered wrongly. `storageLayoutAnswerIsCurrent`
    is the same predicate the console reads as `layoutChecked`, so a binding
    the notice is holding its tongue for is exactly one this will re-ask.
  */
  if (storageLayoutAnswerIsCurrent(binding)) return { queued: false };

  await consumeRateLimit(ctx, {
    key: `storage.observeLayout:${args.workspaceId}`,
    limit: OBSERVE_LAYOUT_LIMIT,
    windowMs: OBSERVE_LAYOUT_WINDOW_MS,
  });

  await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope: "private",
    operation: { kind: "readStorageLayout" },
  });
  return { queued: true };
}

/**
 * Check an existing binding again, without re-supplying the credential.
 *
 * ## Why this has to exist
 *
 * Verification used to be scheduled from exactly one place — `applyBinding` —
 * so a single transient failure (a DNS blip, a provider having a minute, a
 * bucket policy fixed thirty seconds later) left the row `error` forever, and
 * the only documented cure was to paste the secret access key again. That is
 * both terrible and *dangerous*: it trains people to re-enter a credential to
 * fix problems that have nothing to do with the credential, which is exactly
 * the habit a phishing page wants them to have.
 *
 * ## Why it is a mutation that schedules rather than an action that probes
 *
 * `verifyStorageBinding` decrypts. Anything that **calls** it has a decrypted
 * credential in its own scope, which `__tests__/structure.test.ts` forbids for a
 * public function — correctly, because the return value of a call flows back to
 * the caller. Scheduling is a different edge: the scheduler discards the job's
 * result and there is no channel back to whoever queued it, so this function
 * can *cause* a probe without ever being able to see a credential. Nothing here
 * returns anything the probe learns; the outcome shows up where it belongs, on
 * the row, via `getStorageBinding`.
 *
 * Being a mutation also makes the rate limit real: `consumeRateLimit` writes,
 * and it commits in the same transaction as the scheduled job, so a refused
 * request queues nothing and a queued probe is always counted.
 *
 * ## Why every status is allowed
 *
 * `error` is the obvious one. `unverified` matters because the original probe
 * can be lost (a deploy mid-flight, a scheduler failure) and there would
 * otherwise be nothing to re-run it. `connected` matters because a re-check of
 * a binding we *believe* is healthy is exactly what someone does when the
 * gateway starts failing — and because a credential revoked at the provider
 * still reads `connected` here until something asks.
 *
 * The status is deliberately **not** reset to `unverified` while the probe
 * runs. Doing that would make a currently-working binding unusable to the
 * gateway (`isUsable` accepts only `connected`) for the duration of a check the
 * owner ran precisely because things were working.
 *
 * Owner-only, for the same reason `bindStorage` is: it is an action on the
 * workspace's credential and it spends the workspace's budget.
 */
export async function reverifyStorageHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) {
    throw new ConvexError({
      code: "NO_STORAGE_BINDING",
      message: "This workspace has no storage binding to check.",
    });
  }

  // Counted before the schedule, in the same transaction: a refusal throws
  // and rolls the whole thing back, so a probe is never queued uncounted and
  // a count never survives a probe that was not queued.
  await consumeRateLimit(ctx, {
    key: `storage.reverify:${args.workspaceId}`,
    limit: REVERIFY_LIMIT,
    windowMs: REVERIFY_WINDOW_MS,
  });

  await ctx.scheduler.runAfter(
    0,
    internal.functions.provisioning.verifyStorageBinding,
    { workspaceId: args.workspaceId, actorUserId: userId },
  );

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "storage.reverify_requested",
    // The status we are checking from, which is the interesting part of the
    // event. No endpoint, no key id, no secret.
    details: { fromStatus: binding.status },
  });

  return { queued: true, status: binding.status };
}

/**
 * Re-probe a binding that predates a capability field, so the field reaches it.
 *
 * ## The failure this repairs
 *
 * `capabilities` held one boolean until 2026-09-12. `conditionalCreate` and
 * `conditionalDelete` were added that day as optional fields, and nothing went
 * back for the rows that already existed. The gateway reads
 * `declared && probed` (`store/factory.js`) and cannot distinguish "probed
 * false" from "never asked", so it fails closed on both — correctly, and that
 * rule is not what changes here. The consequence was that every binding older
 * than that date reported no conditional delete, `moveSafetyRefusal` turned
 * every `move_note`, `move_notes`, `move_folder` and cross-context move into a
 * refusal quoting the storage provider, and the bucket underneath was R2,
 * which has supported all of it the whole time. Nothing re-asked: there is no
 * storage job in `crons.ts`, and `reverifyStorage` needs an owner to press a
 * button for a fault they cannot see and would not guess at.
 *
 * ## Why this is a sweep and not a one-shot migration
 *
 * A one-shot repairs today's rows and leaves the next optional capability to
 * be found by a customer again. The predicate is "any capability field this
 * deployment knows about is absent from this row", so a field added tomorrow
 * is backfilled by the same job without anybody remembering to write one.
 * That is also why it is bounded and self-terminating: once every row carries
 * every field it matches nothing, costs one indexless scan an hour, and stays
 * quiet until the schema grows again.
 *
 * ## What `crons.ts` requires of a job that acts outside this database
 *
 * It holds no decision. Whether this binding may be probed at all, whether its
 * credential still opens, and what the bucket actually enforces are re-asked
 * by `verifyStorageBinding` at the moment it runs, against the row as it then
 * stands — this only decides *when to look*, and it looks exactly once per
 * row per missing field.
 *
 * It does reach a customer's bucket, and that is the part worth stating rather
 * than filing quietly: `probeStore` writes and deletes objects under
 * `.context/`, never note surface, and cleans up after itself. That is the
 * same probe the owner's own reconnect runs. What it must never do is carry a
 * `structure` argument — that would scaffold — so it passes none, which makes
 * this a look-only verification.
 *
 * Restricted to `connected` rows: an `error` or `unverified` binding has an
 * owner already being told to act, and re-probing a credential the provider
 * has revoked on an hourly clock is noise against somebody else's endpoint.
 *
 * ## The scan is indexless, and that is a bound worth naming
 *
 * "Is a field absent" is not something an index answers, so this reads
 * `storageBindings` — one row per workspace that has storage — and stops at
 * the first `CAPABILITY_SWEEP_BATCH` matches. Once every row is repaired it
 * matches nothing and reads the table in full, hourly, for nothing.
 *
 * That is affordable at this deployment's size and it is **not** affordable
 * forever: a Convex transaction may read on the order of ten thousand
 * documents, so a deployment past that many bindings turns this into an hourly
 * error. It fails loudly rather than silently, which is the tolerable
 * direction, and the remedy when it happens is to make the predicate indexed —
 * a `capabilitiesProbedVersion` on the row, bumped when a capability is added,
 * read through a range index — rather than to raise the batch. Stated here so
 * the next person meets the limit as a decision instead of as an incident.
 */
export async function sweepUnprobedCapabilitiesHandler(
  ctx: MutationCtx,
): Promise<{ queued: number }> {
  const rows = await ctx.db
    .query("storageBindings")
    // Bounded, like every other sweep: a backlog drains over several runs
    // rather than in one transaction big enough to hit a limit. The filter
    // runs before the take, so a deployment whose first twenty rows are
    // already repaired still reaches the twenty-first.
    .filter((q) =>
      q.and(
        q.eq(q.field("status"), "connected"),
        q.or(
          q.eq(q.field("capabilities.conditionalCreate"), undefined),
          q.eq(q.field("capabilities.conditionalDelete"), undefined),
          q.eq(q.field("capabilities.serverSideCopy"), undefined),
        ),
      ),
    )
    .take(CAPABILITY_SWEEP_BATCH);

  for (const row of rows) {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.provisioning.verifyStorageBinding,
      // No `actorUserId`: nobody asked for this one. No `structure`: a
      // verification carrying one scaffolds, and this is a look.
      { workspaceId: row.workspaceId },
    );
    // Audited with no actor, which is the honest record of a system action.
    // `verifyStorageBinding` writes no audit of its own — the owner-facing
    // `reverifyStorage` is what audits a probe somebody asked for — so
    // without this the owner would find probe objects appearing and
    // disappearing under `.context/` in a bucket they are told they own,
    // with nothing in their trail that accounts for it.
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      action: "storage.capability_reprobe_queued",
      details: { fromStatus: row.status },
    });
  }
  return { queued: rows.length };
}

/**
 * Forget the credential.
 *
 * Owner-only, and a hard delete rather than a `status: "disconnected"` flag —
 * "revoke the key and we're gone" has to mean the row is gone, not that we
 * kept an encrypted copy with a boolean promising not to use it. The
 * customer's bucket is untouched and every file in it still works.
 *
 * The audit row survives, because "storage was disconnected" is exactly the
 * kind of event you want to still see afterwards. It carries no credential.
 */
export async function disconnectStorageHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) return { disconnected: false };

  if (binding.bucket === managedBucketName(args.workspaceId)) {
    throw new ConvexError({
      code: "MANAGED_STORAGE",
      message:
        "Managed storage cannot be disconnected here; move or export the notes first.",
    });
  }

  // A Dropbox disconnect also disables the grant at Dropbox — otherwise we
  // forget our copy of the credential while the authorization lives on in
  // the person's account, and their next connect silently auto-approves
  // instead of asking. Scheduled, not called: this public mutation must not
  // reach the decrypt. Best-effort, and the envelope travels in the args
  // because the row is deleted on the next line.
  if (
    binding.provider === "dropbox" &&
    binding.encryptedRefreshToken !== undefined
  ) {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.dropboxConnect.revokeDropboxGrant,
      {
        workspaceId: args.workspaceId,
        encryptedRefreshToken: binding.encryptedRefreshToken,
      },
    );
  }

  await ctx.db.delete(binding._id);

  /*
    AND THE PROJECTION OF THEIR NOTES GOES WITH THE CREDENTIAL.

    A `searchIndexes` row with a `databaseId` names a real D1 database holding
    this context's notes — titles, headings, tags, body chunks — on our
    infrastructure. The header above says the point of the hard delete is that
    *"revoke the key and we're gone"* has to mean the row is gone. It was only
    ever true of the row: the derived copy stayed, searchable, with nothing
    pointing at it, which is precisely the state `fastSearch`'s opt-out exists
    to prevent and the account cascade already prevents.

    Scheduled inside `releaseForStorage`, and the row is marked rather than
    removed, so a failed delete stays visible to the sweep instead of becoming
    a database nothing can find.
  */
  await ctx.runMutation(internal.functions.fastSearch.releaseForStorage, {
    workspaceId: args.workspaceId,
  });

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "storage.disconnected",
    details: { provider: binding.provider, bucket: binding.bucket ?? null },
  });
  return { disconnected: true };
}
