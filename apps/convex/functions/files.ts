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
import { storeForBinding } from "../../mcp/src/store/factory.js";
// The gateway's D1 wire, imported rather than ported, for the same reason
// `lib/fileOps.ts` imports its search: `apps/mcp` targets the Workers runtime,
// which is Convex's runtime too. It holds the write token for the life of one
// call and puts it in exactly one place, an `Authorization` header.
import { createD1Client } from "../../mcp/src/search/d1/client.js";
import {
  STORAGE_LAYOUT_ROLLBACK_MS,
} from "../../mcp/src/storageLayout.js";
import {
  D1_ACCOUNT_SECRET,
  D1_TOKEN_SECRET,
  messageFor,
} from "./lib/d1";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  type PrivacyState,
  loadPrivacyState,
  type ProjectionClient,
} from "./lib/fileOps";
import {
  type FormNotifyMaterial,
} from "./lib/formOps";
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
import { resolveFileAccess, treeChangeOf } from "./lib/filesFns/access";
import {
  type ForwardSyncJob,
  timeoutFetch,
} from "./lib/filesFns/forwardSyncSupport";
import { executeOperation } from "./lib/filesFns/executeOperation";
import {
  type BlendedAnswer,
} from "./lib/filesFns/searchDeadline";
import {
  type VaultImportJobStatus,
} from "./lib/filesFns/vaultImportPlan";
import {
  latestVaultImportJobHandler,
  pauseVaultImportHandler,
  recordVaultClearBatchHandler,
  recordVaultImportBatchHandler,
  startVaultImportHandler,
} from "./lib/filesFns/vaultImportJobs";
import { listDurableMovesHandler } from "./lib/filesFns/durableMoves";
import { namedAudienceHandler } from "./lib/filesFns/namedAudience";
import {
  activityLastSeenHandler,
  markActivitySeenHandler,
  markWorkspaceActivityHandler,
} from "./lib/filesFns/activityMarks";
import {
  archiveEntryHandler,
  copyEntryHandler,
  createDirectoryHandler,
  deleteEntryHandler,
  duplicateEntryHandler,
  moveEntryHandler,
  restoreTrashEntryHandler,
  trashEntryHandler,
} from "./lib/filesFns/entries";
import {
  resetPrivacyHandler,
  setDirectoryVisibilityHandler,
  setFolderGroupHandler,
  setNoteGroupHandler,
  setNoteVisibilityHandler,
} from "./lib/filesFns/visibility";
import {
  readNoteImageHandler,
  setWorkspaceIconPhotoHandler,
  storeNoteImageHandler,
  workspaceIconPhotoHandler,
} from "./lib/filesFns/images";
import {
  listActivityHandler,
  listFilesHandler,
  readNoteHandler,
  readNotesHandler,
  syncManifestHandler,
} from "./lib/filesFns/noteReads";
import {
  listManagedPluginsHandler,
  listObsidianPluginsHandler,
} from "./lib/filesFns/pluginReads";
import {
  removeNoteEncryptionHandler,
  writeNoteHandler,
} from "./lib/filesFns/noteWrites";
import {
  clearVaultImportBatchHandler,
  importVaultBatchHandler,
  importVaultJobBatchHandler,
} from "./lib/filesFns/vaultImportBatches";
import {
  runStorageLayoutMigrationHandler,
  updateStorageLayoutHandler,
} from "./lib/filesFns/storageLayout";
import {
  folderPathsHandler,
  notePathsHandler,
  searchContextHandler,
  searchContextsHandler,
} from "./lib/filesFns/search";
import {
  failForwardSync,
  releaseForwardSync,
  runGoogleForwardSync,
  runGoogleGmailBackfill,
} from "./lib/filesFns/forwardSync";
export { scopeForRole, resolveFileAccess, callerId } from "./lib/filesFns/access";
export { executeOperation } from "./lib/filesFns/executeOperation";

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

/** See `runStorageLayoutMigrationHandler` in `lib/filesFns/storageLayout.ts`. */
export const runStorageLayoutMigration = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: storageMigrationResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => await runStorageLayoutMigrationHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                              the public surface                            */
/* -------------------------------------------------------------------------- */

