/**
 * The test chat's way to the gateway: the person's own console grant for `/tex-lab/sandbox` (`engine/sandbox.ts`).
 * Its own module so a view test can stand it in for one line.
 */
import { useQuery } from "convex/react";
import { useMemo, useRef } from "react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../../../console/placeholderData";
import { gatewaySandbox, setSandboxCall } from "../../engine/sandbox";

/** The person's own grant for the gateway's test chat route. */
export function useSandboxCall() {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const id = workspaces?.find((w) => w.kind === "personal" && w.role === "owner")?.workspaceId ?? null;
  useMemo(() => setSandboxCall(id === null ? null : gatewaySandbox(MCP_ENDPOINT, async (refresh) => (await minting.current({ workspaceId: id as Id<"workspaces"> }, refresh)).accessToken)), [id]);
  return id !== null;
}

