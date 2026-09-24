/**
 * Account deletion.
 *
 * One public mutation: the caller deletes *themself*. There is deliberately no
 * "delete this user" argument — an account is not something one person removes
 * for another, and an args-free mutation structurally cannot be aimed at
 * anybody but the identity on the request.
 *
 * ## What "delete my account" means for a workspace
 *
 * A workspace is the unit that owns a context (see CLAUDE.md, "The workspace
 * model"), so the question per membership is: does this context still have an
 * owner once I am gone?
 *
 *  - **I am the only owner** → the context dies with me. Everything hanging
 *    off the workspace goes: the storage binding, the Google connection (the
 *    customer's bucket and their Google account are both untouched — we only
 *    forget our copy of each credential), every in-flight connect attempt for
 *    every provider, ingestion policy and tickets, invitations, grants, the
 *    audit trail, every membership, the slug's row in `names`, and the
 *    workspace row itself — plus, released rather than deleted, the
 *    fast-search index, because after this there is nobody left to press
 *    "turn it off" on a database still holding a projection of the notes. Freeing the slug is the point, not a nicety: the
 *    shared namespace has no other release path, and a deleted account must
 *    not squat a name forever — the person may well re-onboard under it.
 *  - **Somebody else also owns it, or I am not an owner at all** → the context
 *    is not mine to take down. Only my own membership row goes.
 *
 * See `deleteWorkspaceCascade` below for the complete, enumerated list of what
 * a workspace owns, what this sweeps, and what it deliberately leaves behind.
 *
 * ## The rule this file must not break
 *
 * This is a public mutation and it must never touch `decryptSecret` — see
 * `__tests__/structure.test.ts`. A Dropbox binding's grant, and a Google
 * connection's, still has to be revoked at the provider (otherwise our copy of
 * the credential is forgotten while the authorization lives on in the
 * person's account), and that is done the way `disconnectStorage` does it for
 * Dropbox and `disconnectGoogleConnection` does it for Google: the revocation
 * is *scheduled*, envelope in the args because the row is deleted in this
 * transaction, and scheduling is not calling — the scheduler discards the
 * job's result, so no credential can flow back here.
 *
 * Deletion is idempotent-safe within the call: absent optional rows are simply
 * skipped, never a throw. A half-set-up account (no binding, no name, no
 * sessions) deletes as cleanly as a fully onboarded one.
 */

import { v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { mutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { CONNECT_ATTEMPT_TABLES } from "./lib/connectAttempts";
import { isProductionTestAccount } from "./lib/testAccount";
import { managedBucketName } from "./lib/managedStorage";
import { voidCapabilitiesAddressedTo } from "./lib/account/addressedTo";
import { type GenericConnectAttemptQuery, INVITATION_STATUSES } from "./lib/account/cascadeShapes";
import {
  authorizeTestWorkspaceDeletion,
  authorizeWorkspaceDeletion,
} from "./lib/account/deletionGuards";
import { deletePersonalRows } from "./lib/account/personalRows";

/**
 * Delete one disposable workspace owned by the production CUJ account.
 *
 * This is intentionally narrower than a general workspace-delete feature: the
 * caller must be the exact verified test identity, must have created the
 * workspace, and must be its only member. That gives the CUJ a safe teardown
 * path without making an existing shared context—or any customer's storage—a
 * valid target.
 */
export const deleteTestWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    await authorizeTestWorkspaceDeletion(ctx, args);

    await deleteWorkspaceCascade(ctx, args.workspaceId);
    return { deleted: true };
  },
});

