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
  const spec = useMemo<RequestForQueries>(() => {
    const empty: RequestForQueries = {};
    if (getRef === undefined || workspaceId === null) return empty;
    return { settings: { query: getRef, args: { workspaceId } } };
  }, [getRef, workspaceId]);

  const results = useQueries(spec);

  const save = useCallback(
    async (patch: IngestionPatch) => {
      if (updateRef === undefined || workspaceId === null) return;
      await convex.mutation(updateRef, { workspaceId, ...patch });
    },
    [convex, updateRef, workspaceId],
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
