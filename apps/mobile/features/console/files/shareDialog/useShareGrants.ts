import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { grantProblem, type GrantList, type GrantWrite } from "./grants";

/** What the share dialog is handed to edit one row's list. See `grants.ts`. */
export interface ShareGrants {
  list: GrantList;
  /** Writes a list and its base. Answers once it lands: a sentence to show, or `null`. */
  save: (write: GrantWrite, expectedVersion: number) => Promise<string | null>;
  /** True while a write is on its way, so the list does not take a second press as a first. */
  saving: boolean;
}

/**
 * The owner's list for one path, live, and the one way to change it. `undefined` while it loads, for anybody
 * who is not an owner, outside rows mode, and with no workspace: the dialog then draws what it drew before
 * lists existed.
 */
export function useShareGrants(workspaceId: string | null, path: string): ShareGrants | undefined {
  const list = useQuery(
    api.functions.nodesAccess.shareList,
    workspaceId === null ? "skip" : { workspaceId: workspaceId as Id<"workspaces">, path },
  );
  const setGrantees = useMutation(api.functions.nodesAccess.setGrantees);
  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (write: GrantWrite, expectedVersion: number): Promise<string | null> => {
      if (workspaceId === null) return grantProblem("NOT_FOUND");
      setSaving(true);
      try {
        const answer = await setGrantees({
          workspaceId: workspaceId as Id<"workspaces">,
          path,
          base: write.base,
          grantees: write.grantees,
          expectedVersion,
        });
        return answer.ok ? null : grantProblem(answer.code);
      } catch {
        return grantProblem("UNKNOWN");
      } finally {
        setSaving(false);
      }
    },
    [path, setGrantees, workspaceId],
  );
  if (list === undefined || list === null) return undefined;
  return { list, save, saving };
}
