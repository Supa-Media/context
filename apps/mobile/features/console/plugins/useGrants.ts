import { useCallback, useMemo } from "react";
import { useAction, useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import type { GrantsView, PluginCapability, PluginGrant } from "./grants";

/**
 * What each plugin in this context has been allowed to do.
 *
 * A subscription, unlike the inventory beside it — and the difference is not an
 * inconsistency. `listPluginGrants` is a Convex **query** over rows the control
 * plane already holds: it costs one subscription and nothing in the customer's
 * bucket, and it has to be live, because a Revoke somebody presses here must
 * stop reading as "Approved" in the same frame. `listObsidianPlugins` is an
 * action that opens every bundle in the bucket, which is why that one is a scan
 * you ask for and this one is not.
 *
 * Owner-only, decided from `role` before any call — `listPluginGrants`,
 * `approvePlugin` and `revokePlugin` are all `requireOwner` on the backend, so
 * an empty spec for anyone else is the same rule `useShares` follows.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useGrants(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
}): GrantsView {
  const { workspaceId, role } = options;
  const isOwner = role === "owner";
  const convex = useConvex();
  const approveAction = useAction(api.functions.obsidianPlugins.approvePlugin);

  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return {
      grants: { query: api.functions.obsidianPlugins.listPluginGrants, args: { workspaceId } },
      /*
        A fact about the deployment, subscribed rather than fetched once: the
        egress service can be configured (or its Cloudflare token fixed) while
        somebody has this pane open, and the network tickbox should appear
        without a reload.
      */
      capabilities: {
        query: api.functions.obsidianPlugins.pluginRuntimeCapabilities,
        args: { workspaceId },
      },
    };
  }, [workspaceId, isOwner]);

  const results = useQueries(spec);
  const raw = results.grants;
  /*
    `undefined` while the subscription is in flight, and an `Error` when it
    threw — `useQueries`, never `useQuery`, so a thrown query does not take the
    console down. Both are "we do not know yet" here, and `grants` stays absent
    rather than becoming an empty array: an empty array is the claim that this
    context has approved nothing, which is a different sentence.
  */
  const grants = raw === undefined || raw instanceof Error ? undefined : (raw as PluginGrant[]);
  const capabilities = results.capabilities;
  /*
    False for every answer that is not an explicit `true` — in flight, thrown,
    or absent. Offering the network tickbox a moment early and withdrawing it is
    worse than offering it a moment late, and an unanswered query is not a
    deployment that has egress.
  */
  const egress =
    capabilities !== undefined &&
    !(capabilities instanceof Error) &&
    (capabilities as { egress?: unknown }).egress === true;

  const approve = useCallback(
    async (input: {
      pluginId: string;
      bundleFingerprint: string;
      capabilities: PluginCapability[];
      networkHosts: string[];
    }) => {
      if (workspaceId === null) return;
      /*
        `networkHosts` is passed through exactly as the form chose it, and the
        form can only choose from the hosts the scan read. The server checks
        that again — `approvePlugin` accepts only detected hosts, and refuses a
        network capability without hosts or hosts without the capability — so
        this is the client stating an intent rather than the client being
        trusted with one.
      */
      await approveAction({
        workspaceId,
        pluginId: input.pluginId,
        bundleFingerprint: input.bundleFingerprint,
        capabilities: input.capabilities,
        networkHosts: input.networkHosts,
      });
    },
    [approveAction, workspaceId],
  );

  const revoke = useCallback(
    async (pluginId: string) => {
      if (workspaceId === null) return;
      await convex.mutation(api.functions.obsidianPlugins.revokePlugin, { workspaceId, pluginId });
    },
    [convex, workspaceId],
  );

  return {
    grants,
    egress,
    loading: isOwner && workspaceId !== null && raw === undefined,
    // Absent — the whole object — for anyone the server would refuse, the rule
    // `StorageActions` states and every owner-only view here follows.
    actions: isOwner && workspaceId !== null ? { approve, revoke } : undefined,
  };
}
