/**
 * Creating and destroying one context's search database.
 *
 * Both entry points are `internalAction`s reached only by a schedule edge from
 * `functions/fastSearch.ts` — "scheduling is not calling"
 * (`docs/decisions/storage-and-credentials.md`), which is what keeps the
 * public mutation that starts them from being a path to the credential these
 * open.
 *
 * ## The credential
 *
 * `SEARCH_D1_API_TOKEN` and `SEARCH_D1_ACCOUNT_ID` come from `appSecrets`, set
 * in the staff console. **Their absence is an ordinary state, not a crash**: a
 * deployment nobody has configured — a self-hoster's, or ours before somebody
 * pastes the token — records `NOT_CONFIGURED` and stops. The context keeps
 * working on the R2 index, which is the whole reason "off" is a working state
 * rather than a broken one.
 *
 * ## Failure is recorded, never thrown away
 *
 * Every exit writes a status through `recordProvisionResult`. An action that
 * threw would leave a row saying `provisioning` forever, and the settings
 * screen would spin at a person with no way to learn why. What a failure
 * records is **our** sentence and our error code, never Cloudflare's text —
 * a provider message can name the account or the token.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import {
  D1Error,
  D1_ACCOUNT_SECRET,
  D1_SCHEMA_VERSION,
  D1_TOKEN_SECRET,
  SCHEMA_STATEMENTS,
  createDatabase,
  databaseNameFor,
  deleteDatabase,
  exec,
  messageFor,
  type D1Config,
} from "./lib/d1";
import { PROJECTION_CHAIN } from "./lib/fastSearch";

/** How long a D1 database that has only just been created may take to answer. */
const D1_SETTLE_MS = 2 * 60 * 1000;
const D1_SETTLE_POLL_MS = 5 * 1000;

/**
 * D1 failures that will answer the same way however long we wait.
 *
 * `UNAUTHORIZED` is the interesting one, and it is terminal here for a reason
 * that does not hold on the R2 paths: the token this opens is standing
 * deployment configuration, not a key minted moments ago, so a refusal means a
 * staffer has to fix something and waiting two minutes only delays telling
 * them. `REFUSED` is Cloudflare rejecting the request itself — a malformed
 * statement will not become well-formed.
 *
 * Everything else — `NOT_FOUND` for a database that is not routable yet,
 * `RATE_LIMITED`, `UNAVAILABLE` — is a wait.
 */
const TERMINAL_D1_ERRORS = new Set(["UNAUTHORIZED", "REFUSED"]);

/**
 * Read both halves of the credential, or `null` if either is missing.
 *
 * Both or neither: a token with no account id, or an account id with no token,
 * is a half-configured deployment and reads exactly like an unconfigured one
 * to everything downstream. Reporting them separately would be two error
 * states with one cure.
 */
async function configFor(ctx: ActionCtx): Promise<D1Config | null> {
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
    return null;
  }
  return { accountId, apiToken };
}

/**
 * Create the database and apply the schema.
 *
 * Idempotent in the direction that matters: it reads the binding first and
 * stops if the row is gone or the owner has opted out, so a duplicate schedule
 * does not create a second database. It does **not** try to reuse an existing
 * `databaseId` — a row that already has one is already provisioned, and the
 * only way to get here with one is a retry after a failure that happened after
 * creation, which the guard below turns into a schema re-apply rather than a
 * second create.
 */
