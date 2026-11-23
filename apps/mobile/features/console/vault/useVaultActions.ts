import { useMemo } from "react";
import { useConvex } from "convex/react";
import { liveVaultActions } from "./liveVaultActions";
import type { VaultActions } from "./VaultList";

/** The vault calls for the open workspace, or `null` with none open (the demo, a visitor). */
export function useVaultActions(workspaceId: string | null): VaultActions | null {
  const client = useConvex();
  return useMemo(
    () => (client === undefined || workspaceId === null ? null : liveVaultActions(client, workspaceId)),
    [client, workspaceId],
  );
}
