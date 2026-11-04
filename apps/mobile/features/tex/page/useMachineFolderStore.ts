import { useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { gatewayFolderStore, type MachineFolderStore } from "./thisMacFolders";

/** This Mac's folder store on the page's own console grant, or `null` until the person's workspaces are known. */
export function useMachineFolderStore(): MachineFolderStore | null {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const mint = useConsoleGrant();
  // Through a ref: the minter changes identity on every sign-in refresh, and the store should not.
  const minting = useRef(mint);
  minting.current = mint;
  const ids = (workspaces ?? [])
    .slice()
    .sort((a, b) => Number((b as { kind?: string }).kind === "personal") - Number((a as { kind?: string }).kind === "personal"))
    .map((w) => w.workspaceId as string);
  const key = ids.join(",");
  return useMemo(
    () =>
      key === ""
        ? null
        : gatewayFolderStore({
            endpoint: MCP_ENDPOINT,
            workspaceIds: key.split(","),
            token: async (workspaceId) => (await minting.current({ workspaceId: workspaceId as Id<"workspaces"> })).accessToken,
          }),
    [key],
  );
}
