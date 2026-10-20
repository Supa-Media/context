import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  fastSearchStateOf,
  shouldReadFastSearch,
  type FastSearchStatus,
  type FastSearchView,
} from "./fastSearch";

/**
 * Fast search for the selected context, read from the control plane.
 *
 * `fastSearch.status` is readable by any member, so this hook subscribes for
 * everybody. That is deliberately not the shape `useIngestionSettings` has:
 * the ingestion allow-list is an owner's correspondent list and the read is
 * owner-only, while "how is this context's search served" is a fact its
 * members may know. It is read only: fast search is on for every workspace
 * and the server turns it on, so the console sends nothing.
 *
 * `useQueries` rather than `useQuery`, for the reason `useLiveConsoleData`
 * gives at length: a failed `useQuery` re-throws during render, and a settings
 * pane must not be able to take the console down. A thrown status here is
 * `null` — the card draws its loading line and nothing claims a state.
 */
export function useFastSearch(options: {
  workspaceId: Id<"workspaces"> | null;
}): FastSearchView {
  const { workspaceId } = options;
  const asking = shouldReadFastSearch({ workspaceId });

  // The spec may be empty, which is what lets this subscribe conditionally
  // without a conditional hook. `api.…` is reached for inside the memo and
  // never in the dependency array — it is a proxy that mints a fresh object on
  // every access, and one in a dep array re-renders the console forever. See
  // `./querySpec.ts`.
  const spec = useMemo<RequestForQueries>(() => {
    const empty: RequestForQueries = {};
    if (!asking || workspaceId === null) return empty;
    return {
      status: { query: api.functions.fastSearch.status, args: { workspaceId } },
    };
  }, [asking, workspaceId]);

  const results = useQueries(spec);

  const raw = results.status;
  const answered = raw !== undefined && !(raw instanceof Error) && raw !== null;
  const status: FastSearchStatus | null = answered
    ? {
        ...(raw as FastSearchStatus),
        // Never trusted as a union: a control plane newer than this bundle can
        // name a state this build does not know, and `fastSearchStateOf`
        // decides which way that fails.
        state: fastSearchStateOf((raw as { state: unknown }).state),
      }
    : null;

  return {
    status,
    // A query that threw is not "still loading": nothing spins at somebody
    // forever over a status that will never come.
    loading: asking && raw === undefined,
  };
}
