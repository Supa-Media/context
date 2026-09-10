import { useMemo } from "react";
import { useAction, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import {
  buildKeyExportDocument,
  canReadAuditTrail,
  type AdvancedView,
  type ConsoleAuditEvent,
  type KeyExportAction,
  type KeyExportDocument,
  type RawKeyExport,
} from "./advanced";

/**
 * The Advanced section, bound to the control plane.
 *
 * Both halves are owner-only in the console today, for two unrelated reasons
 * that happen to land on the same gate:
 *
 *  - `audit.listEvents` is readable by **any member** on the backend,
 *    deliberately, and `paths` is now gated server-side to the reader's own
 *    clearance or their own rows — see `canReadAuditTrail` for the current
 *    reasoning. The console's own subscription is stricter still: even with
 *    `paths` closed, a member reading the trail sees every row's incidence
 *    (action, actor, timestamp) and whatever `details` the allow-list
 *    publishes, and this hook is where the console keeps that narrower
 *    residual signal from becoming a first-class tab in every shared context
 *    until a product decision says otherwise.
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
  /** The caller's role in this context, or `undefined` while it is unknown. */
  role: string | undefined;
}): AdvancedView {
  const { workspaceId, role } = options;
  // Owner-only in the console — see `canReadAuditTrail` for why this is
  // stricter than what `listEvents` itself allows on the backend, and never
  // relax it without the server-side fix that section describes.
  const isOwner = canReadAuditTrail(role);

  // An empty spec for a non-owner as well as for no context at all — the same
  // shape `useShares` uses for `listShares`, and for the same class of reason:
  // subscribing anyway would trade a plain "only an owner sees this" sentence
  // for a query this console must not be sending in the first place.
  //
  // `workspaceId` and `isOwner` are the only dependencies, and `api.…` is
  // reached for *inside* the memo. See `./querySpec.ts`.
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return {
      events: {
        query: api.functions.audit.listEvents,
        args: { workspaceId, limit: AUDIT_LIMIT },
      },
    };
  }, [workspaceId, isOwner]);

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
      // A query that threw is an answer, not a wait. And a non-owner is never
      // "loading": there is nothing being asked for on their behalf.
      loading: workspaceId !== null && isOwner && raw === undefined,
      failure: failed === null ? null : describeQueryFailure(failed, "the audit trail"),
      readOnlyReason:
        workspaceId === null || isOwner
          ? undefined
          : "Only an owner of this context can see its audit trail.",
    },
    keyExport,
  };
}
