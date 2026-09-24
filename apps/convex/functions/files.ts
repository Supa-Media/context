/**
 * The file editor's data path.
 *
 * This is what lets a person actually *edit their context* from the console —
 * create, rename, move, duplicate, copy, archive, delete, and change what a
 * note is visible to — instead of opening Obsidian to do it.
 *
 * ## Where the bytes live, and where they do not
 *
 * Note content lives in the customer's bucket and nowhere else. It travels
 * through an action and is returned to the caller; it is **never** written to
 * a table, an audit `details` field, a log line, or an error message. That is
 * CLAUDE.md non-negotiable #1, and `__tests__/fileContent.test.ts` asserts it
 * behaviourally across every operation rather than trusting this paragraph.
 *
 * What *is* recorded is the audit trail: which identity did what, to which
 * paths. Paths are metadata. Content is not.
 *
 * ## The credential barrier
 *
 * There is exactly one new function in this codebase that can obtain a
 * decrypted bucket credential: `runFileOperation`. It is an `internalAction`,
 * so no client can reach it. It opens the credential, builds one `S3Store`,
 * hands that store to `lib/fileOps.ts`, and returns a **result** — a listing, a
 * note, an etag. It never returns the credential, never puts it in an error,
 * and never stores it.
 *
 * The public actions below call it. That is a real change to the property
 * `__tests__/structure.test.ts` enforces — previously *no* public function
 * could transitively reach the decrypt path at all — and it is made
 * deliberately, with the guard strengthened rather than loosened around it:
 *
 *  - the set of "barrier" functions is enumerated and pinned in that test, so
 *    adding a second one is a visible, reviewed change, not an accident;
 *  - a public function may reach the decrypt path **only** through a barrier.
 *    Calling `getBindingForGateway` directly is still a hard failure, which is
 *    exactly the attack that test was written around;
 *  - the analyzer now also treats a module-level `internal.…` reference as
 *    tainting the whole module, closing the "hide the call in a helper above
 *    the first export" hole that would otherwise make the barrier optional.
 *
 * Read the block comment in `structure.test.ts` before adding a barrier.
 *
 * ## Authorization
 *
 * Every operation resolves the caller's membership through the same
 * `requireWorkspaceAccess` / `requireWorkspaceRole` the rest of the control
 * plane uses. Reading needs `member`; writing needs `editor` or `owner`. A
 * non-member gets `WORKSPACE_NOT_FOUND` — the same error as for a workspace
 * that never existed.
 *
 * ## Visibility
 *
 * The caller's *scope* comes from their role, and it is deliberately strict:
 *
 *   owner  → `private` scope — sees everything, including private notes
 *   editor → `team` scope
 *   member → `team` scope
 *
 * `private` means "only you" (CLAUDE.md #5). Anyone who is in your workspace
 * because you put them there is, by definition, "named people you granted
 * access to" — which is `team`. Being able to *write* is a separate grant from
 * being able to see what you marked private, and conflating them is how an
 * editor invited to help with one project ends up reading a private folder.
 *
 * This is a product decision as much as a technical one; it is called out in
 * the build report.
 */

import { ConvexError, v } from "convex/values";
import {
  WORKSPACE_ICON_CONTENT_TYPES,
  WORKSPACE_ICON_MAX_BYTES,
  matchesDestructiveActionAcknowledgement,
} from "@context/shared";
import { internal } from "../_generated/api";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { clearanceOf } from "./lib/clearance";
import {
  type TreeChange,
  audiencesForChange,
  trimTrailingSlashes,
} from "./lib/treeAnnounce";
import { resolveAddressedUser } from "./lib/identities";
import { storeForBinding } from "../../mcp/src/store/factory.js";
// The gateway's D1 wire, imported rather than ported, for the same reason
// `lib/fileOps.ts` imports its search: `apps/mcp` targets the Workers runtime,
// which is Convex's runtime too. It holds the write token for the life of one
// call and puts it in exactly one place, an `Authorization` header.
import { createD1Client } from "../../mcp/src/search/d1/client.js";
import {
  STORAGE_LAYOUT_ROLLBACK_MS,
} from "../../mcp/src/storageLayout.js";
/*
 * The Gmail pipeline, imported rather than ported, for exactly the reason the
 * two imports above are: `apps/mcp` targets the Workers runtime, which is
 * Convex's runtime too, and this module takes its socket, its access token and
 * its store as parameters — it opens nothing itself.
 *
 * It came back with the forward sync loop. #388 removed the historical
 * backfill that used to import it and left the module reachable from nothing
 * at all, which is how a complete, fixture-tested mail pipeline sat in the
 * repository while connected mailboxes synced nothing.
 */
import {
  getProfileHistoryId,
  GmailApiError,
  runIncrementalSync,
  writeContactDraft,
  writeDayPart,
} from "../../mcp/src/communications/gmailSync.js";
import { placeDayParts } from "../../mcp/src/communications/dayPlacement.js";
import {
  listMessagesPage,
  listSpacesPage,
} from "../../mcp/src/communications/googleChat/client.js";
import {
  renderSharedGoogleChat,
  syncGoogleChat,
} from "../../mcp/src/communications/googleChat/sync.js";
import {
  ChatContributionIncompleteError,
  loadActiveChatContributions,
  persistChatContribution,
} from "../../mcp/src/communications/googleChat/contributionStore.js";
import { syncCalendarAccount } from "../../mcp/src/communications/calendar-sync.js";
import {
  CalendarContributionIncompleteError,
  loadActiveCalendarContributions,
  loadCalendarContribution,
  persistCalendarContribution,
} from "../../mcp/src/communications/calendarContributionStore.js";
import {
  calendarDayNotePath,
  mergeEventCaches,
  projectDay,
  renderCalendarDay,
} from "../../../packages/communications/src/calendar/index.js";
import { fnv1a64 } from "../../../packages/communications/src/anchors.js";
import {
  D1_ACCOUNT_SECRET,
  D1_TOKEN_SECRET,
  messageFor,
} from "./lib/d1";
import {
  type BlendSource,
  decodeCursor,
  depthFor,
  encodeCursor,
  fuse,
  pageOf,
  queryFingerprint,
  resolveScope,
} from "./lib/blendedSearch";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  type PrivacyState,
  loadPrivacyState,
  READ_BATCH_PATHS,
  type ProjectionClient,
  pasteImageLeaf,
  workspaceIconLeaf,
} from "./lib/fileOps";
import {
  type FormNotifyMaterial,
} from "./lib/formOps";
import {
  requireWorkspaceAccess,
  requireWorkspaceRole,
} from "./lib/workspaceAuth";
import {
  type ActivityEntry,
} from "./lib/activity";
import type { GatewayCredential } from "./storage";
import {
  activityEntryValidator,
  deletedValidator,
  durableMoveValidator,
  fileValidator,
  folderCreatedValidator,
  folderPathsValidator,
  listingValidator,
  manifestValidator,
  movedValidator,
  notesValidator,
  privacyResetValidator,
  storageMigrationResultValidator,
  vaultImportJobStatusValidator,
  vaultImportResultValidator,
  visibilityResultValidator,
  visibilityValidator,
  writtenValidator,
} from "./lib/filesFns/validators";
import {
  pluginInventoryValidator,
  pluginManagedInstallsValidator,
} from "./lib/filesFns/pluginValidators";
import {
  blendedResultsValidator,
  notePathsValidator,
  searchResultsValidator,
} from "./lib/filesFns/searchValidators";
import { operationResultValidator, operationValidator } from "./lib/filesFns/operationValidators";
import {
  type FileOperation,
  IDLE_PROJECTION,
  type OperationResult,
} from "./lib/filesFns/operationTypes";
import { callerId, resolveFileAccess, treeChangeOf } from "./lib/filesFns/access";
import {
  CalendarTimezoneMismatchError,
  type ForwardSyncJob,
  type ForwardSyncResult,
  classifyForwardSyncError,
  timeoutFetch,
  writeSharedCalendarDay,
} from "./lib/filesFns/forwardSyncSupport";
import { executeOperation } from "./lib/filesFns/executeOperation";
import { toConvexError } from "./lib/filesFns/operationErrors";
import {
  type BlendedAnswer,
  SOURCE_DEADLINE_MS,
  withDeadline,
} from "./lib/filesFns/searchDeadline";
import {
  MAX_VAULT_IMPORT_BATCH_BYTES,
  MAX_VAULT_IMPORT_BATCH_FILES,
  type VaultImportJobStatus,
  validateVaultImportPlan,
  vaultImportJobStatus,
} from "./lib/filesFns/vaultImportPlan";
export { scopeForRole, resolveFileAccess, callerId } from "./lib/filesFns/access";
export { executeOperation } from "./lib/filesFns/executeOperation";

/**
 * Maintenance passes that may chain behind one search's worth of work.
 *
 * A workspace of a few thousand notes does not index in one pass, and the
 * alternative to chaining is what the project note calls out as still open:
 * "the complete backfill finishes without requiring repeated user searches".
 * Making somebody search eight times to finish their own index is making them
 * do the system's work.
 *
 * Each link is scheduled only by a pass that **made progress and did not
 * finish**, so a converged bucket stops at one and a bucket that cannot
 * converge — an unreadable folder, a shard that will not fit — stops as soon
 * as it stops changing rather than looping on the customer's request quota.
 * The bound is the backstop for the case both of those miss.
 */
const INDEX_SYNC_CHAIN = 12;

export { DELETE_CONFIRMATION };

/* -------------------------------------------------------------------------- */
/*                               authorization                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve membership and clearance.
 *
 * INTERNAL. `actorUserId` is supplied by the calling public action, which read
 * it from the session — the same arrangement `storage.applyBinding` uses, and
 * safe for the same reason: an internal function is unreachable from any
 * client, so there is nobody who could pass a forged one.
 *
 * ## Where the pinned context gets in, and why it is only here
 *
 * `@context-lc` is readable by every account without a membership row
 * (`lib/pinnedContext.ts`). This function is the one door into the bucket for
 * the console, so it is the one place that needs to know — and the whole of the
 * grant is the `minimum === "member"` branch below.
 *
 * **The `minimum` is what makes this safe, and it is worth being explicit about
 * why.** Every caller states the least role its operation needs, and the ones
 * that ask for `member` are exactly the reads: `listFiles`, `readNote`,
 * `syncManifest`, `readNotes`, `searchContext`, `folderPaths`, `notePaths`,
 * and the per-context leg of `searchContexts`.
 * Everything that changes a byte asks for `editor` or `owner` and therefore
 * goes to `requireWorkspaceRole`, which knows nothing about the pin and throws
 * `WORKSPACE_NOT_FOUND` for somebody with no row — so a pinned reader is
 * refused a write here by the same code that refuses a stranger, rather than by
 * a second check that could be forgotten.
 *
 * The scope is `team`, from `scopeForRole("member")` like any other member, so
 * the pin cannot surface a note held private in that workspace.
 *
 * **What this does not open.** `requireWorkspaceAccess` itself is untouched, so
 * the member list, audit, billing, the storage binding, grants, shares, groups
 * and invitations all still refuse a pinned reader. Blended search is untouched
 * too: `searchContexts` only ever authorizes contexts `searchableContextsFor`
 * already returned, and that is driven off real memberships, so the pinned
 * context is not swept into everybody's cross-context search — which would have
 * pointed every account's search at one bucket.
 */
export const authorizeFileAccess = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    minimum: v.union(v.literal("member"), v.literal("editor"), v.literal("owner")),
  },
  returns: v.object({
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    scope: v.union(v.literal("private"), v.literal("team")),
    /**
     * The `@name` rules this caller reaches, from live membership.
     *
     * Beside `scope` rather than folded into it, because a name is not a tier:
     * `Scope` stays two-valued in both engines and in every grant, and a name
     * widens what a `team` caller may reach one rule at a time. See
     * `lib/clearance.ts`.
     */
    grantedNames: v.array(v.string()),
    /**
     * The caller's own `@name` — their personal workspace's slug — for the
     * line `activity.md` writes about what they did.
     *
     * Display text and nothing else: every authorization decision above reads
     * the membership row. `null` for an account with no personal context,
     * which is not a state the product produces but is one a self-hosted
     * deployment can, and a line reading "Someone revised" is better than one
     * naming an id.
     */
    actorName: v.union(v.string(), v.null()),
  }),
  handler: (ctx, args) => resolveFileAccess(ctx, args),
});

/**
 * Tell the audiences that can see this change that their tree is stale.
 *
 * After the operation and never inside it, like the activity stamp: the
 * change is in the customer's bucket by now, a hint is a derivative of it,
 * and a failure to send one must never look like a failed save — so every
 * step is inside the catch, and a lost hint is caught by the client's
 * periodic walk. An operation that threw never reaches here, so a failed
 * change is never announced.
 *
 * Who is told is `audiencesForChange`, beside `treeAudiences`.
 */
