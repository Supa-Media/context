import type { ObjectTree, ObjectTreeOptions } from "../console/files/fileBrowser/objectTree";

/**
 * Each workspace's change signal from its own object, for a device that keeps a copy (`useNodeFeed.ts`).
 *
 * One tree socket per workspace (`objectTree.ts`), watching no folder and asking only for the head
 * (`apps/mcp/src/workspaceStore/treeHead.js`): a digest of what this person may see there, pushed by the object
 * when it moves. A workspace whose object answers is "served" and its head is the object's; one that says it does
 * not serve (not on its object, or the gateway cannot reach it) is left to the control plane's change log, as before.
 * Decided by the owner, 2026-11-06: nothing about a note waits on the control plane, and the object pushes changes
 * rather than anybody polling for them (`docs/decisions/storage-and-credentials/no-convex-for-notes.md`).
 */
export interface ObjectHeads {
  /** The workspaces to follow; sockets for any others are closed. */
  follow(workspaceIds: readonly string[]): void;
  close(): void;
}

export type OpenTree = (options: Pick<ObjectTreeOptions, "head" | "onHead" | "onServed" | "onListing"> & { workspaceId: string }) => ObjectTree;

/** The prefix a head from an object carries, so it never equals a control-plane token. */
export const OBJECT_HEAD = "object:";

/**
 * @param open opens one workspace's tree socket (the grant and the gateway are the caller's)
 * @param changed called with every workspace's object head, `null` while it is not served by its object
 */
export function objectHeads(open: OpenTree, changed: (workspaceId: string, head: string | null) => void): ObjectHeads {
  const sockets = new Map<string, ObjectTree>();
  return {
    follow(workspaceIds) {
      const wanted = new Set(workspaceIds);
      for (const [workspaceId, tree] of sockets) {
        if (wanted.has(workspaceId)) continue;
        tree.close();
        sockets.delete(workspaceId);
        changed(workspaceId, null);
      }
      for (const workspaceId of wanted) {
        if (sockets.has(workspaceId)) continue;
        const tree = open({
          workspaceId,
          head: true,
          onHead: (token) => changed(workspaceId, `${OBJECT_HEAD}${token}`),
          onServed: (served) => {
            if (!served) changed(workspaceId, null);
          },
          onListing: () => {},
        });
        tree.watch([]);
        sockets.set(workspaceId, tree);
      }
    },
    close() {
      for (const tree of sockets.values()) tree.close();
      sockets.clear();
    },
  };
}
