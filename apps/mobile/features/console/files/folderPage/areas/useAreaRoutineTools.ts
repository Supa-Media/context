/**
 * What the area panel's Routines section is handed for one area (`PanelRoutines.tsx`): its rows from the notes and
 * the runs' state, the bot's week, and the writes, all through the folder page's own paths: a new routine is the
 * console's note create, an edit is its front matter through `chooseMany` (drawn at once, taken back if refused), and
 * a change of Repeats is the console's move. Turning on pulse checks writes what `manage area { pulse: true }`
 * writes, so an agent and the app make the same notes.
 */

import { useCallback, useMemo } from "react";
import { cardSlug } from "@context/shared/src/areaRoutines.cjs";
import type { ListNote } from "../../listBlock/model";
import type { FolderPageHost, PropertyChanges } from "../useFolderPage";
import { areaBotOf, budgetOf, draftChanges, draftOf, folderOf, movedPath, newRoutineNote, pulseNow, pulsePlan, pulseTitles, routineNotesOf, routineRows, type Draft, type RoutineStateNow } from "./areaRoutines";
import type { PanelRoutinesTools } from "./PanelRoutines";
import { areaTitle, cardPath, type AreaNode, type Card } from "./seat";

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

export function useAreaRoutineTools({
  root,
  notes,
  cardNotes,
  cardFor,
  canEdit,
  host,
  chooseMany,
  open,
  state,
  run,
}: {
  root: string;
  notes: readonly ListNote[];
  /** The notes with the holders' cards, where a bot's `works_in:` is read. */
  cardNotes: readonly ListNote[];
  cardFor: (holder: string, kind: Card["kind"]) => Card;
  canEdit: boolean;
  host: FolderPageHost | undefined;
  chooseMany: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
  open: (path: string) => void;
  state: RoutineStateNow;
  /** Run now, through the gateway: null once sent (the state after shows how), or why not. */
  run?: (path: string) => Promise<string | null>;
}): (node: AreaNode) => PanelRoutinesTools {
  const tasks = canEdit ? host?.tasks : undefined;
  const isBot = useCallback((name: string) => cardFor(name, "agent").bot !== "", [cardFor]);
  const settle = useCallback(
    (written: readonly string[], gone: readonly string[]) => {
      tasks?.refresh([...new Set([...written, ...gone].map(parentOf))]);
      void tasks?.remember?.(written, gone);
    },
    [tasks],
  );
  const create = useCallback(
    async (area: string, draft: Draft): Promise<string | null> => {
      if (tasks === undefined) return "Routines can't be added here.";
      const note = newRoutineNote(area, draft);
      if ("error" in note) return note.error;
      if (notes.some((each) => each.path.toLowerCase() === note.path.toLowerCase())) return `${area}'s routines already have one named ${draft.name.trim()}.`;
      try {
        await tasks.io.create(note.path, note.text);
      } catch (error) {
        return error instanceof Error && error.message !== "" ? error.message : "The routine couldn't be written. Try again.";
      }
      settle([note.path], []);
      open(note.path);
      return null;
    },
    [tasks, notes, settle, open],
  );
  const change = useCallback(
    async (path: string, before: Draft, after: Draft): Promise<{ path: string } | { problem: string }> => {
      const changes = [...draftChanges(before, after), ...(after.name.trim() !== before.name.trim() ? [["title", after.name.trim()] as const] : [])];
      if (changes.length > 0) {
        const why = await chooseMany(path, changes, false);
        if (why !== null) return { problem: why };
      }
      const folder = folderOf(after);
      if (folder === folderOf(before) || tasks === undefined) return { path };
      const to = movedPath(path, folder);
      if (notes.some((each) => each.path.toLowerCase() === to.toLowerCase())) return { problem: `There is already a routine at ${to}.` };
      try {
        await tasks.io.move(path, to);
      } catch (error) {
        return { problem: error instanceof Error && error.message !== "" ? error.message : "The routine couldn't be moved. Try again." };
      }
      settle([to], [path]);
      return { path: to };
    },
    [chooseMany, tasks, notes, settle],
  );
  const pulseOn = useCallback(
    async (area: string, modes: readonly string[]): Promise<string | null> => {
      if (tasks === undefined) return "Routines can't be added here.";
      const plan = pulsePlan(area, modes, notes);
      const written: string[] = [];
      for (const note of plan.create) {
        try {
          await tasks.io.create(note.path, note.text);
          written.push(note.path);
        } catch (error) {
          settle(written, []);
          return error instanceof Error && error.message !== "" ? error.message : "Pulse checks couldn't be written. Try again.";
        }
      }
      for (const path of plan.resume) {
        const why = await chooseMany(path, [["paused", null]], false);
        if (why !== null) {
          settle(written, []);
          return why;
        }
      }
      settle(written, []);
      return null;
    },
    [tasks, notes, chooseMany, settle],
  );

  return useMemo(() => {
    const now = Date.now();
    return (node: AreaNode): PanelRoutinesTools => {
      const { seat } = node;
      const area = seat.folder;
      const rows = routineRows(area, root, notes, state, now);
      const bot = areaBotOf(seat.owner, seat.delegate, isBot);
      const at = bot === null ? null : cardPath(root, bot, cardNotes);
      const cardAt = at === null ? undefined : cardNotes.find((note) => note.path === at);
      // A card in a bots folder is named by its folder too (`bots/grok-bot/about.md`), as the gateway names it.
      const folderSlug = at?.endsWith("/about.md") ? at.split("/").slice(-2)[0] : undefined;
      const byPath = new Map(routineNotesOf(area, root, notes).map(({ note }) => [note.path, note]));
      return {
        area,
        root,
        areaName: areaTitle(seat.name),
        routines: rows,
        budget: budgetOf(area, bot, cardAt?.properties.works_in, state, folderSlug === undefined ? undefined : cardSlug(folderSlug)),
        pulse: pulseTitles(seat.modes),
        pulseIsOn: pulseNow(area, root, notes).on,
        hasBot: bot !== null,
        canEdit: canEdit && tasks !== undefined,
        now,
        draftOf: (path) => {
          const note = byPath.get(path);
          const row = rows.find((each) => each.path === path);
          return note === undefined || row === undefined ? null : draftOf(note, row.title);
        },
        open,
        ...(canEdit && run !== undefined ? { runNow: run } : {}),
        ...(tasks === undefined
          ? {}
          : {
              create: (draft: Draft) => create(area, draft),
              change,
              pulseOn: () => pulseOn(area, seat.modes),
            }),
      };
    };
  }, [root, notes, cardNotes, state, isBot, cardFor, canEdit, tasks, open, create, change, pulseOn, run]);
}
