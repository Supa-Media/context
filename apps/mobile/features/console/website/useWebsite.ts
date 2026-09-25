import { useMemo } from "react";
import { useAction, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { WebsiteStateView } from "@context/shared";
import { EMPTY_QUERY_SPEC } from "../querySpec";

export interface WebsiteActions {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export interface WebsiteCardView {
  state: WebsiteStateView | undefined;
  failed: boolean;
  /** Absent, as a whole object, for anybody the server did not let manage it. */
  actions?: WebsiteActions;
}

/**
 * The Website switch for one workspace: the server's lifecycle view, and the
 * two calls that change it — handed out only when the view says `canManage`,
 * so a member sees the state and no control, as every other settings card.
 *
 * Subscribed, so turning it on from another tab or device changes this card
 * in place.
 */
export function useWebsite(workspaceId: string | null): WebsiteCardView {
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null) return EMPTY_QUERY_SPEC;
    return {
      state: {
        query: api.functions.workspaces.getWebsiteState,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      },
    };
  }, [workspaceId]);
  const result = useQueries(spec).state as WebsiteStateView | Error | undefined;
  const enable = useAction(api.functions.workspaces.enableWebsite);
  const disable = useMutation(api.functions.workspaces.disableWebsite);

  const state = result instanceof Error ? undefined : result;
  const actions = useMemo<WebsiteActions | undefined>(() => {
    if (workspaceId === null || state?.canManage !== true) return undefined;
    const args = { workspaceId: workspaceId as Id<"workspaces"> };
    return {
      enable: async () => {
        await enable(args);
      },
      disable: async () => {
        await disable(args);
      },
    };
  }, [workspaceId, state?.canManage, enable, disable]);

  return { state, failed: result instanceof Error, actions };
}
