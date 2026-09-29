import { useEffect, useMemo } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

/**
 * How full a context on the free plan is, once it is worth saying.
 *
 * The free plan holds a fixed number of notes. The owner picked (2026-09-29)
 * a quiet count in the top bar from nine tenths of the cap, so reaching it is
 * never the first anybody hears of it. `docs/decisions/billing.md`, "Warn
 * before the cap, not only at it".
 */
export interface NoteLimit {
  used: number;
  cap: number;
  /** At or past the cap: creating a note is refused, everything else works. */
  full: boolean;
}

/** From here on the count is drawn. Nine tenths: 900 of 1,000. */
export const NOTE_LIMIT_WARN_FRACTION = 0.9;

/**
 * The count to draw, or `null` for none.
 *
 * `null` for a context with no cap (paying, or on a bucket of its own), for a
 * member (the count is the owner's, and so is the decision it prompts), for a
 * count nobody has taken, and below nine tenths of the cap.
 */
export function noteLimitFrom(
  status: { noteCap?: number; notes?: number } | null | undefined,
): NoteLimit | null {
  const cap = status?.noteCap;
  const used = status?.notes;
  if (typeof cap !== "number" || cap <= 0 || typeof used !== "number") return null;
  if (used < Math.ceil(cap * NOTE_LIMIT_WARN_FRACTION)) return null;
  return { used, cap, full: used >= cap };
}

/** "912 of 1,000 notes". */
export function noteLimitLabel(limit: NoteLimit): string {
  return `${limit.used.toLocaleString("en-US")} of ${limit.cap.toLocaleString("en-US")} notes`;
}

/**
 * The selected context's count, for its owner, freshly asked for on open.
 *
 * The count on the binding is taken when storage is verified, so on opening a
 * capped context this asks for a recount (`billing.refreshNoteCount`, which
 * decides whether one is due) — notes agents, email and other devices added
 * since then are in the number the bar draws. Members ask for nothing.
 */
export function useNoteLimit(
  workspaceId: Id<"workspaces"> | null,
  isOwner: boolean,
): NoteLimit | null {
  const asking = workspaceId !== null && isOwner;
  // `api.…` only inside the memo — see `usePremium` for why.
  const spec = useMemo<RequestForQueries>(() => {
    const requests: RequestForQueries = {};
    if (asking && workspaceId !== null) {
      requests.status = { query: api.functions.billing.status, args: { workspaceId } };
    }
    return requests;
  }, [asking, workspaceId]);
  const raw = useQueries(spec).status;
  const status =
    raw === undefined || raw === null || raw instanceof Error
      ? null
      : (raw as { noteCap?: number; notes?: number });
  const capped = typeof status?.noteCap === "number";

  const refresh = useMutation(api.functions.billing.refreshNoteCount);
  useEffect(() => {
    if (!asking || workspaceId === null || !capped) return;
    // Best-effort: a count that could not be asked for leaves the last one.
    refresh({ workspaceId }).catch(() => {});
  }, [asking, capped, refresh, workspaceId]);

  return noteLimitFrom(status);
}
