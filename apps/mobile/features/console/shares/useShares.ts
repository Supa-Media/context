import { useMemo } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import {
  canManageShares,
  type ConsoleShare,
  type ShareActions,
  type ShareAudience,
  type SharesView,
} from "./shares";

/**
 * Shared links, bound to the control plane.
 *
 * `listShares` is owner-only on the backend — enumerating a context's shares
 * is the owner's disclosure record, not something a member gets to read — so
 * this hook must not fire the query for anyone else at all. That is the same
 * shape `useIngestionSettings`'s `shouldReadIngestionSettings` uses for the
 * allow-list: subscribing anyway would trade a plain "only an owner sees this"
 * sentence for a card that failed with `INSUFFICIENT_ROLE`.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */

interface ShareSummary {
  shareId: Id<"noteShares">;
  token: string;
  recipient: string;
  audience: ShareAudience;
  entryPath: string;
  titleInPreview: boolean;
  previewTitle?: string;
  createdBy: Id<"users">;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Convex hands back `undefined` while loading and an `Error` when a query
 * threw. Only true of `useQueries` — see `useMembers`'s copy of this guard for
 * why a `useQuery` beside it would be dead code claiming a protection it does
 * not have.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export function useShares(options: {
  workspaceId: Id<"workspaces"> | null;
  /** The caller's role in that context, or `undefined` while it is unknown. */
  role: string | undefined;
}): SharesView {
  const { workspaceId, role } = options;
  const isOwner = canManageShares(role);

  // An empty spec rather than a conditional hook, for the reason `useMembers`
  // gives — and empty for a non-owner as well as for no context at all, which
  // is the difference from that hook: `listMembers` is readable by any member,
  // `listShares` is not.
  //
  // `workspaceId` and `isOwner` are the only dependencies, and `api.…` is
  // reached for *inside* the memo — see `./querySpec.ts`.
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return {
      shares: { query: api.functions.shares.listShares, args: { workspaceId } },
    };
  }, [workspaceId, isOwner]);

  const results = useQueries(spec);
  const raw = results.shares;

  const revokeShareMutation = useMutation(api.functions.shares.revokeShare);

  const shares: ConsoleShare[] = (usable<ShareSummary[]>(raw) ?? []).map((share) => ({
    shareId: share.shareId,
    token: share.token,
    recipient: share.recipient,
    audience: share.audience,
    entryPath: share.entryPath,
    titleInPreview: share.titleInPreview,
    previewTitle: share.previewTitle,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
  }));

  // Absent, not disabled, and absent as a whole object — `revokeShare` is
  // owner-only on the backend. See `shares.ts` and `types.ts#StorageActions`.
  const actions: ShareActions | undefined = useMemo(() => {
    if (workspaceId === null || !isOwner) return undefined;
    return {
      revoke: async (shareId: string) => {
        await revokeShareMutation({ shareId: shareId as Id<"noteShares"> });
      },
    };
  }, [workspaceId, isOwner, revokeShareMutation]);

  const failed = raw instanceof Error ? raw : null;

  return {
    shares,
    actions,
    // A query that threw is an answer, not a wait — same rule `useMembers`
    // follows. And a non-owner is never "loading": there is nothing being
    // asked for on their behalf.
    loading: workspaceId !== null && isOwner && raw === undefined,
    failure:
      failed === null ? null : describeQueryFailure(failed, "the links you have shared"),
    readOnlyReason:
      workspaceId === null || actions !== undefined
        ? undefined
        : "Only an owner of this context can see or revoke the links shared from it.",
  };
}
