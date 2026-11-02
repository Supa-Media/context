/**
 * The person's chat with Tex, in their Download as folders: the one-to-one
 * chat's ledger, the one record of everything said and done in it (decided by
 * the owner, 2026-11-02; `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * The ledger lives in the person's Tex object, which only the gateway can
 * reach, so this reads it through the gateway's door (`lib/texStore.ts`) a
 * page at a time, oldest first, and the console writes it as one JSON file
 * (`apps/mobile/features/console/files/ledgerDownload.ts`). Owner only, as the
 * chat is theirs: anyone else is answered an empty, finished page.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { consoleTexBuckets } from "./lib/texStore";

/** Entries a page reads: a tool's result is cut at 64,000 characters, so a page stays well inside an action's answer. */
export const LEDGER_EXPORT_PAGE = 50;

const pageValidator = v.object({
  /** The ledger's manifest, as JSON, on every page (it is small). Null when there is no ledger. */
  manifest: v.union(v.null(), v.string()),
  /** This page's entries, each one line of JSON, oldest first. */
  lines: v.array(v.string()),
  /** The `seq` to read on from, or null at the end. */
  next: v.union(v.null(), v.number()),
});

type Page = typeof pageValidator.type;
const EMPTY: Page = { manifest: null, lines: [], next: null };

/** One page of the person's one-to-one chat ledger after `after`; an empty, finished page for anyone but an owner. */
export const readChatLedgerForExport = action({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.number()) },
  returns: pageValidator,
  handler: async (ctx, { workspaceId, after }): Promise<Page> => {
    const actorUserId = await callerId(ctx);
    try {
      await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
    } catch (error) {
      if (error instanceof ConvexError) return EMPTY;
      throw error;
    }
    const buckets = consoleTexBuckets(ctx, workspaceId);
    // A deployment that cannot reach the gateway has no Tex objects to read: said as a failure, never as an empty chat.
    if (buckets === null) throw new ConvexError({ code: "tex_store_unavailable" });
    const read = (await buckets(`person:${workspaceId}`).ledgerRead("texts", { ...(after === undefined ? {} : { after }), limit: LEDGER_EXPORT_PAGE })) as {
      manifest?: { count?: number } & Record<string, unknown>;
      entries?: unknown[];
      next?: number;
    };
    const entries = Array.isArray(read?.entries) ? read.entries : [];
    const manifest = read?.manifest && Number(read.manifest.count ?? 0) > 0 ? JSON.stringify(read.manifest) : null;
    return { manifest, lines: entries.map((entry) => JSON.stringify(entry)), next: Number.isSafeInteger(read?.next) ? (read.next as number) : null };
  },
});
