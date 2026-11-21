/**
 * The React half of Tex in a note: the host the editor reads through its
 * facet, the note's log, and whether Tex is working in this note right now.
 *
 * The host is built once per note and workspace, not per render. The editor
 * reconfigures its Tex facet only when a host appears or goes, so a new object
 * here would not reach it, but the methods read the latest note, people and
 * route through refs all the same.
 */

import { setTexWriting } from "./texWriting";
import { texInNoteFixture } from "./fixtureTransport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import type { GrantRefresh } from "../../../../agent/consoleGrantCache";
import type { Mentionable, NoteRunRequest, NoteRunRow, TexInNoteHost } from "./contract";
import { fetchNoteRuns, noteRunEndpoint, noteRunsEndpoint, runNoteRun, type NoteRunMint } from "./noteRun";
import type { EditorState } from "../../editor";

/** Where Tex's own chat lives: the person's personal workspace and the console's MCP endpoint. */
export interface TexTarget {
  workspaceId: string;
  endpoint: string;
}

/** The open note: its workspace, its stable id and its path. */
export interface NoteRef {
  workspace: string;
  noteId: string;
  path: string;
}

export interface TexInNoteState {
  /** The host the editor reads, or `null` when there is no Tex or no note id. */
  host: TexInNoteHost | null;
  /** The note's log, newest first as the gateway lists it. */
  rows: NoteRunRow[];
  /** A sentence for why the log could not be read, else `null`. */
  error: string | null;
  /** Tex is working in this note now. */
  running: boolean;
  /** Read the log again. */
  refresh: () => void;
}

/**
 * The open note's reference, or `null`. The console's open-note state does not
 * carry the note's stable id yet (`OpenNote` has none), so this answers `null`
 * for every note until it does: no id, no log, no Tex in the note.
 */
export function noteRefOf(workspace: string | null | undefined, editor: Pick<EditorState, "path"> & { noteId?: string | null }): NoteRef | null {
  // The console opens notes by path; the gateway resolves the id from the
  // path when none is known here (agreed with the note-run route), so a
  // missing id is "", never a reason to switch Tex off.
  if (!workspace || editor.path === null) return null;
  return { workspace, noteId: editor.noteId ?? "", path: editor.path };
}

/** The workspace's members as mention-menu entries: `@handle` and the name it is drawn with. A member with no handle is not mentionable. */
export function mentionablesOf(members: readonly { handle?: string; name?: string }[] | undefined): Mentionable[] {
  return (members ?? []).flatMap((member) => (member.handle ? [{ handle: `@${member.handle}`, name: member.name ?? member.handle }] : []));
}

export function useTexInNote(options: { tex: TexTarget | null; note: NoteRef | null; people: Mentionable[] }): TexInNoteState {
  const { note, people } = options;
  // The browser fixture's pretend gateway, when its screen set one (`fixtureTransport.ts`).
  const fixture = options.tex === null ? texInNoteFixture() : null;
  const tex = options.tex ?? fixture?.target ?? null;
  const fetchImpl = fixture?.fetchImpl;
  const mint = useConsoleGrant();
  const workspaceId = tex?.workspaceId ?? null;
  const runRoute = tex === null ? null : noteRunEndpoint(tex.endpoint);
  const runsRoute = tex === null ? null : noteRunsEndpoint(tex.endpoint);
  const noteKey = note === null ? null : `${note.workspace}\n${note.noteId}\n${note.path}`;

  // The grant source through a ref: a `mint` that is a new function on each
  // render (as a test double is) must not rebuild the host or reload the log,
  // or the reload's own state change renders again and loops for ever.
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const mintForTex = useCallback<NoteRunMint>(
    (refresh: GrantRefresh) =>
      workspaceId === null
        ? Promise.reject(new Error("No workspace"))
        : fetchImpl !== undefined
          ? Promise.resolve("fixture")
        : mintRef.current({ workspaceId: workspaceId as Id<"workspaces"> }, refresh).then((minted) => minted.accessToken),
    [workspaceId, fetchImpl],
  );

  // Read by the methods, which the editor calls outside any render.
  const latest = useRef({ note, people });
  latest.current = { note, people };

  const [rows, setRows] = useState<NoteRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The route answered that Tex in notes is not on: no host, so no Tex button.
  const [off, setOff] = useState(false);
  const writingRef = useRef(false);
  // A note closed mid-run must not leave Tex's face in the pile.
  useEffect(() => () => {
    if (writingRef.current) setTexWriting(false);
    writingRef.current = false;
  }, []);
  // Each load is an epoch: an answer from an earlier note or an earlier load is dropped.
  const epoch = useRef(0);

  const load = useCallback(() => {
    const current = latest.current.note;
    const token = ++epoch.current;
    if (current === null || runsRoute === null) return;
    void fetchNoteRuns({ route: runsRoute, mint: mintForTex, workspace: current.workspace, noteId: current.noteId, path: current.path, fetchImpl }).then((answer) => {
      if (token !== epoch.current) return;
      if (Array.isArray(answer)) {
        setRows(answer);
        setError(null);
        setOff(false);
      } else {
        setError(answer.error);
        setOff(answer.off === true);
      }
    });
  }, [mintForTex, runsRoute, fetchImpl]);

  // The log is read when the note changes, and not kept from the one before.
  useEffect(() => {
    epoch.current += 1;
    setRows([]);
    setError(null);
    setRunning(false);
    load();
  }, [load, noteKey]);

  // The latest load, for the host's callbacks, which are built once.
  const reload = useRef(load);
  reload.current = load;

  const ready = tex !== null && note !== null && runRoute !== null && !off;
  const host = useMemo<TexInNoteHost | null>(() => {
    if (!ready || runRoute === null) return null;
    return {
      run: (request: NoteRunRequest, signal: AbortSignal) =>
        runNoteRun({ route: runRoute, mint: mintForTex, request, signal, fetchImpl }),
      runs: () => {
        const current = latest.current.note;
        if (current === null || runsRoute === null) return Promise.resolve({ error: "Tex isn't available right now." });
        return fetchNoteRuns({ route: runsRoute, mint: mintForTex, workspace: current.workspace, noteId: current.noteId, path: current.path, fetchImpl });
      },
      note: () => latest.current.note,
      people: () => latest.current.people,
      onRunDone: () => reload.current(),
      onRunning: (value: boolean) => {
        setRunning(value);
        // The runner says "started" for every run and "stopped" once, so only a flip reaches the shared count.
        if (writingRef.current !== value) {
          writingRef.current = value;
          setTexWriting(value);
        }
      },
    };
  }, [ready, runRoute, runsRoute, mintForTex, fetchImpl]);

  const refresh = useCallback(() => reload.current(), []);

  return { host, rows, error, running, refresh };
}
