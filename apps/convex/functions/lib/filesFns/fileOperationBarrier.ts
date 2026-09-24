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
// The gateway's D1 wire, imported rather than ported, for the same reason
// `lib/fileOps.ts` imports its search: `apps/mcp` targets the Workers runtime,
// which is Convex's runtime too. It holds the write token for the life of one
// call and puts it in exactly one place, an `Authorization` header.
import { createD1Client } from "../../../../mcp/src/search/d1/client.js";
import { STORAGE_LAYOUT_ROLLBACK_MS } from "../../../../mcp/src/storageLayout.js";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import type { GatewayCredential } from "../../storage";
import { clearanceOf } from "../clearance";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET, messageFor } from "../d1";
import {
  type FileStore,
  loadPrivacyState,
  type PrivacyState,
  type ProjectionClient,
} from "../fileOps";
import type { FormNotifyMaterial } from "../formOps";
import {
  audiencesForChange,
  type TreeChange,
  trimTrailingSlashes,
} from "../treeAnnounce";
import { treeChangeOf } from "./access";
import { executeOperation } from "./executeOperation";
import {
  failForwardSync,
  releaseForwardSync,
  runGoogleForwardSync,
  runGoogleGmailBackfill,
} from "./forwardSync";
import { type ForwardSyncJob, timeoutFetch } from "./forwardSyncSupport";
import {
  type FileOperation,
  IDLE_PROJECTION,
  type OperationResult,
} from "./operationTypes";
import { operationValidator } from "./operationValidators";

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
}
