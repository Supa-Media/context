/**
 * The storage move's rules, kept pure so the stage check, the stale rule and the copy's paging can be tested without
 * a Convex runtime (`functions/adminStorage.ts` does the reads and writes; the row is `schema/storageMoves.ts`).
 *
 * The stages are `bucket` -> `dual` (copy, reads on the bucket) -> `object` (reads on the object). Nothing else moves
 * by this route: a rollback is a separate, owner-decided step.
 */

export type Home = "bucket" | "dual" | "object";
export type MoveTarget = "dual" | "object";

/** The fields of a move row the rules read. */
export type MoveRow = {
  to: MoveTarget;
  state: "running" | "done" | "incomplete" | "refused" | "failed";
  reason?: string;
  startedAt: number;
  heartbeatAt: number;
  cursor?: string;
  gaps?: boolean;
};

/** What the report shows: a running row whose heartbeat has stopped is `stale`, not running. */
export type ReportState =
  "running" | "stale" | "done" | "incomplete" | "refused" | "failed";

/** A running move whose last heartbeat is older than this was killed, and may be resumed. */
export const MOVE_STALE_MS = 2 * 60 * 1000;

export function isStale(
  row: Pick<MoveRow, "state" | "heartbeatAt">,
  now: number,
): boolean {
  return row.state === "running" && now - row.heartbeatAt > MOVE_STALE_MS;
}

export function reportState(row: MoveRow, now: number): ReportState {
  if (row.state === "running") return isStale(row, now) ? "stale" : "running";
  return row.state;
}

export type MovePlan =
  | { ok: true; switched: boolean; cursor?: string; gaps: boolean }
  | { ok: false; message: string };

/**
 * Whether a request may start, and what it starts from.
 *
 * - A fresh running move refuses everything: one move per workspace at a time.
 * - `bucket` -> `dual` starts the switch and the copy. A stale row is simply started again.
 * - `dual` -> `object` is the switch; an incomplete or failed copy must be copied again first.
 * - On `dual`, a stale copy resumes from its cursor with its gaps so far; an incomplete, failed or refused copy is
 *   copied again from the start. A finished copy is not copied again: its reads move next.
 * - Anything else is refused with the words the page shows.
 */
export function planMove(input: {
  name: string;
  home: Home;
  to: MoveTarget;
  row: MoveRow | null;
  now: number;
}): MovePlan {
  const { name, home, to, row, now } = input;
  const at = `@${name}`;
  if (row !== null && row.state === "running" && !isStale(row, now))
    return refuse(`A move for ${at} is already running`);
  if (home === "object") return refuse(`${at} is already on its object`);
  if (to === "object") {
    if (home === "bucket") return refuse(`Copy ${at} first`);
    if (row !== null && (row.state === "incomplete" || row.state === "failed"))
      return refuse(`Copy ${at} again first`);
    return { ok: true, switched: false, gaps: false };
  }
  if (home === "bucket") return { ok: true, switched: false, gaps: false };
  if (row !== null && row.state === "running")
    return {
      ok: true,
      switched: true,
      cursor: row.cursor,
      gaps: row.gaps === true,
    };
  if (
    row !== null &&
    (row.state === "incomplete" ||
      row.state === "failed" ||
      row.state === "refused")
  )
    return { ok: true, switched: true, gaps: false };
  if (row !== null && row.state === "done")
    return refuse(`${at} is already copied; move its reads to its object`);
  return refuse(`${at} is already on dual`);
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/** One page of the backfill's copy step, as `workspaceObjects.backfill` returns it for one workspace. */
export type CopyPage = {
  done: boolean;
  cursor: string;
  failed: number;
  unreachable: number;
  heldBack: number;
  refused?: string;
};

/** Folds a page into the move's running answer: whether the copy is done, its cursor, and whether anything had a gap. */
export function copyStep(
  page: CopyPage,
  gapsSoFar: boolean,
): { done: boolean; cursor: string; gaps: boolean } {
  const gaps =
    gapsSoFar || page.failed > 0 || page.unreachable > 0 || page.heldBack > 0;
  return { done: page.done, cursor: page.cursor, gaps };
}