/** See `listDurableMovesHandler` in `lib/filesFns/durableMoves.ts`. */
export const listDurableMoves = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(durableMoveValidator),
  handler: async (ctx, args) => await listDurableMovesHandler(ctx, args),
});

/** One folder's contents. Any member may read. */
export const listFiles = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: listingValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "listing" }>> => await listFilesHandler(ctx, args),
});

/** See `listObsidianPluginsHandler` in `lib/filesFns/pluginReads.ts`. */
export const listObsidianPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginInventoryValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "pluginInventory" }>> => await listObsidianPluginsHandler(ctx, args),
});

/** See `listManagedPluginsHandler` in `lib/filesFns/pluginReads.ts`. */
export const listManagedPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginManagedInstallsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "pluginManagedInstalls" }>> => await listManagedPluginsHandler(ctx, args),
});

/** One note's markdown. Any member may read what their scope can see. */
export const readNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: fileValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "file" }>> => await readNoteHandler(ctx, args),
});

/** See `syncManifestHandler` in `lib/filesFns/noteReads.ts`. */
export const syncManifest = action({
  args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.string()) },
  returns: manifestValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "manifest" }>> => await syncManifestHandler(ctx, args),
});

/** See `readNotesHandler` in `lib/filesFns/noteReads.ts`. */
export const readNotes = action({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: notesValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "notes" }>> => await readNotesHandler(ctx, args),
});

/** See `searchContextHandler` in `lib/filesFns/search.ts`. */
export const searchContext = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    prefix: v.optional(v.string()),
  },
  returns: searchResultsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "searchResults" }>> => await searchContextHandler(ctx, args),
});

/** See `folderPathsHandler` in `lib/filesFns/search.ts`. */
export const folderPaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: folderPathsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "folderPaths" }>> => await folderPathsHandler(ctx, args),
});

/** See `notePathsHandler` in `lib/filesFns/search.ts`. */
export const notePaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: notePathsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "notePaths" }>> => await notePathsHandler(ctx, args),
});

/** See `searchContextsHandler` in `lib/filesFns/search.ts`. */
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
  handler: async (ctx, args): Promise<BlendedAnswer> => await searchContextsHandler(ctx, args),
});

/** See `writeNoteHandler` in `lib/filesFns/noteWrites.ts`. */
export const writeNote = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "written" }>> => await writeNoteHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                    a pasted image, in and back out again                    */
/* -------------------------------------------------------------------------- */

/** See `storeNoteImageHandler` in `lib/filesFns/images.ts`. */
export const storeNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => await storeNoteImageHandler(ctx, args),
});

/** See `readNoteImageHandler` in `lib/filesFns/images.ts`. */
export const readNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    notePath: v.string(),
    leaf: v.string(),
  },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => await readNoteImageHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                      a workspace's icon, in and back out                    */
/* -------------------------------------------------------------------------- */

/** See `setWorkspaceIconPhotoHandler` in `lib/filesFns/images.ts`. */
export const setWorkspaceIconPhoto = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => await setWorkspaceIconPhotoHandler(ctx, args),
});

/** See `workspaceIconPhotoHandler` in `lib/filesFns/images.ts`. */
export const workspaceIconPhoto = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => await workspaceIconPhotoHandler(ctx, args),
});

/** See `startVaultImportHandler` in `lib/filesFns/vaultImportJobs.ts`. */
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
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await startVaultImportHandler(ctx, args),
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
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await recordVaultClearBatchHandler(ctx, args),
});

/** Count, then remove, one retryable page of every object in a replacement bucket. */
export const clearVaultImportBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await clearVaultImportBatchHandler(ctx, args),
});

/** The latest unfinished import for this owner and workspace, without paths or content. */
export const latestVaultImportJob = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await latestVaultImportJobHandler(ctx, args),
});

/** Record the local uploader stopping while keeping every completed batch resumable. */
export const pauseVaultImport = mutation({
  args: { workspaceId: v.id("workspaces"), jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await pauseVaultImportHandler(ctx, args),
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
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await recordVaultImportBatchHandler(ctx, args),
});

/** See `importVaultJobBatchHandler` in `lib/filesFns/vaultImportBatches.ts`. */
export const importVaultJobBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await importVaultJobBatchHandler(ctx, args),
});

