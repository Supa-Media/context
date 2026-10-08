import type { ReactAction } from "convex/react";
import type { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { MirrorActions } from "../../offline/useMirrorSync";
import type { BatchRead, ManifestPage } from "../../offline/mirrorSync";

/**
 * The mirror's two server calls, bound to the console's action handles.
 *
 * Every argument is passed on: a field dropped here never reaches the server,
 * which is how `source: "tree"` went unasked for and every sidebar walked the
 * bucket after the tree table shipped (2026-10-08). `mirrorActions.test.ts`
 * holds that line.
 *
 * Cast at this boundary and nowhere else: the validators type `visibility` as
 * a string where the console's `Visibility` is the narrower template type.
 */
export function mirrorActionsFor({
  syncManifestAction,
  readNotesAction,
}: {
  syncManifestAction: ReactAction<typeof api.functions.files.syncManifest>;
  readNotesAction: ReactAction<typeof api.functions.files.readNotes>;
}): MirrorActions {
  return {
    syncManifest: async ({ workspaceId, cursor, source }) =>
      (await syncManifestAction({
        workspaceId: workspaceId as Id<"workspaces">,
        ...(cursor === undefined ? {} : { cursor }),
        ...(source === undefined ? {} : { source }),
      })) as unknown as ManifestPage & { source?: "tree" | "bucket" },
    readNotes: async ({ workspaceId, paths }) =>
      (await readNotesAction({
        workspaceId: workspaceId as Id<"workspaces">,
        paths,
      })) as unknown as { results: BatchRead[] },
  };
}
