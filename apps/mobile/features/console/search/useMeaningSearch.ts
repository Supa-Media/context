import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { MeaningSearchStatus } from "./meaningSearch";

/**
 * Search by meaning's status and the owner's switch, for the Settings card.
 * `set` is absent unless the server said `canChange`, the rule `useFastSearch`
 * follows: nobody is offered a press whose only outcome is a refusal.
 */
export interface MeaningSearchView {
  status: MeaningSearchStatus | undefined;
  set?: (on: boolean) => Promise<void>;
}

export function useMeaningSearch(options: { workspaceId: Id<"workspaces"> | null }): MeaningSearchView {
  const status = useQuery(
    api.functions.meaningSearch.status,
    options.workspaceId === null ? "skip" : { workspaceId: options.workspaceId },
  ) as MeaningSearchStatus | undefined;
  const mutate = useMutation(api.functions.meaningSearch.set);
  const workspaceId = options.workspaceId;
  return {
    status,
    ...(status?.canChange === true && workspaceId !== null
      ? {
          set: async (on: boolean) => {
            await mutate({ workspaceId, on });
          },
        }
      : {}),
  };
}