async function announceTreeChange(
  ctx: ActionCtx,
  store: FileStore,
  workspaceId: Id<"workspaces">,
  change: TreeChange,
  result: OperationResult,
  before: PrivacyState | null,
): Promise<void> {
  try {
    const paths = [...change.paths];
    const gone = new Set((change.gone ?? []).map(trimTrailingSlashes));
    // Where a note actually landed — an archive's dated folder, a duplicate's
    // new name — is only in the answer. Its source is gone from where it was.
    if (result.kind === "moved") {
      const moved = result as { from?: unknown; to?: unknown };
      if (typeof moved.from === "string") {
        paths.push(moved.from);
        gone.add(trimTrailingSlashes(moved.from));
      }
      if (typeof moved.to === "string") paths.push(moved.to);
    }
    const after = await loadPrivacyState(store);
    const audiences = audiencesForChange({ change, paths, gone, before, after });
    if (audiences.length === 0) return;
    await ctx.runMutation(internal.functions.treeSignals.markTreeChanged, {
      workspaceId,
      audiences,
    });
  } catch {
    // See above: a hint is never a failed change.
  }
}

/* -------------------------------------------------------------------------- */
/*                            the credential barrier                          */
/* -------------------------------------------------------------------------- */

/**
 * THE CREDENTIAL BARRIER. Read the module comment before changing this.
 *
 * The only function added by the file editor that opens a bucket credential.
 * It builds one store, performs one operation, and returns a result that by
 * construction contains no credential: `operationResultValidator` has no field
 * that could hold one, and Convex enforces that validator on the way out.
 *
 * INTERNAL ACTION, so no client can call it. Its callers are the public
 * actions below, each of which has already established that the caller is a
 * member of this workspace with a sufficient role.
 */
export const runFileOperation = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    scope: v.union(v.literal("private"), v.literal("team")),
    /**
     * The `@name` rules this caller answers to, resolved by
     * `authorizeFileAccess` from live membership.
     *
     * Optional because a scheduled pass — a projection link, an index sweep —
     * re-enters this action with no caller at all, and the honest clearance
     * for nobody is no names. Every such pass runs `scope`-blind or at the
     * owner's `private`, so none of them loses anything by it.
     */
    grantedNames: v.optional(v.array(v.string())),
    /**
     * Who to name in `activity.md`, from `authorizeFileAccess`.
     *
     * Optional because a scheduled pass has no caller, and those record
     * nothing anyway — see `executeOperation`'s `actor` parameter.
     */
    actorName: v.optional(v.union(v.string(), v.null())),
    operation: operationValidator,
  },
  returns: operationResultValidator,
  // Annotated rather than inferred: this action calls another function in the
  // same deployment, which is the inference cycle `bindStorage` has.
  handler: async (ctx, args): Promise<OperationResult> => {
    /*
     * A PROJECTION PASS ASKS THE ROW BEFORE IT ASKS FOR A CREDENTIAL.
     *
     * This link may have been scheduled minutes ago by a chain, a provisioner,
     * or the sweep, and in that time an owner can have turned fast search off.
     * A pass that opened the bucket first and then discovered it had nothing
     * to do would have decrypted a customer's storage secret on the way to
     * doing nothing — so the order here is the guard. The test that pins it
     * deletes the storage binding, because "no bucket request was made" cannot
     * see the mutant: opening a credential makes none.
     *
     * `projectionTargetForWorkspace` is the same composed gate that decides
     * whether a D1 write credential may leave this deployment for the gateway,
     * and every reason to say no is the same `null`. `backfilling` and nothing
     * else: a `ready` row is served by the gateway riding its own search's
     * sync, and a chain that kept running against one would be a full bucket
     * listing per link, forever, for a context with nothing left to copy.
     */
    let projection: ProjectionClient | null = null;

    /**
     * This context's search database, if the row is in the state the caller
     * needs and this deployment is configured.
     *
     * Two callers now and they want opposite states, which is the whole reason
     * this is a parameter rather than a constant: a projection pass may only
     * run against a row that is still `backfilling`, and a search may only
     * READ one the control plane has called `ready` — the same gate the
     * gateway applies, because a projection that is still filling answers a
     * query about a note it has not copied with a silence a reader would take
     * for a miss.
     *
     * `null` for every way of saying no, and they are deliberately
     * indistinguishable to the caller: not opted in, not provisioned, wrong
     * state, or a deployment with no Cloudflare credential.
     */
    const projectionTarget = async (required: "backfilling" | "ready") => {
      const target = await ctx.runQuery(
        internal.functions.fastSearch.projectionTargetForWorkspace,
        { workspaceId: args.workspaceId },
      );
      return target === null || target.state !== required ? null : target;
    };

    /**
     * The client for a target the caller has already accepted.
     *
     * Held apart from the lookup above because the two callers do different
     * things with `null` from each: a wrong state is an ordinary no for both,
     * and a missing Cloudflare credential is a reported failure for a pass and
     * a silent fall-through for a search.
     */
    const clientFor = async (
      target: { databaseId: string; state: string },
    ): Promise<ProjectionClient | null> => {
      // Ours, not a customer's — `appSecrets` holds this deployment's own
      // integration credentials.
      const apiToken = await ctx.runAction(
        internal.functions.admin.readIntegrationSecret,
        { name: D1_TOKEN_SECRET },
      );
      const accountId = await ctx.runAction(
        internal.functions.admin.readIntegrationSecret,
        { name: D1_ACCOUNT_SECRET },
      );
      if (
        typeof apiToken !== "string" ||
        apiToken.length === 0 ||
        typeof accountId !== "string" ||
        accountId.length === 0
      ) {
        // Both or neither, as `provisionIndex` reads them: a half-configured
        // deployment is two error states with one cure.
        return null;
      }
      return createD1Client(
        { databaseId: target.databaseId, accountId, apiToken, state: target.state },
        // No `fetchImpl`: the client resolves `globalThis.fetch` per call and
        // carries its own deadline. Handing it `timeoutFetch` would *replace*
        // the abort signal it sets with a longer one, quietly disabling the
        // timeout it thinks it has.
      ) as ProjectionClient;
    };

    /*
     * A SEARCH READS THE PROJECTION AND NEVER WRITES THE ROW.
     *
     * The asymmetry with the pass below is deliberate and is the reason these
     * are two blocks rather than one. A projection pass that cannot reach its
     * database must SAY so — a workspace sitting at "Preparing" with nothing
     * to explain why is the bug that whole path exists to close. A search must
     * do the opposite: somebody typed a word, and a deployment whose
     * Cloudflare credential is missing must not have their search flip a
     * provisioning row to `failed` as a side effect. It falls through to the
     * R2 index, which is what every context without fast search does anyway.
     */
    if (args.operation.kind === "search") {
      const target = await projectionTarget("ready");
      if (target !== null) projection = await clientFor(target);
    }

    if (args.operation.kind === "projectIndex") {
      const target = await projectionTarget("backfilling");
      if (target === null) return IDLE_PROJECTION;

      try {
        projection = await clientFor(target);
        if (projection === null) throw new Error("no D1 credential");
      } catch {
        // A deployment nobody has configured is an ordinary state, and the row
        // has to say so: left `backfilling`, it is a person watching a counter
        // that will never move with nothing to explain why. The thrown error
        // can quote the descriptor it was handed, so it is dropped rather than
        // wrapped.
        await ctx.runMutation(
          internal.functions.fastSearch.recordProvisionResult,
          {
            workspaceId: args.workspaceId,
            status: "failed",
            errorCode: "NOT_CONFIGURED",
            error: messageFor("NOT_CONFIGURED"),
          },
        );
        return IDLE_PROJECTION;
      }
    }

    if (args.operation.kind === "googleGmailBackfill") {
      return await runGoogleGmailBackfill(
        ctx,
        args.workspaceId,
        args.operation.runId,
      );
    }

    /*
     * A FORWARD SYNC PASS ASKS THE ROW BEFORE IT ASKS FOR A CREDENTIAL.
     *
     * Same ordering, same reason, as the projection pass above. The sweep that
     * scheduled this holds no decision and ran minutes ago; in between, the
     * account can have been disconnected, its product turned off, or its grant
     * refused by Google. Asking first means none of those decrypt a customer's
     * storage secret on the way to doing nothing.
     *
     * A `null` job means there is no connection row to report against at all,
     * so there is also no claim to release.
     */
    let forwardSyncJob: ForwardSyncJob = null;
    if (args.operation.kind === "googleForwardSync") {
      forwardSyncJob = await ctx.runQuery(
        internal.functions.googleSync.googleForwardSyncJob,
        { workspaceId: args.workspaceId, connectionId: args.operation.connectionId },
      );
      if (forwardSyncJob === null) {
        /*
         * No row this workspace owns — it was deleted, or the pair of
         * arguments does not agree (see `googleForwardSyncJob`). Nothing is
         * written, and in particular the *other* context's row is not: a
         * mismatched pair that released somebody else's claim and pushed their
         * next sync out would be a cross-tenant write, small but real.
         */
        return {
          kind: "googleForwardSync",
          connectionId: args.operation.connectionId,
          status: "skipped",
          daysTouched: 0,
          bytesWritten: 0,
          cursorAdvanced: false,
          gapDetected: false,
          truncated: false,
        };
      }
      if (forwardSyncJob.kind === "skip") {
        return await releaseForwardSync(
          ctx,
          args.operation.connectionId,
          forwardSyncJob.reason,
        );
      }
    }

    let credential: GatewayCredential | null;
    try {
      credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
        workspaceId: args.workspaceId,
      });
    } catch {
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_UNUSABLE",
          "This context's bucket configuration could not be used. Reconnect storage.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_UNUSABLE",
        message:
          "This context's bucket configuration could not be used. Reconnect storage.",
      });
    }
    if (credential === null) {
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_NOT_CONNECTED",
          "This context has no bucket connected yet. Connect storage before syncing Google.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_NOT_CONNECTED",
        message:
          "This context has no bucket connected yet. Connect storage before browsing files.",
      });
    }

    // A plaintext secret is in scope from here to the end of this function. It
    // is used to construct one store and nothing else — it is not logged, not
    // returned, and not passed to `lib/fileOps.ts`, which only ever sees the
    // store.
    let store: FileStore;
    try {
      // One table decides which backend this workspace got — the same table
      // the gateway uses, so the console reads and writes exactly what an AI
      // client does. A second switch here would be the second place to forget
      // a new backend, and the direction that forgetting fails is "built an
      // S3 store out of a Dropbox binding".
      //
      // `timeoutFetch` is forwarded because a console request has somebody
      // waiting on it; the gateway does not need one.
      //
      // `S3Store` *declares* conditional writes because it sends `If-Match`.
      // Whether the backend honours it is a different question, and it was
      // already answered — at connect time, by `probeStore`, against this
      // actual bucket. Backblaze B2 and Wasabi accept the header and write
      // anyway. Taking the declaration would make every save look conflict-safe
      // on exactly the backends where it is not; the observed capability makes
      // `writeFile` fall back to a read-compare and say so.
      //
      // That used to be applied here, on the next line, by hand — and only
      // here, so the gateway's own stores claimed a guarantee they did not
      // have. `storeForBinding` reads the binding's probed capability itself
      // now, for every caller and every backend.
      store = storeForBinding(credential, undefined, {
        fetchImpl: timeoutFetch,
      }) as unknown as FileStore;
    } catch {
      // The constructor's message can quote the endpoint the customer typed.
      // Nothing it says helps here, and re-throwing it would put provider text
      // in front of the user with no way to know what else is in it.
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_UNUSABLE",
          "This context's bucket configuration could not be used. Reconnect storage.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_UNUSABLE",
        message:
          "This context's bucket configuration could not be used. Reconnect storage.",
      });
    }

    if (args.operation.kind === "googleForwardSync" && forwardSyncJob?.kind === "run") {
      return await runGoogleForwardSync(ctx, store, forwardSyncJob);
    }

    let wroteActivity: { teamVisible: boolean } | null = null;
    let dueNotification: (FormNotifyMaterial & { responseId: string }) | null = null;
    /*
      What this operation does to the file tree, if anything, and — for one
      that can take something away from somebody — who could see it before.
      Read before the operation because afterwards the answer is gone: a note
      made private is, by then, private. See `announceTreeChange`.
    */
    const treeChange = treeChangeOf(args.operation as FileOperation);
    const privacyBefore =
      treeChange?.narrows === true ? await loadPrivacyState(store).catch(() => null) : null;
    const result = await executeOperation(
      store,
      clearanceOf(args.scope, args.grantedNames ?? []),
      args.operation as FileOperation,
      Date.now(),
      projection,
      // A person acting in the console, for the activity file. `client` is
      // null and stays null: the console is their own hand, and "@seyi's
      // Context" would be the product claiming to be a third party.
      args.actorName === undefined || args.actorName === null
        ? null
        : { name: args.actorName, client: null },
      (landed) => {
        wroteActivity = landed;
      },
      (material) => {
        dueNotification = material;
      },
    );

    /*
      TELLING SOMEBODY IS SCHEDULED AFTER THE WRITE, NEVER AWAITED INSIDE IT,
      AND THE REASON IS THE ONE `functions/invitationEmail.ts` GIVES.

      A submission through a collect link comes from a stranger with no
      account. If this resolved a recipient, read a manifest and made an HTTPS
      call before returning, then the time a submission takes would depend on
      whether the form notifies anybody and on whether their address accepted
      the mail — an oracle readable with a stopwatch and no API at all.
      `runAfter(0, …)` is enqueued in a separate transaction whose return value
      the scheduler discards, so there is no channel back and nothing here
      varies with any of it.

      It is also what keeps a notification from ever failing a submission. The
      answer is in the customer's bucket by the time this line runs; mail is a
      derivative of it, and a derivative never rolls back the canonical write —
      hence the `.catch`, which is the same shape the activity stamp above uses
      and for the same reason.
    */
    if (dueNotification !== null) {
      await ctx.scheduler
        .runAfter(0, internal.functions.formNotify.deliver, {
          workspaceId: args.workspaceId,
          ...(dueNotification as FormNotifyMaterial & { responseId: string }),
        })
        .catch(() => {});
    }

    if (treeChange !== null) {
      await announceTreeChange(ctx, store, args.workspaceId, treeChange, result, privacyBefore);
    }

    /*
      Stamped after the operation, once, and never inside it: the store is the
      customer's bucket and this is a row in ours, so a failure here must not
      look like a failed save. `markWorkspaceActivity` is monotonic, so a
      late-landing stamp cannot walk the dot backwards.
    */
    if (wroteActivity !== null) {
      await ctx
        .runMutation(internal.functions.files.markWorkspaceActivity, {
          workspaceId: args.workspaceId,
          at: Date.now(),
          teamVisible: (wroteActivity as { teamVisible: boolean }).teamVisible,
        })
        .catch(() => {});
    }

    /*
     * WHAT A PROJECTION PASS LEARNED, WRITTEN WHERE A PERSON CAN SEE IT.
     *
     * The gateway's copy of this posts to `/gateway/search-index/progress`,
     * because it is on the other side of a network boundary and holds a secret
     * rather than a session. There is no hop to make from inside the control
     * plane, so the internal mutations are called directly — and they are the
     * same two the route calls, so the policy about what may be applied to a
     * row is answered in one place whichever half reports.
     *
     * A failure goes to `recordProvisionResult` rather than to the progress
     * mutation, and that is not a tidy-up: the progress mutation carries two
     * counters and a `ready` flag, and a failed pass's counters are zero
     * because they are only computed when something moved. Reporting them
     * would write "no notes found" onto the row. `failed` is a state the
     * console already renders, with the owner's own "Try again" on it.
     */
    if (result.kind === "indexProjected") {
      if (result.failure !== undefined) {
        await ctx.runMutation(
          internal.functions.fastSearch.recordProvisionResult,
          {
            workspaceId: args.workspaceId,
            status: "failed",
            errorCode: result.failure,
            error: messageFor(result.failure),
          },
        );
        return result;
      }
      if (result.report) {
        await ctx.runMutation(
          internal.functions.fastSearch.recordProjectionProgress,
          {
            workspaceId: args.workspaceId,
            notesIndexed: result.notesIndexed,
            notesPending: result.notesPending,
            ready: result.ready,
          },
        );
      }
      // Same shape, same reasoning and the same place as the maintenance chain
      // below: scheduled from inside the barrier, which propagates no taint,
      // and only by a link that made progress and did not finish.
      const passes = Math.floor(args.operation.kind === "projectIndex"
        ? args.operation.passes ?? 0
        : 0);
      if (result.moved && !result.ready && passes > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "projectIndex", passes: passes - 1 },
        });
      }
      return result;
    }

    // A maintenance pass that got somewhere and is not finished schedules the
    // next one. Here rather than in a job of its own because a second internal
    // action that opens a bucket credential is a second credential barrier,
    // and `CREDENTIAL_BARRIERS` holding one entry with a long warning attached
    // is the point of it — see CLAUDE.md, "Credential barriers are enumerated,
    // never inferred". Scheduling from inside the barrier propagates no taint.
    if (
      args.operation.kind === "maintainIndex" &&
      result.kind === "indexMaintained" &&
      result.changed &&
      !result.complete
    ) {
      const passes = Math.floor(args.operation.passes ?? 0);
      if (passes > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "maintainIndex", passes: passes - 1 },
        });
      }
    }
    if (args.operation.kind === "migrateStorage" && result.kind === "storageMigrated") {
      /*
        WHAT THE BUCKET SAID, WRITTEN DOWN WHERE A QUERY CAN REACH IT.

        The bucket stays authoritative — `migrateStorageLayout` keeps its own
        state under `.context/` and short-circuits on `complete`. This is the
        copy the console reads, and it is recorded on **every** pass rather
        than only at the end, so an owner watching a long migration sees
        `copying` rather than nothing at all.

        Before this, nothing outside the bucket knew the migration had ever
        run. The console's offer to run it was therefore answered by a flag on
        one device, and came back on the next browser and the next phone for a
        bucket already migrated — which is the nag this is here to end.
      */
      await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
        workspaceId: args.workspaceId,
        state: result.state,
      });
      const continuing =
        (args.operation.cleanup && result.state === "cleaning") ||
        (!args.operation.cleanup && result.state === "copying");
      if (continuing) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: "private",
          operation: {
            kind: "migrateStorage",
            cleanup: args.operation.cleanup,
          },
        });
      } else if (!args.operation.cleanup && result.state === "copied") {
        await ctx.scheduler.runAfter(
          STORAGE_LAYOUT_ROLLBACK_MS + 5_000,
          internal.functions.files.runFileOperation,
          {
            workspaceId: args.workspaceId,
            scope: "private",
            operation: { kind: "migrateStorage", cleanup: true },
          },
        );
      }
    }
    if (args.operation.kind === "readStorageLayout" && result.kind === "storageLayoutRead") {
      /*
        THE QUESTION NOBODY WAS ASKING.

        `migrateStorage` records what the bucket said, but only a context that
        ran the migration *after* that recording existed ever had anything
        recorded. Every context migrated before it kept a `complete` in its own
        bucket and an empty column here, and the console reads an empty column
        as "nobody has run this" — so it offered the update again on every
        device, for ever, to the people who had already run it.

        This is the same write from the other direction: ask, and write down
        the answer, without running anything. `observed: false` is not an
        answer — a bucket that would not talk to us teaches us nothing, and
        recording a timestamp for it would claim otherwise and close the offer
        on a context that may genuinely still need it.
      */
      if (result.observed) {
        await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
          workspaceId: args.workspaceId,
          ...(result.state === null ? {} : { state: result.state }),
        });
      }
    }
    return result;
  },
});

