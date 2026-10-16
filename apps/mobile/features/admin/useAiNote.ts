/**
 * One note of `@context-lc`'s `ai/` folder, read and saved in place on the AI
 * tab, through the same `readNote` and `writeNote` the note editor uses. A
 * save passes back the version it read, so somebody else's edit since is
 * refused rather than overwritten; a new note is written with no version,
 * which the server refuses over an existing one.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { readScores, type ScoresRead } from "./aiCatalog";
import { readRun, type RunRead } from "./aiModel";

/** How a note is read and saved: Convex's own actions, unless a fixture provides others. */
export interface AiNoteIo {
  readNote(args: { workspaceId: Id<"workspaces">; path: string }): Promise<{ text: string; etag: string; readOnly: boolean }>;
  writeNote(args: { workspaceId: Id<"workspaces">; path: string; text: string; expectedEtag?: string }): Promise<{ etag: string }>;
}

/** Set only by the browser fixture (`features/e2e`), which has no control plane behind it. */
export const AiNoteIoContext = createContext<AiNoteIo | null>(null);

function useIo(): AiNoteIo {
  const provided = useContext(AiNoteIoContext);
  const readNote = useAction(api.functions.files.readNote);
  const writeNote = useAction(api.functions.files.writeNote);
  return useMemo(() => provided ?? { readNote, writeNote }, [provided, readNote, writeNote]);
}

export type AiNoteState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; text: string; etag: string | null; readOnly: boolean };

export function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/etag|conflict|precondition|changed since/i.test(raw)) return "Somebody changed this note since you opened it. Reload it to see their change.";
  return raw.replace(/^.*Uncaught (?:Convex)?Error:\s*/s, "").split("\n")[0] ?? raw;
}

/** `path` null is a new note: nothing to read, and the first save creates it. */
export function useAiNote(workspaceId: Id<"workspaces">, path: string | null) {
  const { readNote, writeNote } = useIo();
  const [state, setState] = useState<AiNoteState>(path === null ? { kind: "ready", text: "", etag: null, readOnly: false } : { kind: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState({ kind: "loading" });
    readNote({ workspaceId, path })
      .then((file) => {
        if (live) setState({ kind: "ready", text: file.text, etag: file.etag, readOnly: file.readOnly });
      })
      .catch((error: unknown) => {
        if (live) setState({ kind: "failed", message: messageOf(error) });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, path, readNote, round]);

  const save = useCallback(
    async (target: string, text: string): Promise<void> => {
      const etag = state.kind === "ready" ? state.etag : null;
      const written = await writeNote({ workspaceId, path: target, text, ...(etag === null ? {} : { expectedEtag: etag }) });
      setState({ kind: "ready", text, etag: written.etag, readOnly: false });
    },
    [state, workspaceId, writeNote],
  );

  return { state, save, reload: () => setRound((was) => was + 1) };
}

/**
 * The live result of each scores note named, read from its text: older notes
 * carry it only in their "## Scored by" table, not in front matter.
 */
export function useScores(workspaceId: Id<"workspaces">, paths: readonly string[]): ReadonlyMap<string, ScoresRead> {
  const { readNote } = useIo();
  const [read, setRead] = useState<ReadonlyMap<string, ScoresRead>>(new Map());
  const key = [...new Set(paths)].sort().join("\n");
  useEffect(() => {
    if (key === "") return;
    let live = true;
    void Promise.all(
      key.split("\n").map(async (path) => {
        try {
          const file = await readNote({ workspaceId, path });
          return [path, readScores(file.text)] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      const next = new Map<string, ScoresRead>();
      for (const [path, scores] of pairs) if (scores !== null) next.set(path, scores);
      setRead(next);
    });
    return () => {
      live = false;
    };
  }, [key, workspaceId, readNote]);
  return read;
}

/** Every scores note named, read once each: its latest scored section (`readRun`), by path. */
export function useRuns(workspaceId: Id<"workspaces">, paths: readonly string[]): ReadonlyMap<string, RunRead> {
  const { readNote } = useIo();
  const [read, setRead] = useState<ReadonlyMap<string, RunRead>>(new Map());
  const key = [...new Set(paths)].sort().join("\n");
  useEffect(() => {
    if (key === "") return;
    let live = true;
    void Promise.all(
      key.split("\n").map(async (path) => {
        try {
          const file = await readNote({ workspaceId, path });
          return [path, readRun(file.text)] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      const next = new Map<string, RunRead>();
      for (const [path, run] of pairs) if (run !== null) next.set(path, run);
      setRead(next);
    });
    return () => {
      live = false;
    };
  }, [key, workspaceId, readNote]);
  return read;
}

/** A note's text read once, for a screen that shows it (a prompt beside another); null until read or when it fails. */
export function useNoteText(workspaceId: Id<"workspaces">, path: string | null): string | null {
  const { readNote } = useIo();
  const [text, setText] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    readNote({ workspaceId, path })
      .then((file) => {
        if (live) setText({ path, text: file.text });
      })
      .catch(() => {
        if (live) setText(null);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, path, readNote]);
  return text !== null && text.path === path ? text.text : null;
}

/** Saves one note with the version read just before, so somebody's edit since is refused, never overwritten. */
export function useNoteWriter(workspaceId: Id<"workspaces">) {
  const { readNote, writeNote } = useIo();
  return useCallback(
    // `change` answers null to leave the note as it is (or unwritten, when there is none).
    async (path: string, change: (text: string | null) => string | null): Promise<void> => {
      let current: { text: string; etag: string } | null = null;
      try {
        current = await readNote({ workspaceId, path });
      } catch {
        current = null; // a new note: written with no version, which the server refuses over one that exists
      }
      const next = change(current?.text ?? null);
      if (next === null || (current !== null && next === current.text)) return;
      await writeNote({ workspaceId, path, text: next, ...(current === null ? {} : { expectedEtag: current.etag }) });
    },
    [workspaceId, readNote, writeNote],
  );
}
