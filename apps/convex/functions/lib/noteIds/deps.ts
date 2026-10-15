/**
 * The production seams of the id copy's two chains (`copyPass.ts`,
 * `checkPass.ts`): the mover when one is configured, and the bucket through its
 * own credential here otherwise. Kept out of `functions/noteIdsCopy.ts`, which
 * only the two actions that run a chain reach, so no other function of that
 * module is read as reaching a credential.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { runIdCheckPage, runIdCopyPage } from "../../../../mcp/src/moves/idCopyPage.js";
import type { GatewayCredential } from "../storage/shapes";
import { storageMoverOrigin } from "../storageMover";
import type { CheckDeps } from "./checkPass";
import type { CopyDeps } from "./copyPass";

async function credentialOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<GatewayCredential | null> {
  return (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
}

export function productionDeps(): { copy: CopyDeps; check: CheckDeps } {
  const origin = storageMoverOrigin();
  return {
    copy: { origin, credential: credentialOf, copyHere: (page) => runIdCopyPage(page) },
    check: { origin, credential: credentialOf, checkHere: (page) => runIdCheckPage(page) },
  };
}
