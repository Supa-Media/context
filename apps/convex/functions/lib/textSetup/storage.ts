/**
 * The storage a workspace set up by text starts with (`functions/textSetup.ts`):
 * what "Start fresh" gives in the app, a bucket we run, wherever this
 * deployment offers one at no charge. Elsewhere nothing is started, and Tex
 * sends the person to the app to connect storage of their own.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { startManagedMoveIfChosen } from "../billing/managedMove";
import { deploymentOffersFreeManaged, planFor, statusOf } from "../billing/plan";
import { freeManagedRefusal, startFreeManagedHandler } from "../billing/freeManaged";
import { planIsPaying } from "../premium";

/** The texting client's id (`textLinks.TEXTS_CLIENT_ID`), here to keep this free of that module. */
const TEXTS_CLIENT = "context_texts";

/**
 * Start the bucket, and leave a `layout` row so its first verification lays
 * out the five starting folders (`layout.ts`). `true` when a bucket is on the
 * way. Never throws for a refusal: the workspace is made either way.
 */
export async function startTextedStorage(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  if (!deploymentOffersFreeManaged()) return false;
  const plan = await planFor(ctx, workspaceId);
  let started = false;
  if (plan !== null && planIsPaying(statusOf(plan))) {
    // Already Premium (a founding account): choosing our storage on a paying
    // plan is what starts the bucket, as pressing the card does in the app.
    await ctx.db.patch(plan._id, { managedStorage: true, updatedAt: Date.now() });
    const current = await planFor(ctx, workspaceId);
    started = current !== null && (await startManagedMoveIfChosen(ctx, current));
  } else if ((await freeManagedRefusal(ctx, workspaceId, plan)) === null) {
    await startFreeManagedHandler(ctx, userId, workspaceId);
    started = true;
  }
  if (!started) return false;
  await ctx.db.insert("textSetups", { stage: "layout", userId, workspaceId, at: Date.now() });
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: userId,
    actorClientId: TEXTS_CLIENT,
    action: "texts.setup.storage_started",
    details: {},
  });
  return true;
}
