/**
 * The id layer's hooks for the console's own file operations
 * (`filesFns/fileOperationBarrier.ts`, `scaffold/step.ts`).
 *
 * The gateway wraps an MCP session's store with `withIdLayout` while staff
 * have switched reads to the id copies; the console builds its store here, in
 * Convex, and hands these hooks to `storeForBinding` as its `idLayout`, so the
 * layer is the gateway's own module and a read or a save from the app follows
 * exactly the rules an AI client's does. The control plane is asked directly
 * rather than over HTTP: each hook is the same internal function the gateway's
 * routes call.
 *
 * `null` while the switch is at paths, so the store is built exactly as it was
 * before ids. `ids` carries the copy's lookup and record; `keys` also carries the
 * keyed rows' answers (`notesFor`) and their adopt and retire.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

/** The hooks `storeForBinding` takes as `idLayout` (`apps/mcp/src/store/idLayout.js`). */
export type ConsoleIdLayoutHooks =
  | {
      mode: "ids";
      lookup: (paths: string[]) => Promise<{ copies: Record<string, unknown> }>;
      wrote: (record: { path: string; key: string; etag: string; keyEtag?: string }) => Promise<unknown>;
    }
  | {
      mode: "keys";
      lookup: (paths: string[]) => Promise<{ copies: Record<string, unknown>; keyed: boolean; notes: Record<string, unknown> }>;
      wrote: (record: {
        path: string;
        key: string;
        etag: string;
        keyEtag?: string;
        keyed?: boolean;
        size?: number;
        at?: number;
      }) => Promise<unknown>;
      adopt: (note: { path: string; noteId: string; key: string; etag: string; size?: number; at: number }) => Promise<unknown>;
      removed: (note: { path: string; key: string; at: number }) => Promise<unknown>;
    };

/** The hooks for this workspace's store, or `null` while the switch is at paths. */
export async function consoleIdLayoutHooks(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<ConsoleIdLayoutHooks | null> {
  const layout = await ctx.runQuery(internal.functions.noteIds.idLayout, {});
  if (layout === null) return null;
  const copies = {
    lookup: async (paths: string[]) => {
      const found = await ctx.runQuery(internal.functions.noteIds.copiesFor, { workspaceId, paths });
      return { copies: Object.fromEntries(found.map(({ path, key, etag, keyEtag, fresh }) => [path, { key, etag, keyEtag, fresh }])) };
    },
    wrote: async ({ path, key, etag, keyEtag }: { path: string; key: string; etag: string; keyEtag?: string }) =>
      await ctx.runMutation(internal.functions.noteIds.recordCopy, {
        workspaceId,
        path,
        key,
        etag,
        ...(keyEtag === undefined ? {} : { keyEtag }),
      }),
  };
  if (layout === "ids") return { mode: "ids", lookup: copies.lookup, wrote: copies.wrote };
  return {
    mode: "keys",
    lookup: async (paths: string[]) => {
      const noted = await ctx.runQuery(internal.functions.noteIdsKeyed.notesFor, { workspaceId, paths });
      return {
        copies: {},
        keyed: noted.keyed,
        notes: Object.fromEntries(noted.notes.map((entry) => [entry.path, entry])),
      };
    },
    wrote: async (record) => {
      if (record.keyed !== true) return await copies.wrote(record);
      return await ctx.runMutation(internal.functions.noteIdsKeyed.recordKeyed, {
        workspaceId,
        path: record.path,
        key: record.key,
        etag: record.etag,
        ...(record.size === undefined ? {} : { size: record.size }),
        at: record.at ?? Date.now(),
      });
    },
    adopt: async (note) =>
      await ctx.runMutation(internal.functions.noteIdsKeyed.adoptKeyed, {
        workspaceId,
        path: note.path,
        noteId: note.noteId,
        key: note.key,
        etag: note.etag,
        ...(note.size === undefined ? {} : { size: note.size }),
        at: note.at,
      }),
    removed: async (note) =>
      await ctx.runMutation(internal.functions.noteIdsKeyed.removeKeyed, {
        workspaceId,
        path: note.path,
        key: note.key,
        at: note.at,
      }),
  };
}