/**
 * Delete a **workspace** you own, and give its name back.
 *
 * ## The hole this fills
 *
 * A workspace claims its slug at step 1 of its creation flow, out of the same
 * global namespace usernames come from, and `createWorkspace` counts it
 * against `MAX_WORKSPACES_PER_USER` the moment it commits. Until this existed
 * the only thing that released either was deleting the whole account, so a
 * workspace somebody named, skipped the bucket on and never came back to held
 * that name forever and one of their ten slots with it — a reservation nobody
 * could cancel, the person who made it included. The flow told them
 * "nothing here expires", which was true and was not the reassurance it
 * sounded like.
 *
 * ## What this deletes, and what it cannot
 *
 * The cascade is `deleteAccount`'s, unchanged: our metadata about the
 * workspace, credential envelopes included. **The customer's bucket is not
 * touched** — the same "revoke the key and we're gone" promise
 * `disconnectStorage` makes, which is exactly why this is safe to offer for a
 * workspace on storage the customer owns. Their notes are still theirs, still
 * where they put them, still openable in Obsidian.
 *
 * That promise is what the four guards protect:
 *
 *  - **Owner only.** An editor tearing down somebody else's workspace is the
 *    worst thing this mutation could be made to do. `requireWorkspaceRole`
 *    tells a stranger nothing beyond "not found".
 *  - **The slug, typed.** The account card is guarded by two presses; a
 *    workspace is addressed by name, so its confirmation is the name, and the
 *    check is here rather than in the panel — a client that skipped the field
 *    cannot skip the check. Normalized first, because somebody looking at
 *    `@acme-eng` on screen types the `@`.
 *  - **Shared only.** A personal workspace is the one context a person has
 *    exactly one of, its slug is their username, and its capture address is
 *    live on the apex
 *    (`lib/ingestionStore.ts`). Releasing that is account deletion's business,
 *    and a settings panel is not where somebody should be able to do it by
 *    accident.
 *  - **Not while we hold the only key.** On managed storage the notes live in
 *    a bucket we created and the customer has no credential for, and the free
 *    hand-off path is still unbuilt (`docs/decisions/billing.md`, "What is
 *    deliberately not built"). Deleting the row would either strand their
 *    notes in our infrastructure with nothing pointing at them or, if it went
 *    on to empty the bucket, destroy the only copy. Non-negotiable #1 does not
 *    allow either, so this refuses and says which one it is; the export and
 *    hand-off work is what lifts it.
 */
export const deleteWorkspace = mutation({
  args: { workspaceId: v.id("workspaces"), confirmSlug: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    await authorizeWorkspaceDeletion(ctx, args);

    await deleteWorkspaceCascade(ctx, args.workspaceId);
    return { deleted: true };
  },
});

/**
 * Delete the calling user's account, entirely.
 *
 * Args-free on purpose: the identity on the request is the only account this
 * can remove. Returns a bare `{ deleted: true }` — no email, no name, no
 * credential-shaped anything, because a deletion receipt is a published
 * surface like any other return value.
 */
export const deleteAccount = mutation({
  args: {},
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    // Workspaces first, membership by membership. The cascade deletes the
    // membership row along with everything else, so the two branches converge
    // on "this membership no longer exists".
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const membership of memberships) {
      let soleOwner = false;
      if (membership.role === "owner") {
        const others = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace", (q) =>
            q.eq("workspaceId", membership.workspaceId),
          )
          .collect();
        soleOwner = !others.some(
          (other) => other.role === "owner" && other.userId !== userId,
        );
      }
      if (soleOwner) {
        // Note the edge this deliberately includes: a workspace whose only
        // owner leaves dies even if editors or members remain. An ownerless
        // context has nobody who can rebind storage or revoke a grant, which
        // is not a state to leave anybody in.
        await deleteWorkspaceCascade(ctx, membership.workspaceId);
      } else {
        await ctx.db.delete(membership._id);
      }
    }

    await deletePersonalRows(ctx, userId);

    return { deleted: true };
  },
});