/**
 * Refresh the bucket's observed capabilities, then start the resumable copy.
 *
 * Kept internal and reached only through the scheduler: verification decrypts
 * the binding, so its result must never flow back through a public action.
 */
export const runStorageLayoutMigration = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: storageMigrationResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => {
    const verification = await ctx.runAction(
      internal.functions.provisioning.verifyStorageBinding,
      args,
    );
    if (
      !verification.verified ||
      verification.conditionalCreate !== true ||
      verification.conditionalWrite !== true
    ) {
      /*
        A refusal is an answer, and it is the one most worth remembering: a
        bucket that cannot do conflict-safe writes will never run this, so
        offering it again is offering something that cannot happen. Recorded
        here rather than in `runFileOperation` because this arm never reaches
        it — the operation is not attempted at all.
      */
      await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
        workspaceId: args.workspaceId,
        state: "unsupported",
      });
      return {
        kind: "storageMigrated",
        state: "unsupported",
        objectsCopied: 0,
        objectsVerified: 0,
        objectsDeleted: 0,
        conflicts: 0,
        error: "migration requires conflict-safe storage writes",
      };
    }
    return (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "migrateStorage", cleanup: false },
    })) as Extract<OperationResult, { kind: "storageMigrated" }>;
  },
});

/* -------------------------------------------------------------------------- */
/*                    the forward sync pass, one connection                   */
/* -------------------------------------------------------------------------- */

/**
 * Nothing to do, and the claim released.
 *
 * A skipped pass must leave `lastSyncAt` alone — a connection that has never
 * synced and one whose pass was skipped are the same connection, and making
 * the second look synced is precisely the confusion this whole loop exists to
 * remove.
 */
async function releaseForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  reason: string | undefined,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "skipped",
    errorCode: reason,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "skipped",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode: reason,
  };
}

/** A pass that could not run, recorded where the owner can read it. */
async function failForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  errorCode: string,
  error: string,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "failed",
    errorCode,
    error,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "failed",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode,
  };
}

async function runGoogleCalendarForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "calendar" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities?.conditionalWrite !== true) {
    throw new Error("Shared Calendar sync requires storage with conditional writes");
  }
  const calendarStore = store as unknown as Parameters<typeof persistCalendarContribution>[0]["store"];
  const previous = await loadCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
  });
  const now = new Date().toISOString();
  const provider = await syncCalendarAccount({
    connection: {
      workspaceId: "private",
      account: job.address,
      calendarId: "primary",
      timezone: previous?.timezone,
      destinationFolder: job.destinationFolder,
      accessToken,
      syncToken: job.syncToken ?? null,
      lastFullSyncDate: job.lastFullSyncDate ?? null,
      eventCache: previous?.eventCache ?? new Map(),
    },
    store: calendarStore,
    fetchImpl: timeoutFetch,
    now,
    materialize: false,
  });
  if (provider.skipped || !provider.syncToken || !provider.lastFullSyncDate) {
    throw new Error("Google Calendar did not return a resumable cursor");
  }

  await persistCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
    contribution: {
      account: job.address,
      timezone: provider.timezone,
      destinationFolder: job.destinationFolder,
      eventCache: provider.eventCache,
    },
  });
  const contributions = await loadActiveCalendarContributions({
    store: calendarStore,
    sourceIds: job.contributorSourceIds,
  });
  const timezones = new Set(contributions.map((contribution) => contribution.timezone));
  if (timezones.size !== 1) throw new CalendarTimezoneMismatchError();
  const timezone = contributions[0]!.timezone;
  const merged = mergeEventCaches(
    contributions.map((contribution) => contribution.eventCache),
  );
  const nonceSeed = fnv1a64(
    [...job.contributorSourceIds].map(String).sort().join("\0"),
  );

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const date of provider.datesTouched) {
    const events = projectDay(merged, date);
    const path = calendarDayNotePath(
      { date },
      { folder: job.destinationFolder },
    );
    const text = events.length
      ? renderCalendarDay({
          date,
          timezone,
          events,
          nonce: `calendar:${nonceSeed}:${date}`,
          now,
          origin: "calendar-sync",
        })
      : null;
    const written = await writeSharedCalendarDay(store, path, text);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "calendar",
    status: "synced",
    calendarSyncToken: provider.syncToken,
    calendarLastFullSyncDate: provider.lastFullSyncDate,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: provider.syncToken !== job.syncToken,
    gapDetected: false,
    truncated: false,
  };
}

async function runGoogleChatForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "chat" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities === undefined) {
    throw new Error("Google Chat sync requires declared storage capabilities");
  }
  // `FileStore` is the deliberately narrow view used by file operations and
  // omits `StoredObject.arrayBuffer`; every adapter returned by
  // `storeForBinding` implements the full ContextStore contract that the
  // shared communications helpers accept. Keep the cast at this one adapter
  // boundary rather than widening every ordinary file operation.
  const chatStore = store as unknown as Parameters<typeof writeContactDraft>[0];
  const result = await syncGoogleChat({
    listSpaces: ({ pageToken }: { pageToken?: string }) =>
      listSpacesPage({ fetchImpl: timeoutFetch, accessToken, pageToken }),
    listMessages: ({
      spaceName,
      sinceCreateTime,
      pageToken,
    }: {
      spaceName: string;
      sinceCreateTime: string;
      pageToken?: string;
    }) =>
      listMessagesPage({
        fetchImpl: timeoutFetch,
        accessToken,
        spaceName,
        sinceCreateTime,
        pageToken,
      }),
    connection: {
      account: job.address,
      nonceSeed: job.nonceSeed,
      cursors: job.cursors,
      spaceSettings: job.spaceSettings,
      destinationFolder: job.destinationFolder,
    },
  });

  /*
   * Commit this account's provider result before reading the shared view.
   * The manifest-last contribution store means an interrupted pass is never
   * visible as a complete account slice, and loading every active source
   * fails closed if a sibling has not completed its first pass yet.
   */
  await persistChatContribution({
    store: chatStore,
    sourceId: job.connectionId,
    contribution: result.contribution,
  });
  const contributions = await loadActiveChatContributions({
    store: chatStore,
    sourceIds: job.contributorSourceIds,
  });
  /*
    Placed against the bucket after rendering: a Chat day this workspace
    already holds a flat note for keeps it, and only a day never written
    before is filed under its month. `apps/mcp/src/communications/dayPlacement.js`
    holds the argument — a day that is regenerated on every pass and changes
    folders under itself exists twice, under one date.
  */
  const notes = await placeDayParts(
    chatStore,
    renderSharedGoogleChat({
      contributions,
      nonceSeed: job.workspaceNonceSeed,
    }),
  );

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const part of notes) {
    const written = await writeDayPart(chatStore, part);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  for (const draft of result.contactDrafts) {
    const written = await writeContactDraft(chatStore, draft, {
      remainingQuotaBytes: Number.MAX_SAFE_INTEGER - bytesWritten,
    });
    if (written.quotaExceeded) {
      throw new Error("Google Chat Contact exceeded the bounded sync write budget");
    }
    if (written.wrote) bytesWritten += written.bytes;
  }

  /*
   * The cursor is the commit record. It moves last, after the shared daily
   * notes and organic Contacts have all settled, so a failed write makes the
   * next pass ask Google the same question again instead of losing content.
   */
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "chat",
    status: "synced",
    chatCursors: result.cursors,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: JSON.stringify(result.cursors) !== JSON.stringify(job.cursors),
    gapDetected: false,
    truncated: false,
  };
}

