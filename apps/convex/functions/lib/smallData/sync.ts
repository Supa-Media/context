/**
 * A workspace's small data and its bucket, kept in step: the one place the
 * bucket's copies are touched (`nodesSmallData`, run inside the credential
 * barrier by `lib/nodes/run.ts`; never on a request path).
 *
 *  1. **Import, once.** Until a workspace's files have been read in, its
 *     readers answer from what Convex holds (possibly nothing yet) and never
 *     from the bucket. The first sync reads `.context/forwarding.json`,
 *     `.context/folder-icons.json` and the image store's `emoji-` objects
 *     and merges them in (`importing.ts`), never over a newer Convex value.
 *  2. **Export, after every change.** Each file the rows moved past is
 *     written from them, in its own format, so the customer's export, a
 *     hand-off and their own bucket keep the icons and the trail. Written,
 *     never read back: an edit made to either file outside the app is
 *     overwritten by the next change, as `privacy.md` is.
 *
 * An emoji has no file to export: its picture is written to the bucket
 * before its row (`emoji.ts`), so the bucket always holds every emoji the
 * rows name.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { FOLDER_ICONS_KEY, readFolderIcons, serializeFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { FORWARDING_PATH, parseForwarding, serializeForwarding } from "../../../../mcp/src/forwarding.js";
import type { FileStore } from "../fileOps/store";
import { listCustomEmoji } from "../fileOps/emoji";
import type { FoundSmallData } from "./importing";

/** What the bucket holds, read for the import. */
export async function readBucketSmallData(store: FileStore): Promise<FoundSmallData> {
  const ledger = await store.get(FORWARDING_PATH);
  const forwarding = ledger === null ? [] : (parseForwarding(await ledger.text()).entries as FoundSmallData["forwarding"]);
  const { icons } = await readFolderIcons(store as never);
  const emoji = await listCustomEmoji(store);
  return {
    forwarding,
    icons: Object.entries(icons).map(([path, icon]) => ({ path, icon })),
    emoji: emoji.map(({ name, leaf }) => ({ name, leaf })),
  };
}

/** One sync: the import where it has not run, then every owed file written. Answers whether it finished. */
export async function runSmallDataSync(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore): Promise<boolean> {
  try {
    let snapshot = await ctx.runQuery(internal.functions.smallData.snapshot, { workspaceId });
    if (!snapshot.imported) {
      const found = await readBucketSmallData(store);
      await ctx.runMutation(internal.functions.smallData.imported, { workspaceId, ...found, now: Date.now() });
      snapshot = await ctx.runQuery(internal.functions.smallData.snapshot, { workspaceId });
    }
    if (snapshot.forwarding !== null) {
      await store.put(FORWARDING_PATH, serializeForwarding({ version: 1, entries: snapshot.forwarding.entries }), {
        httpMetadata: { contentType: "application/json" },
      } as never);
    }
    if (snapshot.icons !== null) {
      const icons = Object.fromEntries(snapshot.icons.icons.map(({ path, icon }) => [path, icon]));
      await store.put(FOLDER_ICONS_KEY, serializeFolderIcons(icons));
    }
    await ctx.runMutation(internal.functions.smallData.exported, {
      workspaceId,
      ...(snapshot.forwarding === null ? {} : { forwarding: snapshot.forwarding.version }),
      ...(snapshot.icons === null ? {} : { icons: snapshot.icons.version }),
    });
    return true;
  } catch {
    // Paths and provider text stay out of the log; the next change or the cron tries again.
    console.error("smallData.sync_failed", { workspaceId });
    await ctx.runMutation(internal.functions.smallData.released, { workspaceId }).catch(() => {});
    return false;
  }
}
