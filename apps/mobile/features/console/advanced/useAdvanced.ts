import { useMemo } from "react";
import { useAction, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import {
  buildKeyExportDocument,
  type AdvancedView,
  type ConsoleAuditEvent,
  type KeyExportAction,
  type KeyExportDocument,
  type RawKeyExport,
} from "./advanced";

/**
 * The Advanced section, bound to the control plane.
 *
 * Two backends, two different clearances, in one hook because they share one
 * settings row:
 *
 *  - `audit.listEvents` is readable by **any member**, read-only role
 *    included — the point of an audit trail is that the people whose notes are
 *    involved can see what touched them, and `listEvents` itself withholds the
 *    non-owner-visible `details` fields (`MEMBER_VISIBLE_DETAIL_ACTIONS`). So
 *    this subscribes for everybody, the same shape `useFastSearch` uses for
 *    `fastSearch.status`.
 *  - `encryptionKeys.exportEncryptionKeys` is **owner-only**
 *    (`authorizeEncryptionExport`), so `keyExport` is absent — the whole
 *    property — for anyone else, the rule `StorageActions` states.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */

/**
 * How many rows to ask for. `listEvents`' own default is the same number;
 * named explicitly here so a server-side default change is not a silent
 * change to what this console shows.
 */
const AUDIT_LIMIT = 50;

/**
 * Convex hands back `undefined` while loading and an `Error` when a query
 * threw. Only true of `useQueries` — see `useMembers`'s copy of this guard.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export function useAdvanced(options: {
  workspaceId: Id<"workspaces"> | null;
  /** Whether the caller is this context's owner — the same gate `storageActions` uses. */
  isOwner: boolean;
}): AdvancedView {
  const { workspaceId, isOwner } = options;

  // Any member may read the audit trail, so the only question is whether
  // there is a context to ask about — `workspaceId` is the sole dependency,
  // and `api.…` is reached for *inside* the memo. See `./querySpec.ts`.
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null) return EMPTY_QUERY_SPEC;
    return {
      events: {
        query: api.functions.audit.listEvents,
        args: { workspaceId, limit: AUDIT_LIMIT },
      },
    };
  }, [workspaceId]);

  const results = useQueries(spec);
  const raw = results.events;
  const events = usable<ConsoleAuditEvent[]>(raw) ?? [];
  const failed = raw instanceof Error ? raw : null;

  const exportEncryptionKeys = useAction(api.functions.encryptionKeys.exportEncryptionKeys);

  // Absent, not disabled, and absent as a whole object — the rule
  // `StorageActions` states, applied to a control that hands somebody a
  // context's AES key material in the clear.
  const keyExport: KeyExportAction | undefined = useMemo(() => {
    if (workspaceId === null || !isOwner) return undefined;
    return {
      export: async (): Promise<KeyExportDocument | null> => {
        const raw: RawKeyExport | null = await exportEncryptionKeys({ workspaceId });
        if (raw === null) return null;
        return buildKeyExportDocument(workspaceId, raw, Date.now());
      },
    };
  }, [workspaceId, isOwner, exportEncryptionKeys]);

  return {
    audit: {
      events,
      // A query that threw is an answer, not a wait.
      loading: workspaceId !== null && raw === undefined,
      failure: failed === null ? null : describeQueryFailure(failed, "the audit trail"),
    },
    keyExport,
  };
}
