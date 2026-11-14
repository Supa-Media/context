/**
 * The Jobs page's data and writes: `@context-lc ai/` through the AI tab's own
 * hooks (`../../../useAiCatalog`, `../../../useAiNote`). Every write reads the
 * note's version first and passes it back, so somebody's edit since is
 * refused, never overwritten.
 */

import { useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import type { AiCatalog } from "../../../aiCatalog";
import { jobPage, type Candidate, type RunRead } from "../../../aiModel";
import { parseReplies, repliesPathOf, type RepliesCase } from "../../../aiCompareModel";
import { useAiCatalog, type AiCatalogState } from "../../../useAiCatalog";
import { messageOf, useIo, useNoteWriter, useRuns } from "../../../useAiNote";
import { makeJobWrites, type JobWrites } from "./jobWrites";

export type { JobWrites };

const NONE = "" as Id<"workspaces">;

export interface JobsData {
  state: AiCatalogState;
  catalog: AiCatalog | null;
  reads: ReadonlyMap<string, RunRead>;
  workspaceId: Id<"workspaces"> | null;
  me: string;
  reload: () => void;
  /** How many times the notes were reloaded, so screens re-read their own notes too. */
  reloads: number;
}

export function useJobsData(): JobsData {
  const { state, reload: reloadCatalog } = useAiCatalog();
  const [reloads, setReloads] = useState(0);
  const ready = state.kind === "ready" ? state : null;
  const workspaceId = ready?.workspaceId ?? null;
  const paths = useMemo(() => ready?.catalog.results.map((row) => row.path) ?? [], [ready?.catalog]);
  const reads = useRuns(workspaceId ?? NONE, workspaceId ? paths : []);
  const me = ready?.me ?? "staff";
  const catalog = ready?.catalog ?? null;
  return useMemo(
    () => ({
      state,
      catalog,
      reads,
      workspaceId,
      me,
      reloads,
      reload: () => {
        reloadCatalog();
        setReloads((was) => was + 1);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadCatalog is a fresh closure each render, over a stable setter
    [state, catalog, reads, workspaceId, me, reloads],
  );
}

/** Several notes' text, re-read whenever `round` moves (after a save). */
export function useTexts(workspaceId: Id<"workspaces"> | null, paths: readonly string[], round: number): ReadonlyMap<string, string | null> {
  const { readNote } = useIo();
  const [read, setRead] = useState<ReadonlyMap<string, string | null>>(new Map());
  const key = [...new Set(paths)].sort().join("\n");
  useEffect(() => {
    if (key === "" || workspaceId === null) return;
    let live = true;
    void Promise.all(
      key.split("\n").map(async (path) => {
        try {
          return [path, (await readNote({ workspaceId, path })).text] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((pairs) => {
      if (live) setRead(new Map(pairs));
    });
    return () => {
      live = false;
    };
  }, [key, workspaceId, readNote, round]);
  return read;
}

/** The replies note beside the round a candidate's score is from, read into cases. */
export function useReplies(workspaceId: Id<"workspaces"> | null, candidate: Candidate | null): ReadonlyMap<number, RepliesCase> | null {
  const path = candidate?.rounds[0]?.run.path ?? null;
  const texts = useTexts(workspaceId, path ? [repliesPathOf(path)] : [], 0);
  const text = path ? texts.get(repliesPathOf(path)) : undefined;
  return useMemo(() => (text ? parseReplies(text) : null), [text]);
}

export function useJobWrites(workspaceId: Id<"workspaces"> | null, me: string): JobWrites {
  const write = useNoteWriter(workspaceId ?? NONE);
  const { readNote } = useIo();
  return useMemo<JobWrites>(() => {
    const need = () => {
      if (workspaceId === null) throw new Error("The AI notes are not open yet");
    };
    return makeJobWrites(
      {
        read: async (path) => {
          need();
          return (await readNote({ workspaceId: workspaceId!, path })).text;
        },
        write: async (path, change) => {
          need();
          await write(path, change);
        },
        open: (url) => Linking.openURL(url).then(() => true, () => false),
      },
      me,
    );
  }, [workspaceId, write, readNote, me]);
}

export { jobPage, messageOf };