/**
 * Remove a workspace and everything that hangs off it.
 *
 * Called only for a workspace whose sole owner is the account being deleted.
 * The customer's bucket is never touched: what is deleted here is our metadata
 * about it, credential included, which is exactly the "revoke the key and
 * we're gone" promise `disconnectStorage` makes — extended to the whole row
 * set because the context itself is going away.
 *
 * Deliberately placed BELOW the export rather than above it (hoisting makes
 * both work): `__tests__/structure.test.ts` attributes everything before the
 * first `export const` to every export in the module, with no schedule
 * exemption — a preamble helper "cannot hide a call to the decrypt path".
 * Down here the scheduler reference sits inside `deleteAccount`'s analyzed
 * block, where the analyzer can see it is a schedule edge, not a call edge.
 *
 * ## Everything a workspace owns, enumerated
 *
 * A prior review of the pull request that added `googleConnectAttempts`
 * counted eleven tables swept here and found a twelfth, `googleConnectAttempts`
 * itself, named and left out of scope. This is the complete list as of the
 * Google connection and its product state (Gmail/Calendar/Chat) landing
 * alongside it, and what happens to each:
 *
 *  - **`storageBindings`** — swept below. Dropbox's grant is revoked first.
 *  - **`managedStorageMigrations`** — swept before its source binding; it can
 *    carry a second encrypted per-bucket credential while a copy is running.
 *  - **`searchIndexes`** — RELEASED below rather than deleted: marked
 *    `releasing` with `fastSearchProvision.releaseIndex` scheduled, which is
 *    the only path that deletes the remote D1 database holding this context's
 *    projected notes.
 *  - **`googleConnections`** — swept below, the same way. One workspace can
 *    have several (one per connected address); each still-live one has its
 *    grant revoked before its row goes.
 *  - **Every parked connect attempt, every provider** — swept below via
 *    `CONNECT_ATTEMPT_TABLES` (`functions/lib/connectAttempts.ts`), which is
 *    how `dropboxConnectAttempts` and `googleConnectAttempts` are both
 *    covered by one loop instead of one hand-maintained call per provider.
 *  - **`ingestionSettings`**, **`vaultImportJobs`**, **`ingestionTickets`**, **`cloudflareProvisioning`**,
 *    **`workspaceKeyRotations`**, **`workspaceInvitations`** (every status),
 *    **`oauthGrants`**, **`noteShares`** (every status), **`auditEvents`**,
 *    **`workspaceMembers`**, **`names`** — swept below, each with its own
 *    comment on why.
 *  - **`workspaceDataKeys`** — deliberately KEPT. See the comment beside its
 *    sweep further down: it holds the material that opens the customer's
 *    notes in their own bucket, and deleting it on a metadata teardown is an
 *    open product decision, not an oversight. `docs/decisions/encryption.md`,
 *    "What a teardown deletes, and what it keeps".
 *  - **`searchIndexes`** — RELEASED below rather than deleted, which is the
 *    one sweep here that is not a `ctx.db.delete`. A row with a `databaseId`
 *    names a real, billed Cloudflare D1 database holding a projection of this
 *    context's notes — titles, headings, tags and body chunks — so deleting
 *    the row is the opposite of releasing it: `fastSearchProvision.releaseIndex`
 *    reads that row *by workspaceId* to delete the remote database and then
 *    removes it itself, and a cascade that deleted the row first would leave
 *    the customer's note text in our infrastructure with nothing left
 *    pointing at it. So this does exactly what `fastSearch.ts`'s `disable`
 *    does — mark the row `releasing`, schedule the release — because after
 *    this transaction there is no owner left who could ever press that
 *    switch.
 *  - **`oauthAuthorizations`** — swept for the *deleting user's own* approvals
 *    by `deleteAccount` above (by `userId`, not `workspaceId`, since the table
 *    has no workspace index). An authorization approved by a co-owner or
 *    editor for a workspace that is *this* deletion's target, not yet
 *    consumed, is not reached by either sweep — the same class of gap this
 *    file exists to close, bounded the same way `dropboxConnectAttempts`
 *    always was before this change: the row expires within ten minutes and
 *    the hourly sweep in `crons.ts` removes it regardless. Left open rather
 *    than fixed here because reaching it needs an index this table does not
 *    have (`by_workspace`), which is a schema change, not a sweep addition.
 *  - **`usageDaily`**, **`usageActiveDaily`** — deliberately NOT swept. These
 *    hold no credential and no customer content — a day, a metric name from a
 *    closed vocabulary, and a count (`docs/decisions/storage-and-credentials.md`,
 *    "Usage is counted, never logged") — and reading `workspaceId` off an old
 *    row does not let anyone act as that workspace. Deleting them would also
 *    falsify our own historical totals for a day that genuinely happened.
 *  - **`rateLimits`**, **`oauthClients`**, **`renderAssets`**,
 *    **`renderAssetChunks`**, **`adminAuditEvents`**, **`appSecrets`** — not
 *    workspace-owned at all: keyed by an arbitrary string, by client, or
 *    platform-scoped, so a workspace teardown has nothing to key a sweep on.
 */