/**
 * ONE FORWARD PASS: advance this connection's cursor, write whatever changed.
 *
 * Forward-only, per #388 and `docs/decisions/communications.md`. Three shapes:
 *
 *  - **No cursor yet.** The connection was bound before a baseline could be
 *    read, so one is taken now from `users.getProfile` and stored. Nothing is
 *    fetched: forward-only means the mail from before this moment is not this
 *    loop's to collect.
 *  - **A cursor.** `history.list` from it, rebuild every day a changed message
 *    landed on from Gmail's live state, store the new cursor.
 *  - **An expired cursor.** Gmail's 404 comes back as `gapDetected` rather
 *    than an error. The documented recovery was a reconcile over the backfill
 *    window, which forward-only does not have — so the cursor is re-baselined
 *    and the gap is recorded on the row as a failure a person can read.
 *
 * **The cursor is never advanced past mail that was not written.** A quota
 * ceiling reached mid-pass, or anything thrown, leaves `historyId` exactly
 * where it was, so the next pass asks Gmail the same question again. Advancing
 * it would be the one bug in this file that loses somebody's mail silently.
 */
async function runGoogleForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run" }>,
): Promise<ForwardSyncResult> {
  try {
    /*
     * Inside the try, deliberately. Minting can *throw* as well as answer
     * `null` — a deployment with no Google client id configured, an envelope
     * that will not open — and a throw that escapes this function leaves the
     * scheduler holding the failure and the row holding its claim, so the
     * connection goes quiet for fifteen minutes with nothing on it to say why.
     */
    const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
      connectionId: job.connectionId,
    });
    if (minted === null) {
      // `mintGoogleAccessToken` has already marked the row
      // `reconnect_required` if Google refused the grant outright; this
      // records the pass itself.
      return await failForwardSync(
        ctx,
        job.connectionId,
        "GOOGLE_RECONNECT_REQUIRED",
        "Google needs to be reconnected before this mailbox can sync.",
      );
    }

    if (job.product === "chat") {
      return await runGoogleChatForwardSync(ctx, store, job, minted.accessToken);
    }
    if (job.product === "calendar") {
      return await runGoogleCalendarForwardSync(ctx, store, job, minted.accessToken);
    }

    if (job.historyId === undefined) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        // A cursor, not a sync: this pass read no mail, and the console must
        // be able to say so rather than showing a mailbox that looks current.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: false,
        truncated: false,
      };
    }

    const result = await runIncrementalSync({
      store,
      fetchImpl: timeoutFetch,
      accessToken: minted.accessToken,
      mailboxSlug: job.mailboxSlug,
      address: job.address,
      folders: job.folders,
      startHistoryId: job.historyId,
      folder: job.destinationFolder,
      // The same nonce the backfill used, so a day rewritten by either path
      // keeps its message anchors — see `packages/communications/src/note.js`.
      nonce: `gmail:${job.connectionId}`,
      /*
       * NO `now`, AND THAT IS THE WHOLE POINT OF A LOOP THAT REPEATS.
       *
       * `renderDay` defaults `updated` to the latest message's own `sentAt`
       * precisely so that re-rendering an unchanged day is byte-identical, and
       * `syncOneDay` forwards whatever `now` a caller passes straight through
       * to it. The backfill removed by #388 passed a wall clock, which was
       * survivable for a one-shot import and is not for a pass that runs every
       * few minutes: every touched day would get a new `updated`, a new write,
       * and a new etag, forever — churn wearing the costume of sync activity.
       * Attachment retention is measured against a real wall clock inside
       * `syncOneDay` regardless, so nothing here loses a clock it needed.
       */
      quotaBytes: job.quotaBytes,
      bytesAlreadyUsed: job.bytesAlreadyUsed,
      attachmentMode: job.attachmentMode,
      attachmentRetentionDays: job.attachmentRetentionDays,
    });

    if (result.gapDetected) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        gapDetected: true,
        // Re-baselining reads nothing either, for the same reason.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: true,
        truncated: false,
      };
    }

    if (result.quotaExceeded) {
      // Whatever was written stays written and is counted; the cursor does
      // not move, so the days this pass could not afford are asked for again
      // once the connection has room.
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "MAIL_QUOTA_EXCEEDED",
        error: "This connection reached its storage quota before the pass finished.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: result.truncated === true,
        errorCode: "MAIL_QUOTA_EXCEEDED",
      };
    }

    if (result.truncated === true && result.historyId === undefined) {
      /*
       * PAGED, BUT WITH NO SAFE PLACE TO RESUME.
       *
       * Gmail may return pages that contain no records for the requested
       * `messageAdded` history type while still returning a next page token.
       * If fifty such pages exhaust this pass's bound, there is no history
       * record id to persist. Marking the row as catching up would leave the
       * cursor unchanged and make the next sweep repeat the exact same fifty
       * pages forever. Fail visibly and honor the retry ladder instead.
       */
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
        error: "Google returned more mailbox history but no safe resume point. The next scheduled pass will try again.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: true,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
      };
    }

    /*
     * A WALK THAT RAN OUT OF PAGES IS NOT A FINISHED SYNC.
     *
     * `history.list` hands back the mailbox's *current* head on every page, so
     * a truncated walk that stored it would say "caught up" while holding only
     * the first pages — and everything behind them would be skipped forever,
     * with no gap signalled and the row reading `active`. `runIncrementalSync`
     * reports the truncation and offers the last record it actually walked
     * instead; the cursor moves there, and `catchUp` keeps this connection due
     * so the next pass drains further rather than waiting out its interval.
     */
    const truncated = result.truncated === true;
    await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: job.connectionId,
      status: "synced",
      historyId: result.historyId,
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      catchUp: truncated,
    });
    return {
      kind: "googleForwardSync",
      connectionId: job.connectionId,
      status: "synced",
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      cursorAdvanced: result.historyId !== undefined,
      gapDetected: false,
      truncated,
    };
  } catch (error) {
    // The first account in a multi-account workspace can finish before a
    // sibling has ever stored its contribution. That is an expected warm-up
    // state, not an outage: keep this account's cursor in place, release the
    // claim, and let the sibling's own due pass fill the missing slice.
    if (
      error instanceof ChatContributionIncompleteError ||
      error instanceof CalendarContributionIncompleteError
    ) {
      return await releaseForwardSync(
        ctx,
        job.connectionId,
        job.product === "calendar"
          ? "CALENDAR_WAITING_FOR_ACCOUNT"
          : "CHAT_WAITING_FOR_ACCOUNT",
      );
    }
    const { code, message } = classifyForwardSyncError(error);
    // Structured, and carrying no mail: an identifier, a code, and the name of
    // whatever was thrown.
    console.log(
      JSON.stringify({
        event: "google.forward_sync_failed",
        connectionId: job.connectionId,
        product: job.product,
        errorCode: code,
        errorName: error instanceof Error ? error.name : typeof error,
        gmailStatus: error instanceof GmailApiError ? error.status : undefined,
      }),
    );
    return await failForwardSync(ctx, job.connectionId, code, message);
  }
}

async function runGoogleGmailBackfill(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: Id<"googleSyncRuns">,
): Promise<Extract<OperationResult, { kind: "googleSyncRun" }>> {
  const job = await ctx.runQuery(internal.functions.googleConnect.googleGmailBackfillForRun, {
    workspaceId,
    runId,
  });
  if (job === null) {
    return {
      kind: "googleSyncRun",
      runId,
      status: "complete",
      totalUnits: 0,
      completedUnits: 0,
      itemsFound: 0,
      daysWithMail: 0,
      bytesWritten: 0,
      continue: false,
    };
  }

  await ctx.runMutation(internal.functions.googleConnect.stopGoogleGmailBackfillRun, {
    workspaceId,
    runId,
    errorCode: "GOOGLE_GMAIL_BACKFILL_DISABLED",
    message: "Historical Gmail imports are disabled. This account will sync new mail from its current position.",
  });
  return {
    kind: "googleSyncRun",
    runId,
    status: "failed",
    totalUnits: job.totalUnits,
    completedUnits: job.completedUnits,
    itemsFound: 0,
    daysWithMail: 0,
    bytesWritten: 0,
    continue: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                              the public surface                            */
/* -------------------------------------------------------------------------- */

/**
 * Recent durable folder moves, owner-only and deliberately path-free.
 *
 * A move can name a private folder. Settings needs its state and measured
 * counts, never the source, destination, marker id, provider error, grant, or
 * acting client. Completed rows stay visible briefly so 99% does not turn
 * directly into an empty card before the owner sees the outcome.
 */
export const listDurableMoves = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(durableMoveValidator),
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const rows = await ctx.db
      .query("gatewayJobs")
      .withIndex("by_workspace_updatedAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const completedCutoff = Date.now() - 24 * 60 * 60 * 1_000;
    return rows
      .filter((row) => row.status !== "complete" || row.updatedAt >= completedCutoff)
      .slice(0, 10)
      .map((row) => ({
        jobId: row._id,
        status: row.status,
        ...(row.progressPhase === undefined ? {} : { phase: row.progressPhase }),
        ...(row.progressCompleted === undefined ? {} : { completed: row.progressCompleted }),
        ...(row.progressTotal === undefined ? {} : { total: row.progressTotal }),
        updatedAt: row.updatedAt,
      }));
  },
});

/** One folder's contents. Any member may read. */
export const listFiles = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: listingValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "listing" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "list", path: args.path },
    });
    return result as Extract<OperationResult, { kind: "listing" }>;
  },
});

/**
 * Structured Obsidian plugin compatibility for the first-party console.
 *
 * Owner-only because `.obsidian/` is outside the privacy manifest: a member
 * may read the notes their scope permits, but that says nothing about whether
 * they may inventory another person's installed software or its settings.
 * The credential barrier returns only manifest metadata and scan findings;
 * bundle text and `data.json` never leave it.
 */
export const listObsidianPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginInventoryValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Extract<OperationResult, { kind: "pluginInventory" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "pluginInventory" },
    });
    return result as Extract<OperationResult, { kind: "pluginInventory" }>;
  },
});

/**
 * What Context has installed in this bucket, cheap enough to ask on arrival.
 *
 * Owner-only, like `listObsidianPlugins` beside it and for the same reason:
 * what software a context runs is the owner's to know.
 *
 * The console calls this when the plugins pane opens, and it is the only plugin
 * read that does not wait for a press. It reads one pointer per install, opens
 * no bundle and writes nothing — `listManagedInstalls` carries the argument for
 * why that is a different cost from a scan, and what the missing answer cost.
 */
export const listManagedPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginManagedInstallsValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Extract<OperationResult, { kind: "pluginManagedInstalls" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "pluginManagedList" },
    });
    return result as Extract<OperationResult, { kind: "pluginManagedInstalls" }>;
  },
});

/** One note's markdown. Any member may read what their scope can see. */
export const readNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: fileValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "file" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      /*
        A link into the console outlives the path it names. Somebody pastes
        `?note=2-areas/apps/x.md` into a thread, the folder is renamed to
        `5-areas`, and the address in the thread is the only copy of it left —
        no rewrite reaches a chat message. `onMiss` follows the bucket's
        forwarding ledger once the live path has already missed, so a note
        that exists where it says wins, and only a dead address is forwarded.
      */
      operation: { kind: "read", path: args.path, forward: "onMiss" },
    });
    return result as Extract<OperationResult, { kind: "file" }>;
  },
});

