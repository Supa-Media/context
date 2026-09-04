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
  D1_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  createDatabase,
  databaseNameFor,
  deleteDatabase,
  exec,
  type D1Config,
} from "./lib/d1";

export const D1_TOKEN_SECRET = "SEARCH_D1_API_TOKEN";
export const D1_ACCOUNT_SECRET = "SEARCH_D1_ACCOUNT_ID";

/** Operator-facing sentences, one per code. Ours, from a closed set. */
const MESSAGES: Record<string, string> = {
  NOT_CONFIGURED:
    "Fast search is not configured on this deployment yet. An administrator needs to set SEARCH_D1_API_TOKEN and SEARCH_D1_ACCOUNT_ID.",
  UNAUTHORIZED:
    "The configured Cloudflare token was refused. It needs D1:Edit on the account in SEARCH_D1_ACCOUNT_ID.",
  NOT_FOUND: "The search database could not be found.",
  RATE_LIMITED: "Cloudflare is rate limiting this account. This will retry.",
  UNAVAILABLE: "Cloudflare could not be reached. This will retry.",
  REFUSED: "Cloudflare refused to create the search database.",
};

function messageFor(code: string): string {
  return MESSAGES[code] ?? MESSAGES.REFUSED;
}

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
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const binding = await ctx.runQuery(
      internal.functions.fastSearch.bindingForWorkspace,
      { workspaceId: args.workspaceId },
    );
    // Opted out, or never opted in, between the schedule and now. Nothing to
    // do, and creating a database here would be creating one nobody asked for.
    if (binding === null || !binding.optedIn) return { status: "skipped" };

    const config = await configFor(ctx);
    if (config === null) {
      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
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
            status: "provisioning",
            databaseId,
            databaseName,
          },
        );
      }

      await exec(config, databaseId, SCHEMA_STATEMENTS);

      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
        status: "backfilling",
        databaseId,
        databaseName,
        schemaVersion: D1_SCHEMA_VERSION,
        notesIndexed: 0,
      });
      return { status: "backfilling" };
    } catch (error) {
      const code = error instanceof D1Error ? error.code : "REFUSED";
      await ctx.runMutation(internal.functions.fastSearch.recordProvisionResult, {
        workspaceId: args.workspaceId,
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
