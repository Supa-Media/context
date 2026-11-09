import { useMemo } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../../meetings/gateway";
import { MCP_ENDPOINT } from "../placeholderData";
import {
  objectCopy,
  objectDuplicate,
  objectMove,
  objectRestore,
  objectTrash,
  type ObjectCopyBody,
  type ObjectDuplicateBody,
  type ObjectMoveBody,
  type ObjectMoved,
  type ObjectRestoreBody,
  type ObjectTrashBody,
} from "./objectFileOps";

/**
 * The gateway routes for trash, restore, moves, copies and duplicates, with the console grant minted for
 * the workspace they act on. Each answers `null` when the caller should use the
 * Convex action instead (see `objectFileOps.ts`); the served check is read at
 * call time, from `objectServes`, so the answer is the one the object gave last.
 * `slugOf` names a workspace by its id, so each request is addressed to it
 * (`/@slug/files/...`); it must be stable across renders (a `useCallback`).
 */
export function useObjectMoves(slugOf: (workspaceId: string) => string | null = () => null) {
  const mintGrant = useConsoleGrant();
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  return useMemo(() => {
    const target = (workspaceId: string) => ({
      workspaceId,
      origin,
      slug: slugOf(workspaceId),
      mint: (rejected?: string) =>
        mintGrant({ workspaceId: workspaceId as Id<"workspaces"> }, rejected === undefined ? false : { rejected })
          .then((grant) => grant.accessToken),
    });
    return {
      trash: (workspaceId: string, body: ObjectTrashBody): Promise<ObjectMoved | null> => objectTrash(target(workspaceId), body),
      restore: (workspaceId: string, body: ObjectRestoreBody): Promise<ObjectMoved | null> => objectRestore(target(workspaceId), body),
      move: (workspaceId: string, body: ObjectMoveBody): Promise<ObjectMoved | null> => objectMove(target(workspaceId), body),
      copy: (workspaceId: string, body: ObjectCopyBody): Promise<ObjectMoved | null> => objectCopy(target(workspaceId), body),
      duplicate: (workspaceId: string, body: ObjectDuplicateBody): Promise<ObjectMoved | null> => objectDuplicate(target(workspaceId), body),
    };
  }, [mintGrant, origin, slugOf]);
}
