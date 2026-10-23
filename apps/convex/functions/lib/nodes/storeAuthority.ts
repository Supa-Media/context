/**
 * The access rules as the credential barrier hands them to the store it opens
 * (`apps/mcp/src/store/privacyAuthority.js`): the rows, rendered for the reader, read once per operation.
 */
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Audience } from "./rowAccess";

/** The rules a store judges by: the rows rendered for a member or a guest, with the rows' version. */
export interface HeldRules {
  etag: string;
  folders: { prefix: string; visibility: string }[];
  notes: { path: string; visibility: string }[];
  accessVersion: number;
}

export interface StorePrivacyAuthority {
  rules: HeldRules;
  /** One row's tier, set by the operation's own rule (`nodesAccess.setOperationTier`). */
  setAccess: (change: {
    path: string;
    base: string;
    expectedVersion?: number;
    kind?: string;
    grantees?: unknown;
  }) => Promise<{ ok: true; version: number } | { ok: false; code?: string }>;
}

/** `audience` is the caller's (`audienceOfNames`): a pin reader holds the rules a guest is judged by. */
export async function storePrivacyAuthority(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<StorePrivacyAuthority> {
  return {
    rules: await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience }),
    setAccess: async ({ path, base, expectedVersion, kind, grantees }) => {
      // A tier only: an operation never names people, and anything else is a caller's mistake.
      if (grantees !== undefined) return { ok: false, code: "INVALID" };
      if (base !== "private" && base !== "team" && base !== "inherit") return { ok: false, code: "INVALID" };
      if (kind !== undefined && kind !== "file" && kind !== "folder") return { ok: false, code: "INVALID" };
      return await ctx.runMutation(internal.functions.nodesAccess.setOperationTier, {
        workspaceId,
        path,
        base,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(kind === undefined ? {} : { kind }),
      });
    },
  };
}