/**
 * One page of everything this caller may see in a context, with versions —
 * what the offline mirror is built and reconciled from. Any member may call
 * it, and gets exactly what `listFiles` and `readNote` would show them: the
 * same clearance, through the same `canSee`. No note is read to produce it.
 *
 * Pass `cursor` back to continue; `cursor: null` means the walk is done, and
 * `truncated: true` means it could not finish, so a path missing from the
 * pages is not evidence the note was deleted. See `syncManifest` in
 * `lib/fileOps.ts`, and "The offline mirror is fed by a privacy-filtered
 * manifest" in `docs/decisions/app-and-console.md`.
 */
export const syncManifest = action({
  args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.string()) },
  returns: manifestValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "manifest" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "manifest",
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      },
    });
    return result as Extract<OperationResult, { kind: "manifest" }>;
  },
});

/**
 * Several notes' markdown at once, for the offline mirror to fill itself. Any
 * member may read what their scope can see — per path, exactly as `readNote`
 * decides it, and a refused path does not fail the batch.
 *
 * At most `READ_BATCH_PATHS` paths; past `READ_BATCH_BYTES` of note text the
 * remaining paths come back `deferred`, to be asked for again.
 */
export const readNotes = action({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: notesValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "notes" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    // Refused before the barrier rather than inside it, so a request that can
    // never succeed does not open the bucket's credential to find that out.
    // `readFiles` refuses it again, for any other caller.
    if (args.paths.length > READ_BATCH_PATHS) {
      throw toConvexError(
        new FileOpError("BATCH_TOO_LARGE", `Read at most ${READ_BATCH_PATHS} notes at a time.`),
      );
    }
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "readMany", paths: args.paths },
    });
    return result as Extract<OperationResult, { kind: "notes" }>;
  },
});

/**
 * Search this context's notes. Any member may search what their scope can see.
 *
 * The console's palette used to filter the folders somebody had happened to
 * expand, and said so — "only folders you have opened are searched". That is
 * a file picker, not search: the answer to "where did I write about Ikenna"
 * lived in a folder the person had not opened, which is exactly the case
 * search exists for. This asks the bucket, through the same index and the
 * same code an AI client's `search_notes` answers from.
 */
export const searchContext = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    prefix: v.optional(v.string()),
  },
  returns: searchResultsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "searchResults" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "search", query: args.query, prefix: args.prefix },
    })) as Extract<OperationResult, { kind: "searchResults" }>;

    // The index this answer read is the index some earlier pass built, and a
    // search does no maintenance of its own — that is what took a console
    // search over a real workspace from twenty-odd seconds to a fraction of one.
    // So the answer's own report of how far behind the index is decides
    // whether a pass runs behind it.
    //
    // **Scheduled, never called.** `ctx.runAction` would put a full listing of
    // the customer's bucket back in front of the person waiting, which is the
    // whole defect; `ctx.scheduler.runAfter` enqueues a job in a separate
    // transaction whose return value is discarded, so this action returns as
    // soon as it has an answer (CLAUDE.md, "Scheduling is not calling"). The
    // target is a statically resolvable `internal.` reference, as that rule
    // requires.
    //
    // Nothing is scheduled for a converged index. A pass per search over a
    // bucket with no work in it is a full listing per search, billed to the
    // customer, to discover there was nothing to do.
    if (result.indexMissing || result.indexIncomplete) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope,
        grantedNames,
        operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
      });
    }
    return result;
  },
});

/**
 * Every folder this member's scope may see, for a destination picker.
 *
 * `member` and above, which is the read this already is — and deliberately
 * NOT gated on being able to write here. The picker offers a context only
 * where the mover is at least an `editor`, and that decision belongs where the
 * list of contexts is, not to a folder listing: an action that refused a
 * reader would also refuse every other honest use of "what folders are in
 * @work", starting with the next one.
 *
 * Its own action rather than a shape of `listFiles`, because the walk is the
 * point: one call, one credential, the whole tree. See `listFolderPaths`.
 */
export const folderPaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: folderPathsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "folderPaths" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "folderPaths" },
    });
    return result as Extract<OperationResult, { kind: "folderPaths" }>;
  },
});

/**
 * Every note path this member's scope may see, for the editor's link
 * resolution — `[[name]]` following and the `[[` completion.
 *
 * **Read-only, and deliberately schedules nothing.** `searchContext` chains
 * `maintainIndex` behind a miss because somebody is watching a spinner for an
 * answer about a word they typed; nobody is watching this one, and a context
 * that has never been searched simply resolves fewer links until an ordinary
 * search — or `maintainIndex`'s own hourly reach — catches the index up. See
 * `docs/decisions/app-and-console.md`, "L1".
 */
export const notePaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: notePathsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "notePaths" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "notePaths" },
    });
    return result as Extract<OperationResult, { kind: "notePaths" }>;
  },
});

/**
 * One search across several contexts, blended into one list.
 *
 * ## Why the fan-out is here
 *
 * Because the per-context search already is. This action resolves a scope,
 * calls `runFileOperation`'s `search` once per context, and blends the answers
 * — and every part it does not do is the point: it does not open a bucket, does
 * not know what a projection is, does not rank, does not cut a snippet, and
 * **does not contain a privacy filter.** `searchNotes` owns all of that, once,
 * for the console and for `search_notes` alike, exactly as
 * `docs/decisions/search.md` requires. A blended search that re-derived who may
 * see a hit would be a third copy of `canSee` and the one most likely to be
 * wrong, because it is the one nobody would think to test per tier.
 *
 * The gateway was the alternative home and it is the wrong one twice: a Worker
 * has a fifty-subrequest ceiling per invocation, which a fan-out over eight
 * customers' buckets walks into by itself, and the console would need a request
 * per context per page — which is the "the client makes one request per page"
 * property this exists to give it.
 *
 * ## Every page re-checks everything
 *
 * Membership, role and fast-search state are re-read on every page of every
 * query: `searchableContextsFor` is a live read, `authorizeFileAccess` runs per
 * context per page, and the scope the caller asked for can only narrow that.
 * So somebody removed from a workspace between page one and page two gets page
 * two without it — no cached scope, no cursor-carried permission. The cursor
 * carries offsets and nothing else, and `decodeCursor` says at length why.
 *
 * ## What it deliberately does not do
 *
 * **It schedules index maintenance for one case only: a context with no index
 * at all.** `searchContext` schedules a pass behind any lagging index, because
 * a person searching one context is the cheapest possible trigger for catching
 * that context up. Multiplying that by the width of a scope would put a full
 * bucket listing per context behind every keystroke on this page, billed to
 * every one of those customers, so a merely *incomplete* index is left to the
 * passes that already ride the gateway's own searches.
 *
 * A **missing** one is different in kind and is the state this page created for
 * itself the moment it started searching contexts without a projection: a
 * context nobody has ever searched directly has no shard index, answers every
 * query with `indexMissing`, and would report "still being indexed" on this
 * page forever — a permanent apology that no amount of waiting resolves. So the
 * first page of a search schedules one chain per such context and no more:
 * later pages of the same query schedule nothing, and the condition is
 * self-limiting, because a context that has been indexed once is never
 * `indexMissing` again.
 *
 * **It logs no query text.** Nothing in this function writes the words
 * somebody typed anywhere: not to audit, not to a structured log, not into the
 * cursor. `docs/decisions/search.md` records that as a decision rather than an
 * omission — a search over several people's contexts is a much better guess at
 * what somebody is working on than any single note read.
 */
export const searchContexts = action({
  args: {
    query: v.string(),
    /**
     * The scope, as workspace ids. Absent or empty means every context this
     * caller can search. An id this caller may not search is **dropped**, identically to
     * one that never existed — see `resolveScope`.
     */
    contexts: v.optional(v.array(v.id("workspaces"))),
    /** A cursor from a previous page of this same query, or nothing. */
    cursor: v.optional(v.string()),
  },
  returns: blendedResultsValidator,
  handler: async (ctx, args): Promise<BlendedAnswer> => {
    const actorUserId = await callerId(ctx);
    const searchable = await ctx.runQuery(
      internal.functions.fastSearch.searchableContextsFor,
      { actorUserId },
    );

    const query = args.query.trim();
    const scope = resolveScope(searchable, args.contexts);
    if (query === "" || scope.length === 0) {
      // An empty query and an empty scope are both "nothing was asked", and
      // both answer with an empty page rather than an error. `searchableCount`
      // is what lets the page tell the two apart on screen.
      return {
        results: [],
        matchCount: 0,
        matchCountIsFloor: false,
        cursor: null,
        sources: [],
        searchableCount: searchable.length,
      };
    }

    const fingerprint = queryFingerprint(query);
    const read = decodeCursor(args.cursor, fingerprint);
    const offsets = read.kind === "page" ? read.offsets : {};

    /*
      ONE DEADLINE PER SOURCE, AND A SLOW CONTEXT COSTS ONLY ITSELF.

      `Promise.all` over a list where each entry has already been wrapped, so
      the whole page is bounded by the slowest source that answers *in time*
      rather than by the slowest source. A bucket that has stopped answering
      would otherwise hold every other context's results behind it, which is
      the failure mode a blended list makes worse rather than better: one
      unreachable context and the page has nothing on it.
    */
    const answered = await Promise.all(
      scope.map(async (context) => {
        const offset = offsets[context.workspaceId] ?? 0;
        const asked = depthFor(offset);
        const settled = await withDeadline(
          (async () => {
            // The one authorization function, per context, per page. The
            // searchable list already established membership; this re-establishes
            // it through the same query every other file action uses, so a
            // blended search cannot come to disagree with a single one about
            // what role means what scope.
            const { scope: tier } = await ctx.runQuery(
              internal.functions.files.authorizeFileAccess,
              {
                actorUserId,
                workspaceId: context.workspaceId as Id<"workspaces">,
                minimum: "member" as const,
              },
            );
            const answer = (await ctx.runAction(
              internal.functions.files.runFileOperation,
              {
                workspaceId: context.workspaceId as Id<"workspaces">,
                scope: tier,
                operation: {
                  kind: "search" as const,
                  query,
                  limit: asked,
                  // See `searchNotes`: a fan-out misses in most of its contexts
                  // by construction, and one listing per miss is the cost of a
                  // rule written for a single spinner.
                  refreshOnMiss: false,
                },
              },
            )) as Extract<OperationResult, { kind: "searchResults" }>;
            // The tier rides back out with the answer so the maintenance pass
            // below can be scheduled with the scope this search was authorized
            // at, rather than re-deriving one outside the race — where a second
            // `authorizeFileAccess` would be a second answer to the same
            // question.
            return { answer, tier };
          })(),
          SOURCE_DEADLINE_MS,
        );
        return {
          context,
          offset,
          asked,
          settled: settled === null ? null : settled.answer,
          tier: settled === null ? null : settled.tier,
        };
      }),
    );

    const sources: BlendSource[] = [];
    const rows: BlendedAnswer["sources"] = [];
    let matchCount = 0;
    let matchCountIsFloor = false;
    for (const { context, offset, asked, settled } of answered) {
      if (settled === null) {
        // A refusal, a timeout and a thrown storage error are one state on
        // screen, and deliberately: what a person can do about each is press
        // retry on that row. The reason is not carried because it would be a
        // provider's sentence about somebody else's bucket.
        //
        // **And the blended total stops claiming to be exact.** A source that
        // was never read is a walk cut short, which is the condition under
        // which every other count in this system reports itself as a floor —
        // `search/CONTRACT.md`'s rule, and the census's own language. Summing
        // the sources that answered and calling the result a total would be a
        // confident number over a scope only half searched, and the one place
        // that understatement matters most is the page whose whole promise is
        // "everything you can reach".
        matchCountIsFloor = true;
        rows.push({
          workspaceId: context.workspaceId as Id<"workspaces">,
          slug: context.slug,
          displayName: context.displayName,
          state: "failed",
          matchCount: 0,
          matchCountIsFloor: false,
        });
        continue;
      }
      sources.push({
        key: context.workspaceId,
        hits: settled.hits,
        offset,
        asked,
      });
      matchCount += settled.matchCount;
      matchCountIsFloor = matchCountIsFloor || settled.matchCountIsFloor;
      rows.push({
        workspaceId: context.workspaceId as Id<"workspaces">,
        slug: context.slug,
        displayName: context.displayName,
        // An index that has not caught up is not "no matches here", and a
        // blended list is where that lie is easiest to tell: nine contexts
        // answer, the tenth is still indexing, and its silence reads as an
        // answer about somebody's notes.
        state: settled.indexMissing || settled.indexIncomplete ? "indexing" : "ok",
        matchCount: settled.matchCount,
        matchCountIsFloor: settled.matchCountIsFloor,
      });
    }

    /*
      The one pass this page schedules — see "what it deliberately does not do".

      A context with no shard index at all answers every query with
      `indexMissing` and would say "still being indexed" on this page for as
      long as nobody searched it from somewhere else. One chain per such
      context, on the first page of a query only, and never for an index that
      merely lags: that one catches up behind the searches the gateway and the
      palette already ride.

      **Scheduled, never called** (CLAUDE.md, "Scheduling is not calling"). A
      `runAction` here would put a full listing of somebody's bucket in front of
      the person waiting for this page, which is the defect the whole
      no-maintenance rule exists to avoid.
    */
    if (args.cursor === undefined) {
      for (const { context, settled, tier } of answered) {
        if (settled === null || tier === null || !settled.indexMissing) continue;
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: context.workspaceId as Id<"workspaces">,
          scope: tier,
          operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
        });
      }
    }

    const page = pageOf(fuse(sources), sources);
    const named = new Map(scope.map((context) => [context.workspaceId, context]));
    return {
      results: page.rows.map((row) => {
        const context = named.get(row.key)!;
        return {
          workspaceId: context.workspaceId as Id<"workspaces">,
          slug: context.slug,
          displayName: context.displayName,
          path: row.path,
          title: row.title,
          snippet: row.snippet,
        };
      }),
      matchCount,
      matchCountIsFloor,
      cursor: page.next === null ? null : encodeCursor(fingerprint, page.next),
      sources: rows,
      searchableCount: searchable.length,
    };
  },
});

