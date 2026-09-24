/**
 * The handler for `cloudflare.getCloudflareSetupLink`.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";
import { apiTokenTemplateUrl, scopedTokenName, suggestBucketName } from "../cloudflare";

export async function getCloudflareSetupLinkHandler(
  ctx: QueryCtx,
  actorUserId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<{ url: string; suggestedBucket: string; accountIdRequired: boolean }> {
  const { workspace } = await requireWorkspaceRole(
    ctx,
    workspaceId,
    actorUserId,
    "owner",
  );
  const suggestedBucket = suggestBucketName(workspace.slug);
  return {
    url: apiTokenTemplateUrl({ name: scopedTokenName(suggestedBucket) }),
    suggestedBucket,
    accountIdRequired: true,
  };
}
