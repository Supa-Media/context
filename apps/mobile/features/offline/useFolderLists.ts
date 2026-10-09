import { useEffect, useMemo, useRef } from "react";
import { useAction, useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { announceBucketWrite } from "../console/files/bucketWrites";
import { capabilitiesForRole } from "../console/capabilities";
import { folderListSource, type ListWriteBack } from "./folderListSource";
import { neededEtags } from "./mirrorHolds";
import { openMirrorStore } from "./mirrorStore";
import { openStore } from "./store";
import { useReachability } from "./reachability";
import { MANIFEST_TIMEOUT_MS, READ_TIMEOUT_MS, withTimeout } from "./useMirrorSync";
import type { FolderListSource } from "../console/files/listBlock/model";
import { visibilityTierForRole } from "../console/visibility";
import { DEFAULT_AGENTS } from "../console/files/folderPage/agents";
import { matchingAgents } from "../console/files/folderPage/useAgents";

/**
 * Where the console's folder lists read their notes: the server while there is
 * a connection (`syncManifest` for one folder, then `readNotes`), and this
 * device's copy of the workspace only offline, at the clearance its role gives
 * — `useDeviceSearch`'s rule. A browser has no copy, so it always asks the
 * server. `undefined` for a role with no clearance, and the lists stay as
 * source.
 *
 * A list redraws after its own writes, after any announced bucket write, and
 * whenever the mirror commits a new listing or new bodies.
 *
 * An owner or editor can also change a listed note's status or owner from the
 * list: `setProperty` reads the note from the bucket, changes that one line and
 * writes it back against the version read, then puts the note it wrote back
 * into this device's copy so the list — and the next reload — reads what was
 * saved. `folderListSource` carries the whole road; this hook only hands it
 * the Convex actions. A folder page may ask for the note to be created
 * (`create`), for a folder whose first property has nowhere to go yet.
 *
 * An owner is picked, never typed: `searchOwners` asks the control plane for
 * the workspace's people matching what was typed; agents are a short list of
 * names the workspace keeps in its notes, not its connected clients.
 */
export function useFolderLists(
  workspaceId: string | null | undefined,
  role: string | undefined,
): (FolderListSource & ListWriteBack) | undefined {
  const tier = visibilityTierForRole(role);
  const readNote = useAction(api.functions.files.readNote);
  const readNotes = useAction(api.functions.files.readNotes);
  const syncManifest = useAction(api.functions.files.syncManifest);
  // Read at load time, not render time, so going offline does not rebuild the source.
  const reachability = useReachability();
  const offline = useRef(reachability === "offline");
  useEffect(() => {
    offline.current = reachability === "offline";
  }, [reachability]);
  const writeNote = useAction(api.functions.files.writeNote);
  const canEdit = capabilitiesForRole(role).canEdit;
  const convex = useConvex();
  return useMemo(() => {
    if (workspaceId == null || tier === "unknown") return undefined;
    const id = workspaceId as Id<"workspaces">;
    const source = folderListSource({
      workspaceId,
      scope: tier,
      canEdit,
      openMirror: openMirrorStore,
      needed: (workspace) => neededEtags(openStore(), workspace),
      online: () => !offline.current,
      io: {
        readNote: (path) => readNote({ workspaceId: id, path }),
        manifest: (folder, cursor) =>
          withTimeout(
            // The tree table where it can answer, as the sidebar's walk does.
            syncManifest({ workspaceId: id, folder, source: "tree", ...(cursor === undefined ? {} : { cursor }) }),
            MANIFEST_TIMEOUT_MS,
          ),
        readNotes: async (paths) =>
          (await withTimeout(readNotes({ workspaceId: id, paths, plain: true }), READ_TIMEOUT_MS)).results,
        writeNote: async (path, text, expectedEtag) => {
          // No version is a create, which the server refuses over an existing note.
          const written = await writeNote({
            workspaceId: id,
            path,
            text,
            ...(expectedEtag === undefined ? {} : { expectedEtag }),
          });
          // The file browser's listing is told, as every write outside it does.
          announceBucketWrite({ workspaceId, path: written.path });
          return written;
        },
      },
    });
    // Any member reads the owner column, so any member may ask what old owner words name.
    const resolveOwners = (words: readonly string[]) =>
      convex.query(api.functions.owners.resolveOwners, { workspaceId: id, words: [...words] });
    if (!canEdit) return { ...source, resolveOwners };
    return {
      ...source,
      resolveOwners,
      // People from the server; agents are the workspace's own list, which a
      // folder page lays over these defaults (`folderPage/agents.ts`).
      searchOwners: async (query: string, prefer: readonly string[]) => ({
        ...(await convex.query(api.functions.owners.searchOwners, { workspaceId: id, query, prefer: [...prefer] })),
        agents: matchingAgents(DEFAULT_AGENTS, query),
      }),
      suggestOwner: async (path: string, prefer: readonly string[], agents?: readonly string[]) =>
        (
          await convex.action(api.functions.owners.suggestOwner, {
            workspaceId: id,
            path,
            prefer: [...prefer],
            agents: [...(agents ?? DEFAULT_AGENTS)],
          })
        )?.value ?? null,
    };
  }, [workspaceId, tier, canEdit, readNote, readNotes, syncManifest, writeNote, convex]);
}
