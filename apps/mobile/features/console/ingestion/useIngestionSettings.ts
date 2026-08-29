/**
 * The live ingestion settings, wired to the control plane.
 *
 * The backend contract is
 *
 *   getIngestionSettings({ workspaceId })
 *     -> { address, targetFolder, allowedSenders, allowedDomains, allowAnySender,
 *          attachmentPolicy, maxAttachmentBytes } | null
 *   updateIngestionSettings({ workspaceId, targetFolder?, allowedSenders?, … })
 *
 * and **both are owner-only, for the read as well as the write**. That is not
 * belt-and-braces: a personal context can have members now — sharing it keeps
 * its capture address — and the allow-list is the owner's correspondent list,
 * which membership does not buy a view of. Anyone else gets
 * `INSUFFICIENT_ROLE`, so this hook must not fire the query for them at all —
 * `shouldReadIngestionSettings` is where that is decided, and it also declines
 * for a context that has no capture address in the first place.
 *
 * `save` is absent, not disabled, for anyone who cannot use it. Same rule as
 * `StorageActions`: a control that is never offered cannot mislead.
 */

import { useCallback, useMemo } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  shouldReadIngestionSettings,
  type IngestionAvailability,
  type IngestionPatch,
  type IngestionSettings,
  type IngestionState,
} from "./settings";

export function useIngestionSettings(options: {
  workspaceId: Id<"workspaces"> | null;
  /** Whether this kind of context receives mail at all. */
  availability: IngestionAvailability;
  /** Only an owner may read or change these, the same as the storage binding. */
  canEdit: boolean;
}): IngestionState {
  const convex = useConvex();
  const { workspaceId, availability, canEdit } = options;

  const asking = shouldReadIngestionSettings({ workspaceId, canEdit, availability });

  // `useQueries` takes a spec that may be empty, which is what lets this
  // subscribe conditionally without a conditional hook.
  const spec = useMemo<RequestForQueries>(() => {
    const empty: RequestForQueries = {};
    if (!asking || workspaceId === null) return empty;
    return {
      settings: {
        query: api.functions.ingestion.getIngestionSettings,
        args: { workspaceId },
      },
    };
  }, [asking, workspaceId]);

  const results = useQueries(spec);

  const save = useCallback(
    async (patch: IngestionPatch) => {
      if (workspaceId === null) return;
      await convex.mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        ...patch,
      });
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
    loading: asking && raw === undefined,
    availability,
    // The same three conditions as the read: there is no point offering a Save
    // whose mutation would throw `INSUFFICIENT_ROLE` or `INGESTION_NOT_AVAILABLE`.
    save: asking ? save : undefined,
  };
}