/**
 * Save a note. Requires `editor`.
 *
 * `expectedEtag` is what the editor read. Omit it only to create a new file —
 * omitting it for an existing path is a conflict, not an overwrite. There is
 * no "force" flag; the console reloads and lets the person merge.
 */
export const writeNote = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "written" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      actorName,
      operation: {
        kind: "write",
        path: args.path,
        text: args.text,
        expectedEtag: args.expectedEtag,
      },
    })) as Extract<OperationResult, { kind: "written" }>;

    // Paths and an outcome. Never the text — the schema's flat-scalar `details`
    // makes an accidental `{ body }` impossible, and this is the deliberate
    // half of that rule.
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: args.expectedEtag === undefined ? "file.create" : "file.write",
      paths: [result.path],
      details: { conflictCheck: result.conflictCheck },
    });
    return result;
  },
});

/**
 * Start or resume the metadata half of a local vault import.
 *
 * File bytes remain on the person's device. The row remembers only counts and
 * completed batch numbers, so a closed tab can reselect the same vault and
 * avoid sending batches that already finished.
 */
/* -------------------------------------------------------------------------- */
/*                    a pasted image, in and back out again                    */
/* -------------------------------------------------------------------------- */

/** Sixteen hex characters of SHA-256, which is what names the object. */
async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Store an image somebody pasted into a note.
 *
 * **Editor or owner**, because this writes to the bucket; `member` is read
 * access and a paste is not a read. Nothing about the note is consulted: the
 * caller may already write every note in this context, so gating the *image* on
 * one particular note would be a check that refuses nothing and implies a
 * guarantee this does not make.
 *
 * The name is ours to choose and not the caller's, which is the security half:
 * a client-supplied leaf is a path to argue about, and this one is derived from
 * the bytes. `writeImage` still applies the gateway's own leaf rule to whatever
 * comes out, so a careless change to the derivation is refused rather than
 * writing a key `read_image` could never name.
 */
export const storeNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(
      internal.functions.files.authorizeFileAccess,
      { actorUserId, workspaceId: args.workspaceId, minimum: "editor" },
    );
    const leaf = pasteImageLeaf({
      hash: await contentHash(args.bytes),
      contentType: args.contentType,
    });
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "writeImage",
        leaf,
        bytes: args.bytes,
        contentType: args.contentType,
      },
    });
    return { leaf };
  },
});

/**
 * Read a pasted image back, for a note that references it.
 *
 * **The reference is the gate, and it is the gateway's own.** An image has no
 * visibility of its own — it borrows the visibility of the notes that point at
 * it — so the question this asks is the question `read_image` asks: is there a
 * note *this caller can see* that names this file? The note is read through the
 * same `read` operation the editor uses, so `canSee` and `privacy.md` answer
 * exactly once, in the place they already answer for note text.
 *
 * A caller who can see no such note gets `FILE_NOT_FOUND` — the same error as
 * for an image that was never written, so this cannot be used to learn that one
 * exists. A `member` therefore cannot pull an image out of a private note by
 * naming its leaf, which is the isolation case worth a test rather than a
 * comment.
 *
 * Deliberately broad about what "references" means: any mention of the leaf
 * anywhere in the note. These notes are edited in Obsidian, in rclone and by
 * hand, and the failure mode of a strict rule ("must be a markdown embed") is an
 * image that silently stops loading in the app after somebody reformatted a
 * line.
 */
export const readNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    notePath: v.string(),
    leaf: v.string(),
  },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(
      internal.functions.files.authorizeFileAccess,
      { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
    );
    const note = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "read", path: args.notePath },
    })) as Extract<OperationResult, { kind: "file" }>;
    if (!note.text.includes(args.leaf)) {
      throw new ConvexError({
        code: "FILE_NOT_FOUND",
        message: "No note you can see references that image.",
      });
    }
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "readImage", leaf: args.leaf },
    })) as Extract<OperationResult, { kind: "image" }>;
    /*
      The type comes from the extension rather than from the store, because an
      adapter is not obliged to hand one back and a picture served as
      `application/octet-stream` is a download rather than an image. The leaf has
      already been through `readImage`'s own gate by this point, so the extension
      here is one of the set.
    */
    const extension = args.leaf.slice(args.leaf.lastIndexOf(".") + 1).toLowerCase();
    return {
      bytes: result.bytes,
      contentType: extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*                      a workspace's icon, in and back out                    */
/* -------------------------------------------------------------------------- */

/**
 * Store the photo a workspace draws in its mark.
 *
 * **Owner**, not editor. `storeNoteImage` takes an editor because a paste is a
 * write to the bucket and an editor may write to the bucket. This is a write to
 * the bucket *and* a change to what the workspace looks like on every member's
 * screen, so it takes the role that owns the other facts about the workspace —
 * its name, its storage, its members. The stricter of the two checks wins.
 *
 * The name is ours and derived from the bytes, for the reason `storeNoteImage`
 * gives: a client-supplied leaf is a path to argue about. `writeImage` then
 * applies the gateway's own leaf rule to whatever `workspaceIconLeaf` produced,
 * so a careless change to the derivation is refused here rather than writing an
 * object no reader can ever name.
 *
 * ## The cap is this feature's, and it is much smaller than the store's
 *
 * `writeImage` allows five megabytes, which is right for a picture somebody
 * wants to look at and wrong for an 18pt square the console draws once per
 * workspace per paint. `WORKSPACE_ICON_MAX_BYTES` is checked here, before the
 * bytes reach the bucket, so a caller that is not our picker cannot make every
 * future context list a download. The picker crops square and compresses long
 * before this, and this is the backstop for everything that is not the picker.
 *
 * The row is patched only after the write lands, by
 * `recordWorkspaceIconPhoto` — so a failed upload leaves the old icon standing
 * rather than pointing the workspace at an object that is not there.
 */
export const setWorkspaceIconPhoto = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(
      internal.functions.files.authorizeFileAccess,
      { actorUserId, workspaceId: args.workspaceId, minimum: "owner" },
    );
    /*
      The type is checked before the hash is taken rather than left to
      `workspaceIconLeaf`, so the refusal names the actual problem. The two
      agree because they read the same map out of `@context/shared`.
    */
    if (!WORKSPACE_ICON_CONTENT_TYPES.has(args.contentType)) {
      throw new ConvexError({
        code: "WORKSPACE_ICON_TYPE",
        message: "A workspace icon must be a PNG, JPEG or WebP.",
      });
    }
    if (args.bytes.byteLength > WORKSPACE_ICON_MAX_BYTES) {
      throw new ConvexError({
        code: "WORKSPACE_ICON_TOO_LARGE",
        message: `A workspace icon must be at most ${WORKSPACE_ICON_MAX_BYTES} bytes.`,
      });
    }
    const leaf = workspaceIconLeaf({
      hash: await contentHash(args.bytes),
      contentType: args.contentType,
    });
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "writeImage",
        leaf,
        bytes: args.bytes,
        contentType: args.contentType,
      },
    });
    await ctx.runMutation(internal.functions.workspaces.recordWorkspaceIconPhoto, {
      workspaceId: args.workspaceId,
      actorUserId,
      leaf,
    });
    return { leaf };
  },
});

/**
 * Read a workspace's icon photo back.
 *
 * **Note what this does not take: a leaf.** `readNoteImage` takes one and gates
 * it on a note the caller can see that references it, because an image in the
 * opaque store borrows its visibility from the notes pointing at it. An icon
 * has no note, and the wrong way to serve one is to loosen that gate.
 *
 * So the caller names a *workspace* and the leaf is read off the row by
 * `workspaceIconLeaf`, which is an internal query with its own membership
 * check. There is no argument here through which an object can be named, which
 * makes this strictly narrower than the note path rather than wider: the set of
 * objects it can return is at most one per workspace, chosen by that
 * workspace's owner. A test asserts the argument shape, because "there is no
 * leaf argument" is the property doing the work and a later convenience
 * parameter would quietly end it.
 *
 * `member` is the floor and it is honest: this picture is drawn in the rail of
 * everyone who can reach the workspace. A non-member gets the same
 * `WORKSPACE_NOT_FOUND` as for an id that never existed, so this cannot be used
 * to learn that a workspace exists.
 *
 * A workspace with no icon, or with an emoji, gets `FILE_NOT_FOUND` — the same
 * absence as a photo that was never written, which is what the console draws a
 * letter for anyway.
 */
export const workspaceIconPhoto = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(
      internal.functions.files.authorizeFileAccess,
      { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
    );
    const leaf = await ctx.runQuery(internal.functions.workspaces.workspaceIconLeaf, {
      workspaceId: args.workspaceId,
      actorUserId,
    });
    if (leaf === null) {
      throw new ConvexError({
        code: "FILE_NOT_FOUND",
        message: "That workspace has no icon photo.",
      });
    }
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "readImage", leaf },
    })) as Extract<OperationResult, { kind: "image" }>;
    /*
      From the extension, for the reason `readNoteImage` gives: an adapter is
      not obliged to hand a type back, and a picture served as
      `application/octet-stream` is a download rather than an image. The leaf
      came off our own row and through `readImage`'s gate, so the extension here
      is one of the three.
    */
    const extension = leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase();
    return {
      bytes: result.bytes,
      contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
    };
  },
});

export const startVaultImport = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
    confirmation: v.optional(v.string()),
    sourceFingerprint: v.string(),
    totalFiles: v.number(),
    totalBytes: v.number(),
    totalBatches: v.number(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    validateVaultImportPlan(args);
    if (
      args.strategy === "replace" &&
      !matchesDestructiveActionAcknowledgement(args.confirmation)
    ) {
      throw new ConvexError({
        code: "IMPORT_REPLACE_CONFIRMATION_REQUIRED",
        message: "Type “I understand” before replacing this bucket.",
      });
    }
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const recent = await ctx.db
      .query("vaultImportJobs")
      .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const matching = recent.find(
      (job) =>
        job.actorUserId === actorUserId &&
        job.status !== "complete" &&
        job.strategy === args.strategy &&
        job.sourceFingerprint === args.sourceFingerprint &&
        job.totalFiles === args.totalFiles &&
        job.totalBytes === args.totalBytes &&
        job.totalBatches === args.totalBatches,
    );
    const now = Date.now();
    if (matching !== undefined) {
      if (matching.status !== "active") {
        await ctx.db.patch(matching._id, { status: "active", updatedAt: now });
      }
      return vaultImportJobStatus({ ...matching, status: "active", updatedAt: now });
    }
    for (const job of recent) {
      if (job.actorUserId === actorUserId && job.status === "active") {
        await ctx.db.patch(job._id, { status: "paused", updatedAt: now });
      }
    }
    const jobId = await ctx.db.insert("vaultImportJobs", {
      workspaceId: args.workspaceId,
      actorUserId,
      strategy: args.strategy,
      sourceFingerprint: args.sourceFingerprint,
      totalFiles: args.totalFiles,
      totalBytes: args.totalBytes,
      totalBatches: args.totalBatches,
      completedBatches: [],
      completedFiles: 0,
      createdFiles: 0,
      skippedFiles: 0,
      ...(args.strategy === "replace" ? {
        replacement: {
          phase: "counting" as const,
          totalObjects: 0,
          deletedObjects: 0,
        },
      } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(jobId);
    if (created === null) throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "The import could not start." });
    return vaultImportJobStatus(created);
  },
});

