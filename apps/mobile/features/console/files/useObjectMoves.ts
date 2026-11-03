import { useMemo } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../../meetings/gateway";
import { MCP_ENDPOINT } from "../placeholderData";
import {
  objectMove,
  objectRestore,
  objectTrash,
  type ObjectMoveBody,
  type ObjectMoved,
  type ObjectRestoreBody,
  type ObjectTrashBody,
} from "./objectFileOps";

/**
 * The gateway routes for trash, restore and moves, with the console grant minted for
 * the workspace they act on. Each answers `null` when the caller should use the
 * Convex action instead (see `objectFileOps.ts`); the served check is read at
 * call time, from `objectServes`, so the answer is the one the object gave last.
 */
export function useObjectMoves() {
  const mintGrant = useConsoleGrant();
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  return useMemo(() => {
    const target = (workspaceId: string) => ({
      workspaceId,
      origin,
      mint: (rejected?: string) =>
        mintGrant({ workspaceId: workspaceId as Id<"workspaces"> }, rejected === undefined ? false : { rejected })
          .then((grant) => grant.accessToken),
    });
    return {
      trash: (workspaceId: string, body: ObjectTrashBody): Promise<ObjectMoved | null> => objectTrash(target(workspaceId), body),
      restore: (workspaceId: string, body: ObjectRestoreBody): Promise<ObjectMoved | null> => objectRestore(target(workspaceId), body),
      move: (workspaceId: string, body: ObjectMoveBody): Promise<ObjectMoved | null> => objectMove(target(workspaceId), body),
    };
  }, [mintGrant, origin]);
}
