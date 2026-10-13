/**
 * The privacy authority (`privacyAuthority.ts`) as the credential barrier
 * hands it to the store it opens (`apps/mcp/src/store/privacyAuthority.js`):
 * the rules read once per operation, and each change one internal mutation.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { HeldRules } from "./privacyAuthority";

type Rules = Pick<HeldRules, "folders" | "notes">;

export interface StorePrivacyAuthority {
  rules: HeldRules | null;
  write: (change: Rules & { expected: string | null }) => Promise<{ etag: string } | { current: HeldRules } | null>;
  written: (change: Rules & { previous: string | null; etag: string }) => Promise<void>;
  exported: (done: { rendered: string; etag: string | null }) => Promise<void>;
  owed: () => Promise<void>;
}

/** Only the two lists the authority keeps, whatever else a caller's object carries. */
const rulesOnly = (change: Rules): Rules => ({
  folders: change.folders.map((rule) => ({ prefix: rule.prefix, visibility: rule.visibility })),
  notes: change.notes.map((rule) => ({ path: rule.path, visibility: rule.visibility })),
});

export async function storePrivacyAuthority(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<StorePrivacyAuthority> {
  const rules = await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId });
  return {
    rules,
    write: (change) =>
      ctx.runMutation(internal.functions.nodesPrivacy.write, { workspaceId, expected: change.expected, ...rulesOnly(change) }),
    written: async (change) => {
      await ctx.runMutation(internal.functions.nodesPrivacy.written, {
        workspaceId,
        previous: change.previous,
        etag: change.etag,
        at: Date.now(),
        ...rulesOnly(change),
      });
    },
    exported: async (done) => {
      await ctx.runMutation(internal.functions.nodesPrivacy.exported, { workspaceId, ...done });
    },
    owed: async () => {
      await ctx.runMutation(internal.functions.nodesPrivacy.owed, { workspaceId });
    },
  };
}
