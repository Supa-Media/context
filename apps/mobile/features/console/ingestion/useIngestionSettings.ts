/**
 * The live ingestion settings, wired to the control plane — when it has them.
 *
 * The backend contract is
 *
 *   getIngestionSettings({ workspaceId })
 *     -> { address, targetFolder, allowedSenders, allowedDomains, allowAnySender } | null
 *   updateIngestionSettings({ workspaceId, targetFolder?, allowedSenders?, … })
 *
 * and it is being built in parallel with this screen. So the lookup is by name
 * at runtime rather than through the generated `api` types: if the deployment
 * has no `functions/ingestion` module, `available` comes back false and the
 * card says the address is not configurable yet instead of throwing on a
 * missing function reference. A `null` result is a different thing again — the
 * module exists but this context has no alias issued — and both are states the
 * UI has to be able to draw.
 *
 * `save` is absent, not disabled, for anyone who cannot use it. Same rule as
 * `StorageActions`: a control that is never offered cannot mislead.
 */

import { useCallback, useMemo } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import type { IngestionPatch, IngestionSettings, IngestionState } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRef = FunctionReference<any, any, any, any>;

/** The `functions/ingestion` module, if this deployment has one. */
function ingestionModule(): Record<string, AnyRef | undefined> | undefined {
  const modules = api.functions as unknown as Record<
    string,
    Record<string, AnyRef | undefined> | undefined
  >;
  return modules.ingestion;
}

export function useIngestionSettings(options: {
  workspaceId: string | null;
  /** Only an owner may change these, the same as the storage binding. */
  canEdit: boolean;
}): IngestionState {
  const convex = useConvex();
  const module = ingestionModule();
  const getRef = module?.getIngestionSettings;
  const updateRef = module?.updateIngestionSettings;
  const { workspaceId, canEdit } = options;

  // `useQueries` takes a spec that may be empty, which is what lets this
  // subscribe conditionally without a conditional hook.
  //
  // **`workspaceId` is the only dependency, and that is load-bearing.** This
  // memo used to list `getRef` as well, which reads correctly and is a bug:
  // `api` is a proxy that mints a new object on every property access, so
  // `getRef` changed identity every render, the memo recomputed every render,
  // and `useQueries` got a new spec every render — which makes `useSubscription`
  // call `setState` during render, forever. The whole console rendered as a
  // blank white page with React error #301. See `../querySpec.ts`.
  //
  // So the reference is fetched *inside* the memo, and the empty case returns
  // the shared constant rather than a fresh `{}`.
  const spec = useMemo<RequestForQueries>(() => {
    const ref = ingestionModule()?.getIngestionSettings;
    if (ref === undefined || workspaceId === null) return EMPTY_QUERY_SPEC;
    return { settings: { query: ref, args: { workspaceId } } };
  }, [workspaceId]);

  const results = useQueries(spec);

  // Same rule as the spec above: the reference is looked up when the callback
  // runs, so an api proxy never lands in a dependency array.
  const save = useCallback(
    async (patch: IngestionPatch) => {
      const ref = ingestionModule()?.updateIngestionSettings;
      if (ref === undefined || workspaceId === null) return;
      await convex.mutation(ref, { workspaceId, ...patch });
    },
    [convex, workspaceId],
  );

  const raw = results.settings;
  const settings =
    raw === undefined || raw === null || raw instanceof Error
      ? null
      : (raw as IngestionSettings);

  return {
    settings,
    // A thrown query is not "still loading" — it is an answer we cannot use,
    // and leaving the card spinning forever would be worse than saying so.
    loading: getRef !== undefined && workspaceId !== null && raw === undefined,
    available: getRef !== undefined,
    save: updateRef !== undefined && canEdit && workspaceId !== null ? save : undefined,
  };
}