export const recordVaultClearBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    mode: v.union(v.literal("counted"), v.literal("deleted")),
    objects: v.number(),
    complete: v.boolean(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== args.actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint ||
      job.strategy !== "replace" ||
      job.replacement === undefined ||
      !Number.isSafeInteger(args.objects) ||
      args.objects < 0
    ) return null;

    const now = Date.now();
    if (job.replacement.phase === "counting" && args.mode === "counted") {
      const replacement = {
        phase: args.objects === 0 ? "uploading" as const : "deleting" as const,
        totalObjects: args.objects,
        deletedObjects: 0,
      };
      await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
      return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
    }
    if (job.replacement.phase === "deleting" && args.mode === "deleted") {
      const rawDeleted = job.replacement.deletedObjects + args.objects;
      const totalObjects = Math.max(job.replacement.totalObjects, rawDeleted);
      const replacement = {
        phase: args.complete ? "uploading" as const : "deleting" as const,
        totalObjects,
        deletedObjects: args.complete ? totalObjects : rawDeleted,
      };
      await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
      return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
    }
    return vaultImportJobStatus(job);
  },
});

/** Count, then remove, one retryable page of every object in a replacement bucket. */
export const clearVaultImportBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, {
      jobId: args.jobId,
    }) as Doc<"vaultImportJobs"> | null;
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint ||
      job.strategy !== "replace" ||
      job.replacement === undefined
    ) {
      throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That replacement is no longer available." });
    }
    if (job.replacement.phase === "uploading") return vaultImportJobStatus(job);

    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "clearVault", countOnly: job.replacement.phase === "counting" },
    }) as Extract<OperationResult, { kind: "vaultCleared" }>;
    const recorded = await ctx.runMutation(internal.functions.files.recordVaultClearBatch, {
      jobId: args.jobId,
      actorUserId,
      workspaceId: args.workspaceId,
      sourceFingerprint: args.sourceFingerprint,
      mode: result.mode,
      objects: result.objects,
      complete: result.complete,
    });
    if (recorded === null) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (result.mode === "deleted" && result.objects > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.replace.clear",
        paths: [],
        details: { objectsDeleted: result.objects },
      });
    }
    return recorded;
  },
});

/** The latest unfinished import for this owner and workspace, without paths or content. */
export const latestVaultImportJob = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const recent = await ctx.db
      .query("vaultImportJobs")
      .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const job = recent.find((candidate) => candidate.actorUserId === actorUserId && candidate.status !== "complete");
    return job === undefined ? null : vaultImportJobStatus(job);
  },
});

/** Record the local uploader stopping while keeping every completed batch resumable. */
export const pauseVaultImport = mutation({
  args: { workspaceId: v.id("workspaces"), jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) return null;
    if (job.status === "active") await ctx.db.patch(job._id, { status: "paused", updatedAt: Date.now() });
    return vaultImportJobStatus(job.status === "active" ? { ...job, status: "paused" } : job);
  },
});

export const vaultImportJobForBatch = internalQuery({
  args: { jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, args): Promise<Doc<"vaultImportJobs"> | null> => await ctx.db.get(args.jobId),
});

export const recordVaultImportBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    filesProcessed: v.number(),
    filesCreated: v.number(),
    filesSkipped: v.number(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== args.actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint
    ) return null;
    if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
    const completedBatches = [...job.completedBatches, args.batchIndex].sort((left, right) => left - right);
    const completedFiles = job.completedFiles + args.filesProcessed;
    if (
      !Number.isSafeInteger(args.batchIndex) ||
      args.batchIndex < 0 ||
      args.batchIndex >= job.totalBatches ||
      !Number.isSafeInteger(args.filesProcessed) ||
      args.filesProcessed < 1 ||
      args.filesCreated < 0 ||
      args.filesSkipped < 0 ||
      args.filesCreated + args.filesSkipped !== args.filesProcessed ||
      completedFiles > job.totalFiles
    ) return null;
    const complete = completedBatches.length === job.totalBatches && completedFiles === job.totalFiles;
    const now = Date.now();
    const patch = {
      completedBatches,
      completedFiles,
      createdFiles: job.createdFiles + args.filesCreated,
      skippedFiles: job.skippedFiles + args.filesSkipped,
      status: complete ? "complete" as const : "active" as const,
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    };
    await ctx.db.patch(job._id, patch);
    return vaultImportJobStatus({ ...job, ...patch });
  },
});

/**
 * Upload one numbered batch and atomically mark its progress after the bucket
 * accepts it. Repeating the same number returns the stored result and never
 * sends those bytes to storage twice.
 */
export const importVaultJobBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
      });
    }
    const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
      throw new ConvexError({ code: "IMPORT_BATCH_INVALID", message: "That upload batch is too large." });
    }
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, { jobId: args.jobId }) as Doc<"vaultImportJobs"> | null;
    if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) {
      throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That import is no longer available." });
    }
    if (
      job.sourceFingerprint !== args.sourceFingerprint ||
      !Number.isSafeInteger(args.batchIndex) ||
      args.batchIndex < 0 ||
      args.batchIndex >= job.totalBatches
    ) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (job.strategy === "replace" && job.replacement?.phase !== "uploading") {
      throw new ConvexError({
        code: "IMPORT_REPLACE_NOT_READY",
        message: "The existing bucket must finish clearing before files upload.",
      });
    }
    if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
    const completedFilesAfterBatch = job.completedFiles + args.files.length;
    const completedBatchCountAfterBatch = job.completedBatches.length + 1;
    if (
      completedFilesAfterBatch > job.totalFiles ||
      (completedBatchCountAfterBatch === job.totalBatches && completedFilesAfterBatch !== job.totalFiles) ||
      (completedBatchCountAfterBatch < job.totalBatches && completedFilesAfterBatch >= job.totalFiles)
    ) {
      throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "Choose the vault again to restart this import." });
    }

    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "importVault", files: args.files },
    })) as Extract<OperationResult, { kind: "vaultImported" }>;
    if (
      job.strategy === "replace" &&
      job.completedBatches.length + 1 === job.totalBatches &&
      job.completedFiles + args.files.length === job.totalFiles
    ) {
      // Idempotent so a retry after storage succeeded but progress recording
      // failed still restores the private access map before completing.
      await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope,
        grantedNames,
        operation: { kind: "ensurePrivacy" },
      });
    }
    const recorded = await ctx.runMutation(internal.functions.files.recordVaultImportBatch, {
      jobId: args.jobId,
      actorUserId,
      workspaceId: args.workspaceId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: args.batchIndex,
      filesProcessed: args.files.length,
      filesCreated: result.created.length,
      filesSkipped: result.skipped.length,
    });
    if (recorded === null) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (result.created.length > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.import",
        paths: result.created,
        details: {
          filesCreated: result.created.length,
          filesSkipped: result.skipped.length,
          bytesCreated: result.bytesCreated,
          batchIndex: args.batchIndex,
        },
      });
    }
    return recorded;
  },
});

/**
 * Upload one retryable batch from a locally selected Obsidian vault.
 *
 * Owner-only because a vault import can create non-Markdown attachments and a
 * large path tree. Bytes cross this action directly into the workspace bucket;
 * the control plane stores only the ordinary audit metadata below.
 */
export const importVaultBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "vaultImported" }>> => {
    if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
      });
    }
    const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: "That upload batch is too large. Choose the vault again to retry in smaller pieces.",
      });
    }

    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "importVault", files: args.files },
    })) as Extract<OperationResult, { kind: "vaultImported" }>;

    if (result.created.length > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.import",
        paths: result.created,
        details: {
          filesCreated: result.created.length,
          filesSkipped: result.skipped.length,
          bytesCreated: result.bytesCreated,
        },
      });
    }
    return result;
  },
});

/**
 * Remove a passphrase lock, replacing an encrypted note with plaintext.
 *
 * **Not `writeNote`, deliberately.** `writeFile`'s own widening lets an
 * envelope replace an envelope naming the same recipients — an edit while
 * unlocked, a passphrase change — and refuses plaintext over an encrypted note
 * in every case, so that an ordinary Save can never silently turn a lock off.
 * This is the separate, narrower door for the one legitimate plaintext-over-
 * encrypted write: reachable only from an explicit "Remove encryption" action
 * in the console, never from the editor's own Save.
 *
 * `minimum: "editor"`, the same as `writeNote` — the passphrase is what gates
 * this, not the workspace role. Anyone who can already write this note and
 * who was given the passphrase some other way (`docs/decisions/encryption.md`:
 * "sharing a note does not share its passphrase") may remove the lock they
 * were told how to open; nobody who lacks the passphrase can produce a
 * plaintext body this console will accept, because there is nothing here that
 * could have decrypted the note to produce one.
 */
export const removeNoteEncryption = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "written" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "removeEncryption",
        path: args.path,
        text: args.text,
        expectedEtag: args.expectedEtag,
      },
    })) as Extract<OperationResult, { kind: "written" }>;

    // Paths and an outcome. Never the text, same as every other write here.
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.decrypt",
      paths: [result.path],
      details: { conflictCheck: result.conflictCheck },
    });
    return result;
  },
});

/** Create a folder. Requires `editor`. */
export const createDirectory = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: folderCreatedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "folderCreated" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "createFolder", path: args.path },
    })) as Extract<OperationResult, { kind: "folderCreated" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "folder.create",
      paths: [result.path],
    });
    return result;
  },
});

/** Move or rename a file or folder. Requires `editor`. */
export const moveEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.string(),
    to: v.string(),
    /**
     * The version of the note this move was asked about. The offline queue
     * sends it, so a rename typed on a train is refused with `CONFLICT` if the
     * note changed meanwhile rather than carrying somebody's newer text under
     * a name chosen for something else. See `movePath`.
     */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      actorName,
      operation: {
        kind: "move",
        from: args.from,
        to: args.to,
        ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
      },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.move",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Paste a copy at an explicit destination. Requires `editor`. */
export const copyEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "copy", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.copy",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Copy beside itself under a free "… copy" name. Requires `editor`. */
export const duplicateEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "duplicate", path: args.path },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.duplicate",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/**
 * Archive: move into `4-archive/<timestamp>/…`, recoverable by moving it back.
 *
 * This is the destructive-looking action the console offers first, precisely
 * because it is not destructive. Requires `editor`.
 */
export const archiveEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The version this archive was asked about. See `moveEntry`. */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      actorName,
      operation: {
        kind: "archive",
        path: args.path,
        ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
      },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.archive",
      paths: [result.from, result.to],
      details: { files: result.paths.length, recoverable: true },
    });
    return result;
  },
});

/** Move an entry into hidden, recoverable trash. Requires `editor`. */
export const trashEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The version this delete was asked about. See `moveEntry`. */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "trash",
        path: args.path,
        ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
      },
    })) as Extract<OperationResult, { kind: "moved" }>;
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.archive",
      paths: [result.from, result.to],
      details: { files: result.paths.length, recoverable: true, trash: true },
    });
    return result;
  },
});

/** Restore the exact entry returned by `trashEntry`. Requires `editor`. */
export const restoreTrashEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "restoreTrash", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.move",
      paths: [result.from, result.to],
      details: { files: result.paths.length, restoredFromTrash: true },
    });
    return result;
  },
});

/**
 * Delete permanently. Requires `editor` **and** the literal confirmation
 * string, which the console only sends after the person has been told plainly
 * that the file cannot be recovered.
 *
 * Nothing this product controls is kept: no archive, and **the legacy
 * `.history/` snapshots for that path are purged too** — that last clause is the
 * one this comment used to imply and the code did not do. Nothing writes new
 * snapshots any more.
 *
 * What it cannot reach is the customer's own object versioning, which we tell
 * them to enable and cannot see or delete. `lib/fileOps.ts` has the full
 * argument, and `describeDeleteForever` is the sentence the console has to keep
 * true.
 */
export const deleteEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    confirmation: v.string(),
  },
  returns: deletedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "deleted" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: {
        kind: "delete",
        path: args.path,
        confirmation: args.confirmation,
      },
    })) as Extract<OperationResult, { kind: "deleted" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.delete",
      paths: result.paths,
      details: { recoverable: false },
    });
    return result;
  },
});

/**
 * Change one note's visibility, through the privacy manifest. Requires
 * `owner` — see `setDirectoryVisibility` for why, learned the hard way.
 *
 * Setting a note to its folder's default removes the exception rather than
 * writing a redundant one — which is what keeps `privacy.md` a readable
 * statement of what is unusual, and what the tree's markers read.
 */
export const setNoteVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      actorName,
      operation: {
        kind: "setVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.note",
      paths: [result.path],
      details: { visibility: result.visibility, exception: result.exception },
    });
    return result;
  },
});

/**
 * Hand one note to a group, by name.
 *
 * The share dialog's verb. `setNoteVisibility` takes the two tiers and stays
 * that way — widening its validator would make every caller that sets a
 * visibility a way to mint a rule — so pointing a note at a group is its own
 * action, with its own audit line and its own proof that the group is real.
 *
 * **The name is resolved against THIS workspace before anything is written.**
 * Group names are globally unique but the authority is not: a name that exists
 * in somebody else's context must be as unusable here as one that exists
 * nowhere, and `groupByName` answers `null` for both. Writing an unresolvable
 * name would not leak — the engines read it as reaching nobody — but it would
 * put a rule in the customer's manifest that no owner can account for.
 *
 * Requires `owner`, like every other writer of `privacy.md`.
 */