async function deleteWorkspaceCascade(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const workspace = await ctx.db.get(workspaceId);
  const creator =
    workspace === null ? null : await ctx.db.get(workspace.createdBy);
  const deleteManagedTestResources = isProductionTestAccount(creator);
  // A managed-storage copy parks a second encrypted bucket credential. Remove
  // it before its source binding so no orphan can survive account deletion.
  const managedMigration = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (managedMigration !== null) await ctx.db.delete(managedMigration._id);

  // The storage binding, with the same Dropbox care `disconnectStorage`
  // takes: schedule the revocation first, envelope in the args, because the
  // row it lives on is deleted on the next line. Scheduled, not called — this
  // public mutation must not reach the decrypt.
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (binding !== null) {
    if (
      deleteManagedTestResources &&
      binding.bucket === managedBucketName(workspaceId) &&
      binding.accessKeyId !== undefined
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.managedProvisioning.deleteManagedTestResources,
        { workspaceId, bucket: binding.bucket, tokenId: binding.accessKeyId },
      );
    }
    if (
      binding.provider === "dropbox" &&
      binding.encryptedRefreshToken !== undefined
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.dropboxConnect.revokeDropboxGrant,
        {
          workspaceId,
          encryptedRefreshToken: binding.encryptedRefreshToken,
        },
      );
    }
    await ctx.db.delete(binding._id);
  }

  // Every Google connection this workspace made — `by_workspace` rather than
  // `.unique()` because one workspace can have several addresses connected
  // (`googleConnections.by_workspace_address`). Same care as the storage
  // binding above: schedule the revoke first, envelope in the args, because
  // the row is deleted next. A connection already disconnected carries an
  // empty `encryptedRefreshToken` (`disconnectGoogleConnection`) — nothing to
  // revoke, so nothing is scheduled for it, mirroring
  // `revokeGoogleGrant`'s own no-op on an empty token.
  const googleConnections = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const connection of googleConnections) {
    if (connection.encryptedRefreshToken.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.googleConnect.revokeGoogleGrant,
        {
          workspaceId,
          encryptedRefreshToken: connection.encryptedRefreshToken,
        },
      );
    }
    await ctx.db.delete(connection._id);
  }

  // Every in-flight connect attempt, for every provider that has one. No
  // workspace index exists on these tables — each is keyed by state for its
  // callback — but rows live minutes (`expiresAt` is short by design), so the
  // unindexed walk is over tables that are small by construction, and a
  // parked verifier must not outlive its workspace.
  //
  // `CONNECT_ATTEMPT_TABLES` is derived from the schema itself
  // (`functions/lib/connectAttempts.ts`), not hand-listed — see that module
  // for why: `googleConnectAttempts` was reviewed and named as missing from
  // this exact loop when it was Dropbox-only, and a third provider built the
  // same way must not repeat it. The cast below is the price of that: Convex
  // types `db.query` per concrete table, and a table name discovered
  // generically here does not narrow to one at compile time. What is not
  // generic is which fields are read — `connectAttemptTables` only ever
  // returns a table it has already proven has both `workspaceId` and
  // `encryptedVerifier`.
  for (const tableName of CONNECT_ATTEMPT_TABLES) {
    const query = ctx.db.query(tableName) as GenericConnectAttemptQuery;
    const attempts = await query
      .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
      .collect();
    for (const attempt of attempts) {
      await ctx.db.delete(attempt._id);
    }
  }

  // The model account the agent spends. An envelope holding somebody's own
  // Anthropic or OpenAI key, so it dies with the workspace for the same reason
  // the storage secret does: a credential outliving the thing it was scoped to
  // is a credential nobody is watching. Nothing is revoked on the way out —
  // the key belongs to the customer's provider account and is theirs to
  // rotate; deleting our copy is the whole of what we can do.
  const providerCredentials = await ctx.db
    .query("providerCredentials")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const credential of providerCredentials) {
    await ctx.db.delete(credential._id);
  }

  // The ingestion policy. `unique()` would also work — one row per personal
  // context — but a shared context has none, and collect-then-delete treats
  // "no row" as the ordinary case it is.
  const ingestionSettings = await ctx.db
    .query("ingestionSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const settings of ingestionSettings) {
    await ctx.db.delete(settings._id);
  }

  // Local vault bytes never enter Convex, but their resumable counters belong
  // to this workspace and must not survive it. Several rows can exist because
  // selecting a different vault pauses the earlier job rather than erasing its
  // honest progress.
  const vaultImportJobs = await ctx.db
    .query("vaultImportJobs")
    .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const job of vaultImportJobs) {
    await ctx.db.delete(job._id);
  }

  // Outstanding ingestion tickets. Same shape as the connect attempts: keyed
  // by ticket hash, short-lived and swept, so the unindexed walk is bounded by
  // the table's own TTL — and a live ticket for a deleted context would
  // otherwise still buy one credential fetch.
  const tickets = await ctx.db
    .query("ingestionTickets")
    .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
    .collect();
  for (const ticket of tickets) {
    await ctx.db.delete(ticket._id);
  }

  // A provisioning row, pending or failed. A pending one may still hold the
  // sealed account-level Cloudflare credential; a workspace being destroyed is
  // the strongest possible version of "this attempt is over".
  const provisioningRows = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of provisioningRows) {
    await ctx.db.delete(row._id);
  }

  // What this context pays for, and any checkout attempt open on it.
  //
  // THE SUBSCRIPTION IS CANCELLED FIRST, and the same care the Dropbox
  // revocation above takes and for the same reason: the id rides in the args
  // because the row carrying it is deleted on the next line. Scheduled, not
  // called — this public mutation must not reach the payment key.
  //
  // Without it, deleting a context bills the customer every month with no route
  // in the product to stop it: `startPortal` is the only cancellation path and
  // it is reached from *this* context's Premium section. That is a chargeback
  // rather than a loose end, which is why it is here rather than on a list.
  //
  // A cancellation Stripe refuses is logged and lost — there is no row left to
  // record it on. `docs/decisions/billing.md` names that residual.
  const planRows = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const plan of planRows) {
    if (plan.stripeSubscriptionId !== undefined) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.billingStripe.cancelSubscription,
        { subscriptionId: plan.stripeSubscriptionId },
      );
    }
    await ctx.db.delete(plan._id);
  }
  const billingSessionRows = await ctx.db
    .query("billingSessions")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of billingSessionRows) {
    await ctx.db.delete(row._id);
  }

  // The fast-search index, RELEASED rather than deleted — the one row here
  // that a `ctx.db.delete` would make worse. Its `databaseId` names a live
  // Cloudflare D1 database holding a projection of this context's notes (see
  // `apps/mcp/src/search/d1/project.js`: path, title, headings, tags, body),
  // and that database is reachable only through this row. Deleting it would
  // strand the customer's note text in our infrastructure permanently, which
  // is the opposite of what a teardown is for.
  //
  // So this is `fastSearch.ts`'s own `disable`, minus the person: mark the
  // row `optedIn: false` / `releasing` — which serves nothing from that
  // moment, `fastSearchOptedIn` reads `optedIn` — and schedule
  // `releaseIndex`, which deletes the remote database and then removes the
  // row itself via `forgetIndex`. Scheduled, not called, for the same reason
  // the two revokes above are: that action decrypts the platform's D1 token.
  //
  // Nobody is left to press the switch after this transaction, which is why
  // the cascade has to press it. If the release fails (the token is
  // unconfigured, Cloudflare is down) the row stays `releasing` and no cron
  // retries it today — a known residual, but a strictly smaller one than a
  // `ready` row nobody will ever look at again: the row is exactly the handle
  // a retry needs, and it is now marked as owing one.
  const searchIndex = await ctx.db
    .query("searchIndexes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (searchIndex !== null) {
    if (searchIndex.databaseId === undefined) {
      // Nothing was ever created — a failed provision, or an opt-in reversed
      // before it got that far. Same branch `disable` takes: the row goes now.
      await ctx.db.delete(searchIndex._id);
    } else {
      await ctx.db.patch(searchIndex._id, {
        optedIn: false,
        status: "releasing",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.functions.fastSearchProvision.releaseIndex,
        { workspaceId },
      );
    }
  }

  /*
    ANY WORKSPACE-KEY ROTATION ROW, IN EITHER STATUS.

    Pure bookkeeping — a workspace id, two generation labels, two timestamps,
    and no key material of any kind. Its only job is the "at most one rotation
    in progress" boolean (`schema.ts`, `workspaceKeyRotations`), which is a
    fact about a workspace that is ceasing to exist.

    NOT the `workspaceDataKeys` rows beside it, and that asymmetry is the
    point rather than an omission. Those rows hold the sealed material that
    opens this customer's encrypted notes, and those notes are in the
    customer's own bucket, which this cascade's own header promises never to
    touch. Deleting them here would reach through the metadata we are entitled
    to delete and destroy content we are not — silently, for anybody who never
    exported. Keeping them has its own cost, named in
    `docs/decisions/encryption.md` under "What a teardown deletes, and what it
    keeps", and it is a decision for the owner of this product rather than a
    line an agent adds to a sweep. `__tests__/account.test.ts` asserts both
    halves so neither can drift by accident.
  */
  const rotationRows = await ctx.db
    .query("workspaceKeyRotations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rotationRows) {
    await ctx.db.delete(row._id);
  }

  // Invitations, in every status — a teardown is the one read the
  // status-narrowed index shape has to serve in full.
  for (const status of INVITATION_STATUSES) {
    const invitations = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", status),
      )
      .collect();
    for (const invitation of invitations) {
      await ctx.db.delete(invitation._id);
    }
  }

  /*
    EVERYTHING THE OBSIDIAN PLUGIN SUBSYSTEM RECORDED ABOUT THIS CONTEXT.

    None of it is sealed credential material, so `cascadeCoverage.test.ts`
    does not cover it — that guard derives an `encrypted…` field and names, in
    its own header, the shapes that escape it. These are one of them, and the
    reason they still belong here is that this cascade's contract has never
    been "sweep the credentials": it sweeps `ingestionSettings`,
    `vaultImportJobs`, `workspaceInvitations` and `auditEvents` too, none of
    which hold one. What it sweeps is everything that is only true because
    this workspace exists.

    A grant is authority over one reviewed bundle, and `listPluginGrants`
    calls the set of them "private workspace metadata" in its own docstring —
    which software somebody ran and which hosts it was allowed to reach. A
    session is a hashed bearer binding; it is already fail-closed once the
    memberships above are gone, because `executePluginRequest` re-authorizes
    at `minimum: "owner"` on every call, but the cascade's own rule about a
    parked ticket applies whether or not the door it opens still exists. A
    runtime state carries free text somebody reported about their own plugin's
    failures, which can name their own note paths.

    `obsidianPluginRuntimeRequests` is the one with no `workspaceId` at all —
    it is keyed by `tokenHash` — so it is reachable only through the session
    that owns it, and it is swept inside that loop rather than after it.
    Sweeping the four indexed tables and stopping would leave it behind.
  */
  const pluginSessions = await ctx.db
    .query("obsidianPluginRuntimeSessions")
    .withIndex("by_workspace_plugin", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const session of pluginSessions) {
    const claims = await ctx.db
      .query("obsidianPluginRuntimeRequests")
      .withIndex("by_session_request", (q) => q.eq("tokenHash", session.tokenHash))
      .collect();
    for (const claim of claims) await ctx.db.delete(claim._id);
    await ctx.db.delete(session._id);
  }
  const pluginGrants = await ctx.db
    .query("obsidianPluginGrants")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const grant of pluginGrants) await ctx.db.delete(grant._id);
  const pluginLifecycles = await ctx.db
    .query("obsidianPluginLifecycles")
    .withIndex("by_workspace_plugin", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const lifecycle of pluginLifecycles) await ctx.db.delete(lifecycle._id);
  const pluginRuntimeStates = await ctx.db
    .query("obsidianPluginRuntimeStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const state of pluginRuntimeStates) await ctx.db.delete(state._id);

  // Every AI-client grant on this context, whoever holds it. A grant is
  // authority over a workspace; the workspace is ceasing to exist, so an
  // editor's still-active grant must not survive as a dangling credential.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }

  // Every note share this context handed out, in both statuses. A share is a
  // standing capability addressed to somebody who is NOT a member, so it is
  // reachable by a person the sweeps above never touch, and — unlike an
  // invitation — it does not expire by default. Revoked rows go too: nothing
  // can read them once the context is gone, and leaving them would be keeping
  // rows about a workspace that no longer exists.
  //
  // Unbounded, like every sibling sweep in this function, and for the same
  // reason: a teardown that stops early leaves rows behind. `MAX_ACTIVE_SHARES`
  // caps only *active* rows, so this range can be larger than that cap — but
  // paging it would not change what the transaction has to read and write, only
  // how much is held at once, and `auditEvents` below is unbounded and larger
  // per context. If a teardown ever outgrows one transaction the answer is a
  // scheduled continuation, not a smaller page.
  for (const status of ["active", "revoked"] as const) {
    const shares = await ctx.db
      .query("noteShares")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", status),
      )
      .collect();
    for (const share of shares) {
      await ctx.db.delete(share._id);
    }
  }

  // The audit trail. Unlike a disconnect — where "storage was disconnected"
  // must remain visible — there is nobody left to read this one: the context
  // and its only owner are both going.
  const events = await ctx.db
    .query("auditEvents")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const event of events) {
    await ctx.db.delete(event._id);
  }

  // Every membership, the deleting owner's included.
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const membership of memberships) {
    await ctx.db.delete(membership._id);
  }

  // The slug's row in the shared namespace. This is what frees the name for
  // anyone — including the departing person, should they return.
  const nameRows = await ctx.db
    .query("names")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of nameRows) {
    await voidCapabilitiesAddressedTo(ctx, row.name);
    await ctx.db.delete(row._id);
  }

  await ctx.db.delete(workspaceId);
}

/**
 * More rows than any sweep here would ever page over, for the tests that prove
 * these sweeps are complete.
 *
 * The sweeps are plain `.collect()` loops now, so there is no page boundary to
 * cross — but the failure they guard against is "stopped early", and a test
 * that seeds one share cannot see it. Exported and used by `shares.test.ts` so
 * the seeding count and this reasoning stay in one place.
 */
export const SWEEP_COMPLETENESS_ROWS = 101;
