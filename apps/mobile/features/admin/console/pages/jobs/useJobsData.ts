/**
 * The Jobs page's data and writes: `@context-lc ai/` through the AI tab's own
 * hooks (`../../../useAiCatalog`, `../../../useAiNote`). Every write reads the
 * note's version first and passes it back, so somebody's edit since is
 * refused, never overwritten.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { RUN_TESTS_URL, type AiCatalog } from "../../../aiCatalog";
import { jobPage, promotedText, withFrontKey, type Candidate, type JobPage, type RunRead } from "../../../aiModel";
import { experimentText } from "../../../aiExperiments";
import { parseReplies, repliesPathOf, type RepliesCase } from "../../../aiCompareModel";
import { useAiCatalog, type AiCatalogState } from "../../../useAiCatalog";
import { messageOf, useIo, useNoteWriter, useRuns } from "../../../useAiNote";
import { withCaseCopied, withCaseEdited, withCaseRemoved, withNewCase, type CaseDraft } from "./caseEdits";

const NONE = "" as Id<"workspaces">;

export interface JobsData {
  state: AiCatalogState;
  catalog: AiCatalog | null;
  reads: ReadonlyMap<string, RunRead>;
  workspaceId: Id<"workspaces"> | null;
  me: string;
  reload: () => void;
}

export function useJobsData(): JobsData {
  const { state, reload } = useAiCatalog();
  const ready = state.kind === "ready" ? state : null;
  const workspaceId = ready?.workspaceId ?? null;
  const paths = useMemo(() => ready?.catalog.results.map((row) => row.path) ?? [], [ready?.catalog]);
  const reads = useRuns(workspaceId ?? NONE, workspaceId ? paths : []);
  return { state, catalog: ready?.catalog ?? null, reads, workspaceId, me: ready?.me ?? "staff", reload };
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

export interface JobWrites {
  saveCase(path: string, number: number, draft: CaseDraft): Promise<void>;
  newCase(path: string): Promise<number>;
  copyCase(path: string, number: number): Promise<number>;
  /** Removes it and answers the list's text before, for Undo. */
  deleteCase(path: string, number: number): Promise<string>;
  restoreList(path: string, text: string): Promise<void>;
  newExperiment(page: JobPage): Promise<string>;
  makeLive(page: JobPage, candidate: Candidate): Promise<void>;
  runBoth(): void;
}

export function useJobWrites(workspaceId: Id<"workspaces"> | null, me: string): JobWrites {
  const write = useNoteWriter(workspaceId ?? NONE);
  const { readNote } = useIo();
  const read = useCallback(async (path: string) => (await readNote({ workspaceId: workspaceId ?? NONE, path })).text, [readNote, workspaceId]);
  return useMemo<JobWrites>(() => {
    const need = () => {
      if (workspaceId === null) throw new Error("The AI notes are not open yet");
    };
    return {
      async saveCase(path, number, draft) {
        need();
        await write(path, (text) => (text === null ? null : withCaseEdited(text, number, draft)));
      },
      async newCase(path) {
        need();
        let number = 0;
        await write(path, (text) => {
          if (text === null) return null;
          const made = withNewCase(text);
          number = made.number;
          return made.text;
        });
        return number;
      },
      async copyCase(path, number) {
        need();
        let made = 0;
        await write(path, (text) => {
          if (text === null) return null;
          const copy = withCaseCopied(text, number);
          made = copy.number;
          return copy.text;
        });
        return made;
      },
      async deleteCase(path, number) {
        need();
        let before = "";
        await write(path, (text) => {
          if (text === null) return null;
          before = text;
          return withCaseRemoved(text, number);
        });
        return before;
      },
      async restoreList(path, text) {
        need();
        await write(path, () => text);
      },
      async newExperiment(page) {
        need();
        if (page.row.setup === null) throw new Error("Nothing is live on this job to copy");
        const liveText = await read(page.row.setup.path);
        const taken = new Set([...page.candidates, ...page.retired].map((item) => item.name));
        let n = page.candidates.length + 1;
        while (taken.has(`experiment-${n}`)) n += 1;
        const name = `experiment-${n}`;
        const change = "Name the one thing that changes";
        await write(`ai/setups/${page.job.key}/${name}.md`, (existing) =>
          existing === null ? experimentText(liveText, { job: page.job.key, basedOn: page.live ?? page.row.setup!.name, change, by: me }) : null,
        );
        return name;
      },
      async makeLive(page, candidate) {
        need();
        const liveRow = page.row.setup;
        if (liveRow === null) throw new Error("Nothing is live on this job to replace");
        const mineText = await read(candidate.row.path);
        const day = new Date().toISOString().slice(0, 10);
        await write(liveRow.path, () => promotedText(mineText, { job: page.job.key, from: candidate.name, day, by: me }));
        await write(candidate.row.path, (text) => withFrontKey(text ?? mineText, "status", "live"));
        const was = page.candidates.find((item) => item.name === page.live);
        if (was && was.name !== candidate.name) await write(was.row.path, (text) => (text === null ? null : withFrontKey(text, "status", "retired")));
      },
      // The bench runs on GitHub Actions; its dispatch form takes the job and both setups.
      runBoth() {
        void Linking.openURL(RUN_TESTS_URL).catch(() => {});
      },
    };
  }, [workspaceId, write, read, me]);
}

export { jobPage, messageOf };