export const setNoteGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The group's full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });

    // One resolver for the note and the folder alike, so the two cannot start
    // answering differently about the same name — which is how a folder
    // accepts an audience a note refuses, or the reverse. It also taught this
    // path to accept a person's handle, which it did not before: a rule may
    // name one person, and requiring a group of one to share with a colleague
    // was the friction that made the feature unusable.
    const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);

    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "setNoteGroup", path: args.path, group: name },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.note",
      paths: [result.path],
      details: { visibility: result.visibility, exception: result.exception },
    });
    return result;
  },
});

/**
 * Resolve the name an owner typed to the one that may go in `privacy.md`.
 *
 * Two kinds of subject, and the manifest cannot tell them apart — which is the
 * point. `@atlas-leads` and `@kola` are the same token to the parser, because
 * usernames, workspace slugs and group names share one global namespace
 * precisely so an addressing scheme that gates access is never ambiguous.
 *
 * **Both are resolved against THIS workspace before anything is written.** A
 * group name that exists in somebody else's context must be as unusable here as
 * one that exists nowhere, and a handle must belong to somebody who is actually
 * a member. Writing an unresolvable name would not leak — `grantedNamesFor`
 * reads it as reaching nobody — but it would put a rule in the customer's
 * manifest that no owner can account for, and it would read on screen as though
 * somebody had been given access.
 *
 * One refusal for every way of failing, in the style `resolveAddressedUser`
 * follows: no such group, a group of another workspace, no such handle, a
 * handle belonging to a shared context rather than a person, and a person who
 * is not a member here are all `GROUP_NOT_FOUND`. An owner who could tell them
 * apart would have an oracle for which names exist on the platform.
 */
async function resolveNamedAudience(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  typed: string,
): Promise<string> {
  // Tolerated on the way in and stripped once: the console renders the `@`
  // because that is what the manifest shows, and a caller pasting what they see
  // should not be a refusal. Stored without it, because the manifest's own
  // grammar supplies the `@`.
  const name = typed.trim().replace(/^@+/, "").toLowerCase();
  const resolved = await ctx.runQuery(internal.functions.files.namedAudience, {
    workspaceId,
    name,
  });
  if (resolved === null) {
    throw new ConvexError({
      code: "GROUP_NOT_FOUND",
      message: "That is not a group or a member of this context.",
    });
  }
  return resolved;
}

/**
 * INTERNAL. The database half of `resolveNamedAudience`.
 *
 * Returns the name to store, or `null` for every way of saying no.
 */
export const namedAudience = internalQuery({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const group = await ctx.db
      .query("workspaceGroups")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (group !== null) {
      return group.workspaceId === args.workspaceId ? group.name : null;
    }

    // Not a group, so it may be a person. `resolveAddressedUser` is the only
    // thing that decides who a handle belongs to — a `names` claim of
    // `kind: "user"`, or the sole owner of a PERSONAL workspace with that slug
    // — and every ambiguity there is already `null`.
    const userId = await resolveAddressedUser(ctx, { kind: "name", value: args.name });
    if (userId === null) return null;

    // A rule naming somebody who is not a member reaches nobody, because
    // `grantedNamesFor` intersects with membership. Refused rather than
    // written, for the reason `addGroupMember` refuses a stranger: it would sit
    // in the owner's manifest looking like access somebody had been given.
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", userId),
      )
      .unique();
    return membership === null ? null : args.name;
  },
});

/**
 * Point a FOLDER at a group or a person, which everything inside it follows.
 *
 * The console's Share sheet called `setNoteGroup` for a folder too, and that
 * function runs `fileOps.setVisibility`, which refuses anything that is not
 * `.md`. So sharing a folder with a group answered "Only markdown notes can
 * have their own visibility. Set the folder's default instead." — advice that
 * names the right instrument and cannot be followed, because the control that
 * sets a folder's default takes the two tiers and has no way to say a name.
 *
 * Its own action rather than a third value on `setDirectoryVisibility`, for the
 * reason `setNoteGroup` is its own action: widening that validator would make
 * every caller who sets a visibility a way to mint a rule.
 *
 * **The audit action is `visibility.folder.named`, not `visibility.folder`, and
 * that is a decision rather than a spelling.** `visibility.folder` is on
 * `MEMBER_VISIBLE_DETAIL_ACTIONS`, defended there on the details it carries:
 * its subject is "one a member already sees first-hand in their own listing".
 * True of `private` and `team` — a member watching a folder learns its default
 * changed the moment their listing does. False the moment the value is a name:
 * the row would hand a member the name of a group they are not in, which
 * `listGroups` is owner-only to withhold. Splitting the action keeps the gate
 * purely per-action, which is the shape it was deliberately given.
 *
 * Requires `owner`, like every other writer of `privacy.md`.
 */
export const setFolderGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });

    const name = await resolveNamedAudience(ctx, args.workspaceId, args.group);

    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "setFolderGroup", path: args.path, group: name },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.folder.named",
      paths: [result.path],
      details: { visibility: result.visibility },
    });
    return result;
  },
});

/**
 * Change a folder's default, which every note without an exception follows.
 * Requires `owner`.
 *
 * It said `editor` once, and that was a live breach: an invited editor
 * flipped private folders to `team` and read everything behind them —
 * deciding their own clearance, which is exactly the authority
 * `resetPrivacy`'s comment already reserved for the owner. All three
 * privacy-manifest writers now carry the same gate, and `lib/fileOps.ts`
 * refuses a non-`private` scope besides, so no future caller can reopen
 * this by getting one minimum wrong.
 */
export const setDirectoryVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      actorName,
      operation: {
        kind: "setFolderVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.folder",
      paths: [result.path],
      details: { visibility: result.visibility },
    });
    return result;
  },
});

/**
 * Write a working `privacy.md` over a missing or unreadable one.
 *
 * Owner-only, and the one operation here that is. Every other write is an
 * editor's to make; this one replaces the file that decides what an editor is
 * allowed to see at all, and an editor rewriting it would be deciding their own
 * clearance. `authorizeFileAccess` with `minimum: "owner"` is also what makes
 * the scope handed down `private`, which `resetPrivacyManifest` requires.
 *
 * It cannot touch a manifest that parses — see `lib/fileOps.ts` for why that
 * check, rather than this one, is the safety argument — and what it writes is
 * every folder `private`, so a person cannot use it to publish anything.
 */
export const resetPrivacy = action({
  args: { workspaceId: v.id("workspaces") },
  returns: privacyResetValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "privacyReset" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "resetPrivacy" },
    })) as Extract<OperationResult, { kind: "privacyReset" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "privacy.reset",
      paths: [result.path],
      // The folder *names* are metadata the audit log already records for every
      // other operation, and the count is what says how much of a map was
      // rebuilt. No rule is recorded because there is only one: private.
      details: {
        folders: result.folders.length,
        partial: result.partial,
        restored: result.backedUpTo !== null,
      },
    });
    return result;
  },
});

/**
 * Start the versioned on-bucket plumbing migration.
 *
 * Owner-only because it reorganizes Context's reserved objects, even though it
 * never names or rewrites a note; the copy phase is resumable and
 * non-destructive, and `runFileOperation` schedules cleanup only after the
 * rollback window has elapsed.
 */
export const updateStorageLayout = action({
  args: { workspaceId: v.id("workspaces") },
  returns: storageMigrationResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    await ctx.scheduler.runAfter(0, internal.functions.files.runStorageLayoutMigration, {
      workspaceId: args.workspaceId,
      actorUserId,
    });
    const result: Extract<OperationResult, { kind: "storageMigrated" }> = {
      kind: "storageMigrated",
      state: "copying",
      objectsCopied: 0,
      objectsVerified: 0,
      objectsDeleted: 0,
      conflicts: 0,
    };

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "storage.layout_migration_requested",
      paths: [],
      details: {
        state: result.state,
        objectsCopied: result.objectsCopied,
        objectsVerified: result.objectsVerified,
        conflicts: result.conflicts,
      },
    });
    return result;
  },
});

/* -------------------------------------------------------------------------- */
/*                                  activity                                  */
/* -------------------------------------------------------------------------- */

/**
 * `activity.md`, read and marked as read.
 *
 * Here rather than in a `functions/activity.ts` of its own, for a reason worth
 * writing down because it will come up again: the generated `api` type is at
 * TypeScript's instantiation limit, and adding one more top-level function
 * module pushes every inference in the repository's tests over it — 8
 * pre-existing `implicitly any` errors become 151, none of them near the
 * change. The feature is a view over a file, this is the file surface, and a
 * section is cheaper than the alternative.
 *
 * The writing half is `lib/activity.ts`, called from `executeOperation`.
 */
/**
 * Stamp a context as having changed, for the dot on its mark elsewhere.
 *
 * Monotonic, and that is the whole of its logic: two writers land lines in one
 * context — a person in the console and somebody's AI client through the
 * gateway — and neither knows about the other. A stamp that arrived late and
 * overwrote a newer one would put the dot out while something newer than the
 * reader's last visit was still unread.
 *
 * Internal: the gateway reaches it through `/gateway/activity`, and the
 * console through `runFileOperation`. Nothing a client can call.
 */
export const markWorkspaceActivity = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    at: v.number(),
    /**
     * Whether the line that landed was written at `team` tier.
     *
     * Only a `team` line moves `activityTeamAt`, which is the stamp every
     * member who is not the owner is served. Absent is the safe reading —
     * private — so an older caller can only ever under-report.
     */
    teamVisible: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) return null;
    // Clamped to now as well as forward-only: a clock ahead of ours must not
    // park a context permanently in the future, where nothing is ever newer.
    const at = Math.min(args.at, Date.now());
    const patch: { activityAt?: number; activityTeamAt?: number } = {};
    if ((workspace.activityAt ?? 0) < at) patch.activityAt = at;
    if (args.teamVisible === true && (workspace.activityTeamAt ?? 0) < at) {
      patch.activityTeamAt = at;
    }
    if (patch.activityAt === undefined && patch.activityTeamAt === undefined) return null;
    await ctx.db.patch(args.workspaceId, patch);
    return null;
  },
});

/**
 * When this person last looked at this context's activity.
 *
 * A query rather than part of the action below, because the unread line has to
 * move the moment somebody marks it read — and an action's result does not
 * re-run. The rows are fetched once; where the line sits among them is live.
 */
export const activityLastSeen = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    const actorUserId = await callerId(ctx);
    // Refused exactly as every other endpoint here refuses, rather than
    // answering `null` for a context the caller is not in: the isolation
    // census in `files.test.ts` compares the *whole* answer against the one a
    // workspace that never existed gives, and "null" from both would pass that
    // while still being a second shape of endpoint for anybody to reason about.
    await requireWorkspaceAccess(ctx, args.workspaceId, actorUserId);
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", actorUserId),
      )
      .unique();
    return membership?.activitySeenAt ?? null;
  },
});

/**
 * Catch up: everything recorded before now is read.
 *
 * Only ever moves forward. Two devices open at once, or a stale tab pressing
 * this a minute late, must not walk the marker backwards and make a member
 * see yesterday's work as new again.
 */
export const markActivitySeen = mutation({
  args: { workspaceId: v.id("workspaces"), at: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceAccess(ctx, args.workspaceId, actorUserId);
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", actorUserId),
      )
      .unique();
    if (!membership) return null;
    const at = Math.min(args.at ?? Date.now(), Date.now());
    if ((membership.activitySeenAt ?? 0) >= at) return null;
    await ctx.db.patch(membership._id, { activitySeenAt: at });
    return null;
  },
});

/**
 * The activity this caller may see, newest first.
 *
 * An action because it reads the bucket, and the bucket is behind the
 * credential barrier — the same one every other file read goes through. What
 * comes back is already filtered: `runFileOperation` applies the caller's own
 * scope and granted names, so a member never receives an entry about a note
 * they cannot open, and never a count of the ones they cannot.
 */
export const listActivity = action({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.array(activityEntryValidator),
  // Annotated rather than inferred, for the reason `runFileOperation` gives:
  // this action calls another function in the same deployment, and leaving the
  // return to inference makes the generated `api` type recurse through itself.
  // Unannotated, it costs 143 `implicitly any` errors across tests that have
  // nothing to do with it — the whole repository's inference, not this file's.
  handler: async (ctx, args): Promise<ActivityEntry[]> => {
    const actorUserId: Id<"users"> = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(
      internal.functions.files.authorizeFileAccess,
      { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
    );
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "readActivity" },
    });
    if (result.kind !== "activity") return [];
    const limit = Math.max(1, Math.min(args.limit ?? 50, 400));
    return result.entries.slice(0, limit);
  },
});