export const provisionIndex = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    generation: v.literal("premium-v1"),
    /**
     * Deadline for the current run of failures, set when one first happens.
     *
     * Absent on the first attempt, which is how a fresh schedule always gets a
     * full window rather than inheriting a spent one.
     */
    retryUntil: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const binding = await ctx.runQuery(
      internal.functions.fastSearch.bindingForWorkspace,
      { workspaceId: args.workspaceId },
    );
    // Opted out, or never opted in, between the schedule and now. Nothing to
    // do, and creating a database here would be creating one nobody asked for.
    if (
      binding === null ||
      binding.generation !== args.generation ||
      !binding.optedIn
    ) {
      return { status: "skipped" };
    }

    const config = await configFor(ctx);
    if (config === null) {
      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        generation: args.generation,
        status: "failed",
        errorCode: "NOT_CONFIGURED",
        error: messageFor("NOT_CONFIGURED"),
      });
      return { status: "failed" };
    }

    try {
      let databaseId = binding.databaseId;
      let databaseName = binding.databaseName;

      if (databaseId === undefined) {
        const name = databaseNameFor(args.workspaceId);
        const created = await createDatabase(config, name);
        databaseId = created.uuid;
        databaseName = created.name;
        // Recorded BEFORE the schema is applied, and that order is the whole
        // safety argument: a database created but not recorded is one nothing
        // can ever find to delete — an orphaned derived copy of somebody's
        // notes on our infrastructure. A recorded database whose schema failed
        // is a retry.
        await ctx.runMutation(
          internal.functions.fastSearch.recordProvisionResult,
          {
            workspaceId: args.workspaceId,
            generation: args.generation,
            status: "provisioning",
            databaseId,
            databaseName,
          },
        );
      }

      await exec(config, databaseId, SCHEMA_STATEMENTS);

      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        generation: args.generation,
        status: "backfilling",
        databaseId,
        databaseName,
        schemaVersion: D1_SCHEMA_VERSION,
        notesIndexed: 0,
      });

      /*
       * AND THEN SOMETHING ACTUALLY COPIES THE NOTES.
       *
       * This used to end here: schema applied, `backfilling` recorded, return.
       * Every trigger that filled the database was a search — the gateway's,
       * behind its own response — so an owner who turned the switch on and
       * closed the app sat at "0 notes indexed / Preparing" indefinitely, and
       * three real contexts were doing exactly that.
       *
       * **After the status is recorded**, because the first thing the pass
       * does is ask the row whether it is `backfilling`; scheduled before,
       * it would race its own precondition.
       *
       * **Scheduled, not called.** It opens a bucket credential, which is a
       * thing only the enumerated barrier may do, and the scheduler discards
       * the result so nothing can flow back here — CLAUDE.md, "scheduling is
       * not calling", the same shape that reaches this action from `enable`.
       */
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        // Scope-blind: an index describes the bucket, and the tier a note is
        // copied at is read from `privacy.md` per note. Nothing about this
        // pass consults the scope it is handed.
        scope: "private",
        operation: { kind: "projectIndex", passes: PROJECTION_CHAIN },
      });
      return { status: "backfilling" };
    } catch (error) {
      const code = error instanceof D1Error ? error.code : "REFUSED";
      /*
        A DATABASE CREATED A MOMENT AGO IS NOT A DATABASE THAT IS BROKEN.

        This used to record `failed` on the first error of any kind, and that
        state is a dead end rather than a setback: `sweepStalledBackfills` only
        picks up rows that reached `backfilling`, so a single 404 for a database
        that was not routable yet — or one rate-limited request — parked fast
        search until the owner happened to notice and toggle the switch. The
        same shape, and the same fix, as the managed copy's settling window.

        Nothing is written while retrying. The row keeps whatever it had, which
        matters more here than it looks: a `databaseId` recorded before the
        schema was applied is the only handle this system has on a live D1
        database, and the screen keeps saying `Preparing`, which is true.
      */
      const deadline = args.retryUntil ?? Date.now() + D1_SETTLE_MS;
      const remaining = deadline - Date.now();
      if (!TERMINAL_D1_ERRORS.has(code) && remaining > 0) {
        const delay = Math.min(D1_SETTLE_POLL_MS, remaining);
        await ctx.scheduler.runAfter(
          delay,
          internal.functions.fastSearchProvision.provisionIndex,
          {
            workspaceId: args.workspaceId,
            generation: args.generation,
            retryUntil: deadline,
          },
        );
        return { status: "provisioning" };
      }
      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        generation: args.generation,
        status: "failed",
        errorCode: code,
        error: messageFor(code),
      });
      return { status: "failed" };
    }
  },
});

/**
 * Delete the database an owner opted out of, then forget the row.
 *
 * **The row is only forgotten once Cloudflare confirms the delete.** A release
 * that removed the row first and then failed would leave the derived copy on
 * our infrastructure with nothing left pointing at it — which is precisely the
 * outcome the opt-out exists to prevent, arrived at by tidying up.
 *
 * A failure here leaves the row `releasing`, which serves nothing and is what
 * the sweep retries.
 */
export const releaseIndex = internalAction({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const binding = await ctx.runQuery(
      internal.functions.fastSearch.bindingForWorkspace,
      { workspaceId: args.workspaceId },
    );
    if (binding === null) return { released: true };
    // Re-enabled while this was in flight. The provisioner owns the row now,
    // and deleting its database here would strand the one it is building.
    if (binding.optedIn) return { released: false };

    if (binding.databaseId === undefined) {
      await ctx.runMutation(internal.functions.fastSearch.forgetIndex, {
        workspaceId: args.workspaceId,
      });
      return { released: true };
    }

    const config = await configFor(ctx);
    if (config === null) {
      // Nothing can be deleted without the token. The row stays `releasing` so
      // the sweep retries once somebody configures it, rather than being
      // forgotten with the database still there.
      return { released: false };
    }

    try {
      await deleteDatabase(config, binding.databaseId);
    } catch {
      // Left `releasing` deliberately. See the header: a failed delete must
      // not become a forgotten row.
      return { released: false };
    }

    await ctx.runMutation(internal.functions.fastSearch.forgetIndex, {
      workspaceId: args.workspaceId,
    });
    return { released: true };
  },
});
