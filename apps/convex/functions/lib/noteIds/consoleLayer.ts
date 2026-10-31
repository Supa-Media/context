/**
 * The id layer's hooks for the console's own file operations
 * (`filesFns/fileOperationBarrier.ts`, `scaffold/step.ts`).
 *
 * The gateway wraps an MCP session's store with `withIdLayout`; the console
 * builds its store here, in
 * Convex, and hands these hooks to `storeForBinding` as its `idLayout`, so the
 * layer is the gateway's own module and a read or a save from the app follows
 * exactly the rules an AI client's does. The control plane is asked directly
 * rather than over HTTP: each hook is the same internal function the gateway's
 * routes call.
 *
 * The hooks carry the keyed rows' answers (`notesFor`), their record, adopt and
 * retire.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

/** The hooks `storeForBinding` takes as `idLayout` (`apps/mcp/src/store/idLayout.js`). */
export type ConsoleIdLayoutHooks = {
  lookup: (paths: string[]) => Promise<{ keyed: boolean; notes: Record<string, unknown>; texHomes: Record<string, string> }>;
  wrote: (record: { path: string; key: string; etag: string; keyed?: boolean; size?: number; at?: number }) => Promise<unknown>;
  adopt: (note: { path: string; noteId: string; key: string; etag: string; size?: number; at: number }) => Promise<unknown>;
  removed: (note: { path: string; key: string; at: number }) => Promise<unknown>;
};

/**
 * The hooks for this workspace's store. Every workspace is keyed
 * (`notes-by-id.md`), so there is no store without them.
 */
export function consoleIdLayoutHooks(ctx: ActionCtx, workspaceId: Id<"workspaces">): ConsoleIdLayoutHooks {
  return {
    lookup: async (paths: string[]) => {
      const noted = await ctx.runQuery(internal.functions.noteIdsKeyed.notesFor, { workspaceId, paths });
      return {
        keyed: noted.keyed,
        notes: Object.fromEntries(noted.notes.map((entry) => [entry.path, entry])),
        texHomes: Object.fromEntries(noted.texHomes.map(({ path, owner }) => [path, owner])),
      };
    },
    wrote: async (record) =>
      await ctx.runMutation(internal.functions.noteIdsKeyed.recordKeyed, {
        workspaceId,
        path: record.path,
        key: record.key,
        etag: record.etag,
        ...(record.size === undefined ? {} : { size: record.size }),
        at: record.at ?? Date.now(),
      }),
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
