/**
 * A workspace's access rules, as the gateway and the console hold them: the tree's rows (`nodes`, `nodeAccess`),
 * rendered for an audience (`lib/nodes/readerRules.ts`). There is no `privacy.md` to read or write.
 *
 * Internal only. The console reaches these through the credential barrier, which wraps the store it opens
 * (`apps/mcp/src/store/privacyAuthority.js`), and the gateway through `/gateway/privacy`, which checks the
 * person's token first.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { refreshSnapshot } from "./lib/nodes/accessBackfill";
import { accessVersionOf } from "./lib/nodes/accessRows";
import { privacyEtagOf, rulesForReaders } from "./lib/nodes/readerRules";
import type { Audience } from "./lib/nodes/rowAccess";
import { INDEX_KEY } from "./lib/scaffold/store";
import { nodeAt } from "./lib/nodes/paths";
import { chatRules } from "./lib/nodes/chatFolders";

const folders = v.array(v.object({ prefix: v.string(), visibility: v.string() }));
const notes = v.array(v.object({ path: v.string(), visibility: v.string() }));
/** Who the rules are rendered for: a member, or a guest (a pin reader, `lib/pinnedReaders.ts`). Member when absent. */
const audienceValidator = v.union(v.literal("member"), v.literal("guest"));
/** The paths a Tex guest chat holds only to view (`lib/nodes/chatFolders.ts`): read, never changed. */
const readOnlyValidator = v.object({ folders: v.array(v.string()), notes: v.array(v.string()) });
const heldValidator = v.object({ etag: v.string(), folders, notes, accessVersion: v.number(), readOnly: v.optional(readOnlyValidator) });

/** The rules as the gateway holds them: rendered from the rows for a member (or a guest), with the rows' version. */
async function heldFor(
  ctx: Parameters<typeof rulesForReaders>[0],
  workspaceId: Id<"workspaces">,
  audience: Audience,
  chatNames?: readonly string[],
) {
  const guest = await rulesForReaders(ctx, workspaceId, chatNames === undefined ? audience : "guest");
  // A Tex guest chat holds the guest rules read for it: its rows `team`, the rest `private` (`chatFolders.ts`).
  const chat = chatNames === undefined ? null : chatRules(guest, chatNames);
  const rendered = chat ?? guest;
  return {
    etag: await privacyEtagOf(ctx, workspaceId),
    folders: rendered.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
    notes: [...rendered.overrides].map(([path, visibility]) => ({ path, visibility })),
    accessVersion: await accessVersionOf(ctx, workspaceId),
    ...(chat !== null ? { readOnly: chat.readOnly } : {}),
  };
}

/** The rules the gateway holds for a workspace, rendered for an audience. */
export const authority = internalQuery({
  args: { workspaceId: v.id("workspaces"), audience: v.optional(audienceValidator), chatNames: v.optional(v.array(v.string())) },
  returns: heldValidator,
  handler: async (ctx, { workspaceId, audience, chatNames }) => await heldFor(ctx, workspaceId, audience ?? "member", chatNames),
});

/** The rules Convex readers judge by (`lib/nodes/readerRules.ts`), as plain values a query can return. */
export const readerRules = internalQuery({
  args: { workspaceId: v.id("workspaces"), audience: v.optional(audienceValidator) },
  returns: v.object({
    rules: v.array(v.object({ prefix: v.string(), vis: v.string() })),
    overrides: v.array(v.object({ path: v.string(), vis: v.string() })),
  }),
  handler: async (ctx, { workspaceId, audience }) => {
    const held = await rulesForReaders(ctx, workspaceId, audience ?? "member");
    return {
      rules: held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis })),
      overrides: [...held.overrides].map(([path, vis]) => ({ path, vis })),
    };
  },
});

/** How many times a new workspace's rows are looked for, and how far apart: rows come with the first tree listing. */
const SCAFFOLD_DEFAULTS_TRIES = 40;
const SCAFFOLD_DEFAULTS_RETRY_MS = 15_000;

/**
 * A new context's folders take the access their scaffold gives them, once its rows exist (scheduled by
 * `lib/scaffold/step.ts`): `team` in a shared context, `private` in a personal one, and a shared context's
 * `index.md` with them. It runs once
 * (`nodeAccessState.scaffoldDerived`), and only on rows no owner has decided (a base of its own, or a grant made
 * by hand), so an owner's write that came first is kept. INTERNAL.
 */
export const scaffoldFolderDefaults = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    folders: v.array(v.string()),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, kind, folders: paths, attempt }): Promise<null> => {
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (state?.scaffoldDerived === true) return null;
    const anyRow = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .first();
    if (anyRow === null) {
      if (attempt < SCAFFOLD_DEFAULTS_TRIES) {
        await ctx.scheduler.runAfter(SCAFFOLD_DEFAULTS_RETRY_MS, internal.functions.nodesPrivacy.scaffoldFolderDefaults, {
          workspaceId,
          kind,
          folders: paths,
          attempt: attempt + 1,
        });
      }
      return null;
    }
    const base = kind === "shared" ? "team" : "private";
    // A shared context's `index.md` is its front page, the first thing a member's client reads, and it sits at
    // the root where no folder default reaches: it is opened to the workspace by name, as the scaffold always did.
    const targets = kind === "shared" ? [...paths, INDEX_KEY] : paths;
    for (const path of targets) {
      const row = await nodeAt(ctx.db, workspaceId, path);
      if (row === null || row.access !== undefined) continue;
      const grants = await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", row._id))
        .collect();
      if (grants.some((grant) => grant.source !== "privacy.md")) continue;
      await ctx.db.patch(row._id, { access: { base } });
    }
    await refreshSnapshot(ctx, workspaceId);
    const after = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (after !== null) await ctx.db.patch(after._id, { scaffoldDerived: true });
    return null;
  },
});
