import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

/**
 * The person's connected accounts that AI cannot read yet: empty until AI
 * access to Google runs through its own client, then each account until its
 * owner allows it (functions/googleClientsAccess.ts).
 */
export function useGoogleAiAccessNeeded(workspaceId: string): ReadonlySet<string> {
  const rows = useQuery(api.functions.googleClientsAccess.myGoogleAiAccess, {
    workspaceId: workspaceId as Id<"workspaces">,
  });
  if (!Array.isArray(rows)) return NONE;
  return new Set(rows.filter((row) => row.aiAccess === "needed").map((row) => row.connectionId as string));
}

const NONE: ReadonlySet<string> = new Set();
