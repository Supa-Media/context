import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAction, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { routineFromPath } from "@context/shared/src/routines.cjs";
import type { RoutineRow, RoutineRun } from "./model";

/**
 * What the open routine note can ask the control plane, for the bar and the
 * recent runs drawn inside `NoteEditor`.
 *
 * A context rather than props because the editor is the same component on
 * the landing page's demo, which has no control plane: there this provider is
 * never mounted, `useRoutineHost` answers `null`, and both pieces draw
 * nothing. The editor itself learns nothing about Convex.
 */
export interface RoutineHostValue {
  path: string;
  /** `undefined` until the control plane answers; `null` when it has no row yet. */
  row: RoutineRow | null | undefined;
  /** Newest first; `null` while being read. */
  runs: RoutineRun[] | null;
  /** May press Run now and Pause: an editor or owner. */
  canEdit: boolean;
  /** Queue a run; answers a sentence to show when it could not. */
  runNow: () => Promise<string | null>;
}

const RoutineContext = createContext<RoutineHostValue | null>(null);

export function useRoutineHost(): RoutineHostValue | null {
  return useContext(RoutineContext);
}

/**
 * Mounted by the live console around the note. Answers `null` for a note
 * outside `routines/`, and asks the control plane nothing unless the open note
 * is a scheduled routine.
 */
export function RoutineProvider({
  workspaceId,
  path,
  canEdit,
  children,
}: {
  workspaceId: string | undefined;
  path: string | null;
  canEdit: boolean;
  children: ReactNode;
}) {
  const found = path === null ? null : routineFromPath(path);
  const routine = found?.kind === "routine";
  const ask = routine && workspaceId !== undefined ? { workspaceId: workspaceId as Id<"workspaces">, path: path! } : null;
  // `useQueries` rather than `useQuery`: a refused query is a value here, not
  // a throw during render that would take the whole console down with it.
  const spec = useMemo((): RequestForQueries => {
    if (ask === null) return {};
    return { row: { query: api.functions.routines.routineForNote, args: ask } };
  }, [ask?.workspaceId, ask?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useQueries(spec);
  const raw = results.row as RoutineRow | null | undefined | Error;
  const row = ask === null ? null : raw instanceof Error ? null : raw;

  const readRuns = useAction(api.functions.routines.routineRuns);
  const queueRun = useMutation(api.functions.routines.runRoutineNow);
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const lastRunAt = row?.lastRunAt ?? null;

  // Read again whenever the row says a run finished, so the list keeps up
  // without a subscription to a file the control plane never holds.
  useEffect(() => {
    if (ask === null) return;
    let live = true;
    setRuns(null);
    readRuns(ask)
      .then((answer) => {
        if (live) setRuns(answer);
      })
      .catch(() => {
        if (live) setRuns([]);
      });
    return () => {
      live = false;
    };
  }, [ask?.workspaceId, ask?.path, lastRunAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const runNow = useCallback(async (): Promise<string | null> => {
    if (ask === null) return null;
    try {
      const queued = await queueRun(ask);
      return queued ? null : "It can't run right now. Check it isn't paused, then try again.";
    } catch {
      return "It couldn't be started. Try again in a moment.";
    }
  }, [ask?.workspaceId, ask?.path, queueRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(
    (): RoutineHostValue | null =>
      found === null || path === null ? null : { path, row: ask === null ? null : row, runs, canEdit, runNow },
    [path, found === null, ask === null, row, runs, canEdit, runNow], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return <RoutineContext.Provider value={value}>{children}</RoutineContext.Provider>;
}

/** For tests and fixtures: a host without a control plane behind it. */
export function RoutineHostFixture({ value, children }: { value: RoutineHostValue | null; children?: ReactNode }) {
  return <RoutineContext.Provider value={value}>{children}</RoutineContext.Provider>;
}
