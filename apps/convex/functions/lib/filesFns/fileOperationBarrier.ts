/**
 * THE CREDENTIAL BARRIER'S BODY. Read the module comment in
 * `functions/files.ts` before changing anything here.
 *
 * `runFileOperationHandler` is the handler of `runFileOperation`, the one
 * internal action the file editor added that opens a bucket credential. The
 * registration — its name, args and credential-free return validator — stays
 * in `functions/files.ts`, and `__tests__/storageCodePosition.test.ts` pins
 * that it hands over exactly this function. Moved verbatim.
 *
 * `STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE` are raised in this function
 * and nowhere else in the control plane, and only before `executeOperation`
 * runs; the same test holds that.
 */

import { ConvexError, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import { withPrivacyAuthority } from "../../../../mcp/src/store/privacyAuthority.js";
import { audienceOfNames } from "../pinnedReaders";
import { storePrivacyAuthority } from "../nodes/storeAuthority";
import { attachSmallData } from "../smallData/attach";
import { consoleIdLayoutHooks } from "../noteIds/consoleLayer";
import { encryptedUnreadable, managedEncryptionOption, rethrowUnreadable } from "../managedEncryptionFns/storeOption";
import { asRelocation } from "../../../../mcp/src/store/noteCap.js";
import type { GatewayCredential } from "../../storage";
import { clearanceOf } from "../clearance";
import { messageFor } from "../d1";
import { type FileStore, loadPrivacyState, type ProjectionClient } from "../fileOps";
import type { FormNotifyMaterial } from "../formOps";
import { recordWrites } from "../treeAnnounce";
import { indexChangeOf, treeChangeOf, treeChangeOfResult } from "./access";
import { markWebsiteAfterOperation } from "../websites/routeChangeAt";
import { siteLens } from "../websites/siteLens";
import { mayRelocateRoutines, mayTouchNestedRoutines, routinePathsTouched } from "../routines/changes";
import { texFolderOf } from "../routines/texFolder";
import { executeOperation } from "./executeOperation";
import { announceTreeChange } from "./treeOps";
import { searchDatabaseClient } from "../fastSearchFns/client";
import { recordProjectionOutcome } from "./projectionOutcome";
import { isNodesOperation, runNodesOperation } from "../nodes/run";
import { isTreeRead, treeReadAnswer } from "../nodes/treeReads";
import { TreeUnbound } from "../nodes/treeGate";
import { attachQueueMove, isMoveOperation, pendingMovesLookup, runMoveOperation } from "../nodes/moveBarrier";
import { attachPlacesFollower } from "../nodes/followPlaces";
import { attachTreeListing } from "../nodes/treeNames";
import { jobLens } from "./jobLens";
import { attachArrivalAccess } from "../nodes/arrivalAccess";
import { servedNoteCount } from "../nodes/servedCount";
import { attachMeaningIndex } from "../../../../mcp/src/search/meaning/store.js";
import {
  IDLE_MEANING,
  type MeaningPassContext,
  type MeaningSearchDescriptor,
  meaningPassContext,
  meaningSearchDescriptor,
  runMeaningPass,
} from "./meaningPass";
import { runGoogleForwardSync } from "./forwardSync";
import { failForwardSync, releaseForwardSync } from "./forwardSyncRecord";
import { runGoogleGmailBackfill } from "./gmailBackfillRefusal";
import { type ForwardSyncJob, timeoutFetch } from "./forwardSyncSupport";
import {
  type FileOperation,
  IDLE_INDEX_PASS,
  IDLE_PROJECTION,
  IDLE_PRUNE,
  type OperationResult,
} from "./operationTypes";
import { operationValidator } from "./operationValidators";
import { runPrunePass } from "./prunePass";
import { readTrashedText } from "../fileOps/trashedReading";
import { hideOldCopiesPass, readOldCopyTexts } from "../oldCopies/hiding";
import { repairLinks } from "../nodes/linkRepair";
import { toConvexError } from "./operationErrors";
import { afterMaintenance } from "./maintenanceFollowUps";

/** Operations that rearrange notes inside one context: never refused by the note cap. */
const RELOCATING_OPERATIONS = new Set(["move", "archive", "archiveTidy", "trash"]);

/**
 * Which rules the operation's store holds: a pin reader's are a guest's (`lib/pinnedReaders.ts`). A pass that keeps
 * a search index is the workspace's, not the caller's, so it is judged by a member's rules whoever scheduled it:
 * an index built from a guest's rules would file every team note under the wrong tier for every member.
 */
const INDEX_PASSES = new Set(["maintainIndex", "projectIndex", "pruneIndex", "projectMeaning"]);
function readerAudience(args: { grantedNames?: string[]; operation: { kind: string } }): "member" | "guest" {
  return INDEX_PASSES.has(args.operation.kind) ? "member" : audienceOfNames(args.grantedNames);
}

export async function runFileOperationHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    grantedNames?: string[];
    actorName?: string | null;
    operation: Infer<typeof operationValidator>;
  },
): Promise<OperationResult> {
  // The site's reads by `website/...` are judged where its folder is now, and answered by the name asked
  // (`lib/websites/siteLens.ts`, owner 2026-10-21).
  const lens = await siteLens(ctx, args);
  if (lens !== null) return lens.relabel(await runFileOperationHandler(ctx, { ...args, operation: lens.operation as typeof args.operation }));
  // A path under a built-in folder's default name (`inbox/...`) goes to the folder doing that job (`jobLens.ts`).
  const job = await jobLens(ctx, args);
  if (job !== null) return await runFileOperationHandler(ctx, { ...args, operation: job as typeof args.operation });
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
   * else: a `ready` row is kept current by writes and repaired by the daily
   * check (`prunePass.ts`), and a chain that kept running against one would
   * be a full bucket listing per link, forever, for a context with nothing
   * left to copy.
   */
  let projection: ProjectionClient | null = null;
  let projectionLeaseToken: string | null = null;

  /**
   * This context's search database, if the row is in the state the caller
   * needs and this deployment is configured.
   *
   * A projection pass may only run against a row that is still
   * `backfilling`; a search opens its own target below, ready or filling.
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
  // Both or neither secret, as `provisionIndex` reads them (`fastSearchFns/client.ts`).
  const clientFor = (target: { databaseId: string; state: string }) => searchDatabaseClient(ctx, target);

  /*
   * A SEARCH READS THE PROJECTION AND NEVER WRITES THE ROW.
   *
   * The asymmetry with the pass below is deliberate and is the reason these
   * are two blocks rather than one. A projection pass that cannot reach its
   * database must SAY so — a workspace sitting at "Preparing" with nothing
   * to explain why is the bug that whole path exists to close. A search must
   * do the opposite: somebody typed a word, and a deployment whose
   * Cloudflare credential is missing must not have their search flip a
   * provisioning row to `failed` as a side effect.
   */
  // Search by meaning is asked beside it, on the same terms: a `null` is
  // "words only", never a row written (`meaningSearchDescriptor`).
  let meaningSearch: MeaningSearchDescriptor | null = null;
  if (args.operation.kind === "search") {
    // Ready or still filling: a context with a database answers from it alone
    // (`searchNotes`), so a filling one is read too and says it is behind.
    const [target, meaningTarget] = await Promise.all([
      ctx.runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId: args.workspaceId }),
      meaningSearchDescriptor(ctx, args.workspaceId),
    ]);
    if (target !== null && (target.state === "ready" || target.state === "backfilling")) {
      const client = await clientFor(target);
      if (client !== null) projection = Object.assign(client, { filling: target.state !== "ready" });
    }
    meaningSearch = meaningTarget;
  }

  // A change re-indexed behind its operation is followed into a `ready`
  // projection too, so a rename or move is found at its new path at once
  // (`search/d1/follow.js`). Silent on every no, as a search is.
  // So is a queued folder move when its copy lands, and the daily check of a
  // `ready` database removes rows for notes that are gone (`prunePass.ts`).
  //
  // A context with a search database, ready or still filling, keeps no index
  // in its bucket (decided by the owner, 2026-10-17): its database is the
  // search, its own scheduled copy fills it, and a bucket-index pass was a
  // listing and a read of every changed note for an index nothing reads. So
  // `maintainIndex` stops here, before any credential, and `indexNotes`
  // follows the change into the database alone.
  let operation: FileOperation = args.operation as FileOperation;
  if (args.operation.kind === "maintainIndex" || args.operation.kind === "indexNotes" || args.operation.kind === "pruneIndex" || args.operation.kind === "hideOldCopies") {
    // Never fails the operation it rides on: a move's copy must not stop over a derivative.
    const target = await ctx
      .runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId: args.workspaceId })
      .catch(() => null);
    // A database a search can actually open, on the same terms the search
    // uses above: with no credential to reach it, the bucket's index is still
    // what answers, so it is still kept.
    const client = target !== null && (target.state === "ready" || target.state === "backfilling")
      ? await clientFor(target).catch(() => null)
      : null;
    if (args.operation.kind === "maintainIndex" && client !== null) return IDLE_INDEX_PASS;
    if (args.operation.kind === "indexNotes" && client !== null) operation = { ...args.operation, shardIndex: false };
    if (target?.state === "ready") projection = client;
    if (args.operation.kind === "pruneIndex" && projection === null) return IDLE_PRUNE;
  }

  if (args.operation.kind === "projectIndex") {
    const target = await projectionTarget("backfilling");
    if (target === null) return IDLE_PROJECTION;
    const token = crypto.randomUUID();
    const claimed = await ctx.runMutation(internal.functions.fastSearch.claimProjection, {
      workspaceId: args.workspaceId,
      token,
    });
    if (!claimed) return IDLE_PROJECTION;
    projectionLeaseToken = token;

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
      await ctx.runMutation(internal.functions.fastSearch.releaseProjection, {
        workspaceId: args.workspaceId,
        token,
      });
      return IDLE_PROJECTION;
    }
  }

  // Search by meaning's catch-up pass asks its row first too, for the reason
  // above (`meaningPass.ts`).
  let meaning: MeaningPassContext | null = null;
  if (args.operation.kind === "projectMeaning") {
    meaning = await meaningPassContext(ctx, args.workspaceId);
    if (meaning === null) return IDLE_MEANING;
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

  // Which notes exist, and what their facts say, is answered from the Convex
  // tree with no bucket credential decrypted at all, or "NOT_SERVED"
  // (`lib/nodes/treeReads.ts`; decided by the owner, 2026-10-13).
  if (isTreeRead(args.operation)) {
    try {
      return await treeReadAnswer(ctx, args);
    } catch (error) {
      if (!(error instanceof TreeUnbound)) throw error;
      throw new ConvexError({
        code: "STORAGE_NOT_CONNECTED",
        message: "This context has no bucket connected yet. Connect storage before browsing files.",
      });
    }
  }

  /*
    The three lookups a store is built from, asked together. Each is its own
    function call on the control plane, and asked one after another they were
    a visible share of every note open: the person waits on all three before a
    byte of the note is read. None depends on another, and each is still
    answered (and refused) exactly as before — only the waiting overlaps.
    A failure is caught where it is started and decided below, in the order
    the code always decided them, so an unconnected bucket still says so
    before a key problem does.
  */
  const capLookup = ctx
    .runQuery(internal.functions.billing.noteCap, { workspaceId: args.workspaceId })
    .catch(() => null);
  const encryptionLookup = managedEncryptionOption(ctx, args.workspaceId).catch(() => undefined);
  // Keyed moves the tree draws already (`lib/nodes/moveBarrier.ts`); a failed read fails the operation.
  const movesLookup = pendingMovesLookup(ctx, args.workspaceId);

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

  // The free managed tier's cap, the same number `/gateway/binding` sends, so
  // the console and an AI client are refused at the same count. A failed read
  // is no cap: a billing lookup must never cost somebody their notes.
  const noteCap = await capLookup;

  // Managed-storage encryption, or null for plain. A mode with no usable key
  // is a refusal, never a plain store over sealed bytes.
  const managedEncryption = await encryptionLookup;
  if (managedEncryption === undefined) {
    const refusal = encryptedUnreadable();
    if (args.operation.kind !== "googleForwardSync") throw refusal;
    return await failForwardSync(ctx, args.operation.connectionId, refusal.data.code, refusal.data.message);
  }

  // While staff have switched reads to the id copies, the app reads and saves through them as an AI client does.
  const idLayout = await consoleIdLayoutHooks(ctx, args.workspaceId);
  // A plaintext secret is in scope from here to the end of this function. It
  // is used to construct the stores below and nothing else — it is not logged, not
  // returned, and not passed to `lib/fileOps.ts`, which only ever sees the
  // store.
  let store: FileStore;
  // The owner's Download of old copies reads each at the key its row names, a pinned path included, so past the id layer (`lib/oldCopies/folders.ts`).
  let keyStore: FileStore | null = null;
  try {
    // One table decides which backend this workspace got — the same table
    // the gateway uses, so the console reads and writes exactly what an AI
    // client does. A second switch here would be the second place to forget
    // a new backend, and the direction that forgetting fails is "built an
    // S3 store out of a binding of another provider".
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
      noteCap,
      // The cap counts the tree's rows, never the bucket (`store/noteCap.js`).
      noteCount: async () => (await servedNoteCount(ctx, args.workspaceId))?.notes ?? null,
      managedEncryption,
      idLayout,
    }) as unknown as FileStore;
    if (args.operation.kind === "readOldCopies") {
      keyStore = storeForBinding(credential, undefined, { fetchImpl: timeoutFetch, managedEncryption }) as unknown as FileStore;
    }
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

  // The access rules, rendered from the tree's rows for this reader (`apps/mcp/src/store/privacyAuthority.js`).
  // Every read of the rules below goes through this, the console's and the gateway's alike.
  // A row's tier set by the operation itself (a copy narrowed, a move's destination tightened) goes through `setAccess`.
  store = withPrivacyAuthority(store as never, await storePrivacyAuthority(ctx, args.workspaceId, readerAudience(args))) as unknown as FileStore;
  // The forwarding ledger and the icons from Convex (`lib/smallData/attach.ts`): their bucket files are never read back.
  attachSmallData(ctx, args.workspaceId, store);

  if (isNodesOperation(args.operation)) return await runNodesOperation(ctx, { ...args, operation: args.operation }, store);
  if (isMoveOperation(args.operation)) return await runMoveOperation(ctx, { ...args, operation: args.operation }, store, projection);
  if (args.operation.kind === "pruneIndex") {
    // Its census decides which rows are gone, so it reads the tree's names too: a bucket listing of uuid keys would delete every keyed row.
    attachTreeListing(ctx, args.workspaceId, store);
    return await runPrunePass(ctx, { ...args, operation: args.operation }, store, projection, await movesLookup);
  }
  const bucket = store;

  // Non-enumerable, as the gateway attaches it: `searchNotes` asks it, and
  // no serializer walking the store can carry the token out.
  if (meaningSearch !== null) attachMeaningIndex(store, meaningSearch, null);

  // A read, through the pending moves and nothing after this (`fileOps/trashedReading.ts`).
  if (args.operation.kind === "readTrashed") {
    const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
    return await readTrashedText(store, { ...args.operation, clearance }).catch((error) => rethrowUnreadable(toConvexError(error)));
  }

  // Old copies (`lib/oldCopies/hiding.ts`): rows moved to a hidden name, and the owner's export reading them back.
  if (args.operation.kind === "hideOldCopies") {
    return await hideOldCopiesPass(ctx, args.workspaceId, store, projection, args.operation.cursor ?? null);
  }
  if (args.operation.kind === "readOldCopies") {
    return { kind: "oldCopyTexts", results: await readOldCopyTexts(ctx, args.workspaceId, keyStore ?? store, args.operation.paths) };
  }
  // A queued move's links (`lib/nodes/linkRepair.ts`): the notes it rewrote are told to the tree as any write is.
  if (args.operation.kind === "repairLinks") {
    const written = recordWrites(store);
    const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
    const result = await repairLinks(ctx, args.workspaceId, store, clearance, args.operation.pairs);
    if (written.size > 0) await announceTreeChange(ctx, store, args, { paths: [...written], narrows: false }, result, null);
    return result;
  }

  if (meaning !== null && args.operation.kind === "projectMeaning") {
    // Its census is the tree's names, as every other listing here is (`namesListing`).
    attachTreeListing(ctx, args.workspaceId, store);
    return await runMeaningPass(ctx, { ...args, operation: args.operation }, store, meaning);
  }

  if (args.operation.kind === "googleForwardSync" && forwardSyncJob?.kind === "run") {
    /*
      The pass returns before the announcement below, and the days it wrote
      are known only to the writes themselves — so they are recorded as they
      land, and the ones that did land are announced to whoever can see them.
      Without this a day of mail reached an open tree at its next periodic
      walk, not when it arrived.
    */
    const written = recordWrites(store);
    // Its contact lookup lists the contacts folder by the tree's names, never the bucket's (`contactLookup.js`).
    attachTreeListing(ctx, args.workspaceId, store);
    const result = await runGoogleForwardSync(ctx, store, forwardSyncJob);
    if (written.size > 0) {
      await announceTreeChange(ctx, store, args, { paths: [...written], narrows: false }, result, null);
    }
    return result;
  }

  let wroteActivity: { teamVisible: boolean; reprivate: boolean } | null = null;
  let dueNotification: (FormNotifyMaterial & { responseId: string }) | null = null;
  /*
    What this operation does to the file tree, if anything, and — for one
    that can take something away from somebody — who could see it before.
    Read before the operation because afterwards the answer is gone: a note
    made private is, by then, private. See `announceTreeChange`.
  */
  const treeChange = treeChangeOf(args.operation as FileOperation);
  const privacyBefore = treeChange?.narrows === true ? await loadPrivacyState(store).catch(() => null) : null;
  // A move inside this context adds no note, so it runs in the cap's
  // relocation window (`store/noteCap.js`). Copying, duplicating, restoring
  // from the trash and a move in from another context all add one, and stay
  // capped.
  const listing = { store };
  attachQueueMove(ctx, args, listing.store, bucket, projection);
  attachTreeListing(ctx, args.workspaceId, listing.store);
  await attachArrivalAccess(ctx, args, listing.store);
  const followPlaces = attachPlacesFollower(ctx, args.workspaceId, listing.store);
  // Where Tex's folder is before this runs: a move or trash may take it out of reach (see `routinePathsTouched`).
  const texBefore = mayRelocateRoutines(args.operation as FileOperation) ? await texFolderOf(ctx, args.workspaceId) : null;
  const operate = () => executeOperation(
    listing.store,
    clearanceOf(args.scope, args.grantedNames ?? []),
    operation as FileOperation,
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
    args.workspaceId,
  );
  const result = await (RELOCATING_OPERATIONS.has(args.operation.kind)
    ? asRelocation(store, operate)
    : operate()
  ).catch(rethrowUnreadable);

  // Website rows are a derivative of bucket bytes: mark them stale after the
  // canonical write lands. Best effort; the periodic reconciler repairs a miss.
  await markWebsiteAfterOperation(ctx, args.workspaceId, args.operation as FileOperation, result);

  // Routine rows are a derivative of the routine roots (`routines/` and
  // `tex/routines/`) too. The person who acted is named by `actorName`, the handle `authorizeFileAccess` resolved from live
  // membership; `recordRoutineSignal` keeps them as the writer only if they
  // can write here now. Best effort, like the website mark above.
  let routinePaths = routinePathsTouched(args.operation as FileOperation, result, texBefore);
  if (routinePaths.length === 0 && mayTouchNestedRoutines(args.operation as FileOperation, result)) {
    // Tex's folder may be nested anywhere (owner, 2026-10-18): ask where, and name its routines as rows do.
    routinePaths = routinePathsTouched(args.operation as FileOperation, result, await texFolderOf(ctx, args.workspaceId));
  }
  if (routinePaths.length > 0) {
    await ctx
      .runMutation(internal.functions.routines.recordRoutineSignal, {
        workspaceId: args.workspaceId,
        ...(typeof args.actorName === "string" ? { actorName: args.actorName } : {}),
        paths: routinePaths,
      })
      .catch(() => {});
  }

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

  const indexChange = indexChangeOf(args.operation as FileOperation, result);
  const landedChange = treeChange ?? treeChangeOfResult(args.operation as FileOperation, result);
  await announceTreeChange(ctx, store, args, landedChange, result, privacyBefore, indexChange?.written);
  await followPlaces();

  /*
    The notes this operation changed, re-indexed now rather than whenever a
    search next finds the index's listing a minute old. Scheduled, so the save
    returns without waiting on it, and caught, because the index is a
    derivative and a failure here must never read as a failed save.
  */
  if (indexChange !== null) {
    await ctx.scheduler
      .runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: args.scope,
        operation: { kind: "indexNotes", ...indexChange },
      })
      .catch(() => {});
  }

  /*
    Stamped after the operation, once, and never inside it: the store is the
    customer's bucket and this is a row in ours, so a failure here must not
    look like a failed save. `markWorkspaceActivity` is monotonic, so a
    late-landing stamp cannot walk the dot backwards.
  */
  if (wroteActivity !== null) {
    // The activity file names private notes: whatever row it has, it is private again (non-negotiable 5).
    if ((wroteActivity as { reprivate: boolean }).reprivate) {
      await ctx
        .runMutation(internal.functions.nodesAccess.keepActivityPrivate, { workspaceId: args.workspaceId })
        .catch(() => {});
    }
    await ctx
      .runMutation(internal.functions.files.markWorkspaceActivity, {
        workspaceId: args.workspaceId,
        at: Date.now(),
        teamVisible: (wroteActivity as { teamVisible: boolean }).teamVisible,
      })
      .catch(() => {});
  }

  if (result.kind === "indexProjected") {
    try {
      await recordProjectionOutcome(ctx, args, result);
    } finally {
      if (projectionLeaseToken !== null) {
        await ctx.runMutation(internal.functions.fastSearch.releaseProjection, {
          workspaceId: args.workspaceId,
          token: projectionLeaseToken,
        });
      }
    }
    // The detail was for the log line; the scheduler keeps return values, and
    // the validator holds them to the shape every caller already reads.
    const { failureDetail: _logged, priorities: _recorded, ...answer } = result;
    return answer;
  }

  await afterMaintenance(ctx, args, result);
  return result;
}