/** See `importVaultBatchHandler` in `lib/filesFns/vaultImportBatches.ts`. */
export const importVaultBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "vaultImported" }>> => await importVaultBatchHandler(ctx, args),
});

/** See `removeNoteEncryptionHandler` in `lib/filesFns/noteWrites.ts`. */
export const removeNoteEncryption = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "written" }>> => await removeNoteEncryptionHandler(ctx, args),
});

/** Create a folder. Requires `editor`. */
export const createDirectory = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: folderCreatedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "folderCreated" }>> => await createDirectoryHandler(ctx, args),
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
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await moveEntryHandler(ctx, args),
});

/** Paste a copy at an explicit destination. Requires `editor`. */
export const copyEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await copyEntryHandler(ctx, args),
});

/** Copy beside itself under a free "… copy" name. Requires `editor`. */
export const duplicateEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await duplicateEntryHandler(ctx, args),
});

/** See `archiveEntryHandler` in `lib/filesFns/entries.ts`. */
export const archiveEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The version this archive was asked about. See `moveEntry`. */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await archiveEntryHandler(ctx, args),
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
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await trashEntryHandler(ctx, args),
});

/** Restore the exact entry returned by `trashEntry`. Requires `editor`. */
export const restoreTrashEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await restoreTrashEntryHandler(ctx, args),
});

/** See `deleteEntryHandler` in `lib/filesFns/entries.ts`. */
export const deleteEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    confirmation: v.string(),
  },
  returns: deletedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "deleted" }>> => await deleteEntryHandler(ctx, args),
});

/** See `setNoteVisibilityHandler` in `lib/filesFns/visibility.ts`. */
export const setNoteVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setNoteVisibilityHandler(ctx, args),
});

/** See `setNoteGroupHandler` in `lib/filesFns/visibility.ts`. */
export const setNoteGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The group's full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setNoteGroupHandler(ctx, args),
});

/** See `namedAudienceHandler` in `lib/filesFns/namedAudience.ts`. */
export const namedAudience = internalQuery({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await namedAudienceHandler(ctx, args),
});

/** See `setFolderGroupHandler` in `lib/filesFns/visibility.ts`. */
export const setFolderGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setFolderGroupHandler(ctx, args),
});

/** See `setDirectoryVisibilityHandler` in `lib/filesFns/visibility.ts`. */
export const setDirectoryVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setDirectoryVisibilityHandler(ctx, args),
});

/** See `resetPrivacyHandler` in `lib/filesFns/visibility.ts`. */
export const resetPrivacy = action({
  args: { workspaceId: v.id("workspaces") },
  returns: privacyResetValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "privacyReset" }>> => await resetPrivacyHandler(ctx, args),
});

/** See `updateStorageLayoutHandler` in `lib/filesFns/storageLayout.ts`. */
export const updateStorageLayout = action({
  args: { workspaceId: v.id("workspaces") },
  returns: storageMigrationResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => await updateStorageLayoutHandler(ctx, args),
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
/** See `markWorkspaceActivityHandler` in `lib/filesFns/activityMarks.ts`. */
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
  handler: async (ctx, args): Promise<null> => await markWorkspaceActivityHandler(ctx, args),
});

/** See `activityLastSeenHandler` in `lib/filesFns/activityMarks.ts`. */
export const activityLastSeen = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => await activityLastSeenHandler(ctx, args),
});

/** See `markActivitySeenHandler` in `lib/filesFns/activityMarks.ts`. */
export const markActivitySeen = mutation({
  args: { workspaceId: v.id("workspaces"), at: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => await markActivitySeenHandler(ctx, args),
});

/** See `listActivityHandler` in `lib/filesFns/noteReads.ts`. */
export const listActivity = action({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.array(activityEntryValidator),
  // Annotated rather than inferred, for the reason `runFileOperation` gives:
  // this action calls another function in the same deployment, and leaving the
  // return to inference makes the generated `api` type recurse through itself.
  // Unannotated, it costs 143 `implicitly any` errors across tests that have
  // nothing to do with it — the whole repository's inference, not this file's.
  handler: async (ctx, args): Promise<ActivityEntry[]> => await listActivityHandler(ctx, args),
});
