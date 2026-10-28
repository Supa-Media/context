import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

/**
 * Accounts the person can allow AI access for, by connection
 * (functions/googleClientsAccess.ts): `available` once the agent client is
 * set up and before AI is switched onto it (an optional, per-account move),
 * `needed` after the switch, when AI cannot read the account without it.
 */
export type GoogleAiAsk = "available" | "needed";

export function useGoogleAiAccess(workspaceId: string): ReadonlyMap<string, GoogleAiAsk> {
  const rows = useQuery(api.functions.googleClientsAccess.myGoogleAiAccess, {
    workspaceId: workspaceId as Id<"workspaces">,
  });
  const asks = new Map<string, GoogleAiAsk>();
  if (!Array.isArray(rows)) return asks;
  for (const row of rows) {
    if (row.aiAccess === "available" || row.aiAccess === "needed") asks.set(row.connectionId as string, row.aiAccess);
  }
  return asks;
}
