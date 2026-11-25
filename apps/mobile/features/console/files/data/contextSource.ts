/**
 * The built-in Context source: its two datasets, worked out when they are read
 * from the notes the reader can see, and never written anywhere (the data
 * sources board 10; `docs/decisions/data-and-metrics.md`).
 *
 * Which folders it counts is set in its `about.md`, under each dataset's own
 * name:
 *
 *     source: context
 *     notes-by-status: [areas/reliability/incidents, projects]
 *     time-to-answered: [inbox/questions]
 *
 * - `notes-by-status` (`date, folder, status, notes`): today's count of the
 *   notes under each folder, by each note's `status` line, in the order the
 *   folder's status list gives (a status it declares and no note has is a 0).
 * - `time-to-answered` (`date, folder, asked, answered, minutes`): one row per
 *   note under the folder whose front matter has both `asked` and `answered`,
 *   the minutes between them, dated the day it was answered.
 *
 * Pure. The notes are the reader's own, at their clearance, so a count can
 * only ever be of notes the reader could open themselves. History is not kept:
 * `notes-by-status` has today's rows only.
 */

import { dateMs } from "../../../../../mcp/src/sheets/csv.js";
import type { ListNote } from "../listBlock/model";
import { ABOUT_NOTE } from "../paths";
import { GROUPS, compareStatus, folderStatuses } from "../folderPage/statuses";
import { listOf, textOf, type DataSource } from "./sources";
import type { Sheet } from "./workOut";

export interface CountedFolders {
  readonly byStatus: readonly string[];
  readonly answered: readonly string[];
}

/** A folder as written in about.md, without its trailing slash: `projects/` is `projects`. */
function folderPath(written: string): string {
  return written.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function countedFolders(source: DataSource | null): CountedFolders {
  const props = source?.about?.properties ?? {};
  return {
    byStatus: listOf(props["notes-by-status"]).map(folderPath).filter((f) => f !== ""),
    answered: listOf(props["time-to-answered"]).map(folderPath).filter((f) => f !== ""),
  };
}

/** Every folder the source reads, each once. */
export function foldersToRead(counted: CountedFolders): string[] {
  return [...new Set([...counted.byStatus, ...counted.answered])];
}

const under = (folder: string, path: string) => path.startsWith(`${folder}/`);

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function notesByStatus(folders: readonly string[], notes: readonly ListNote[], now: number): Sheet {
  const rows: Record<string, string>[] = [];
  const today = day(now);
  for (const folder of folders) {
    const counts = new Map<string, number>();
    const declared = folderStatuses(folder, notes);
    // A status the folder's own list declares is counted even when no note has it: incidents "open 0".
    if (declared.from !== null) for (const group of GROUPS) for (const word of declared.list[group]) counts.set(word, 0);
    for (const note of notes) {
      // The folder's own front note sets its statuses; it is not one of the notes counted.
      if (!under(folder, note.path) || note.path === `${folder}/${ABOUT_NOTE}`) continue;
      // A note's status, or a subfolder's on its front note: one task each.
      const status = textOf(note.properties.status);
      if (status === "") continue;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const order = compareStatus(declared.list);
    for (const [status, count] of [...counts].sort(([a], [b]) => order(a, b))) {
      rows.push({ date: today, folder, status, notes: String(count) });
    }
  }
  return {
    columns: [
      { name: "date", type: "date" },
      { name: "folder", type: "text" },
      { name: "status", type: "select" },
      { name: "notes", type: "number" },
    ],
    rows,
  };
}

export function timeToAnswered(folders: readonly string[], notes: readonly ListNote[]): Sheet {
  const rows: Record<string, string>[] = [];
  for (const folder of folders) {
    for (const note of notes) {
      if (!under(folder, note.path)) continue;
      const asked = textOf(note.properties.asked);
      const answered = textOf(note.properties.answered);
      const from = dateMs(asked) as number;
      const to = dateMs(answered) as number;
      if (asked === "" || answered === "" || Number.isNaN(from) || Number.isNaN(to) || to < from) continue;
      rows.push({ date: day(to), folder, asked, answered, minutes: String(Math.round((to - from) / 60_000)) });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    columns: [
      { name: "date", type: "date" },
      { name: "folder", type: "text" },
      { name: "asked", type: "date" },
      { name: "answered", type: "date" },
      { name: "minutes", type: "number" },
    ],
    rows,
  };
}

/** Both datasets, by name. */
export function contextSheets(counted: CountedFolders, read: readonly ListNote[], now: number): ReadonlyMap<string, Sheet> {
  // Each folder's read carries the front notes above it, so one note can come twice: counted once.
  const notes = [...new Map(read.map((note) => [note.path, note])).values()];
  return new Map([
    ["notes-by-status", notesByStatus(counted.byStatus, notes, now)],
    ["time-to-answered", timeToAnswered(counted.answered, notes)],
  ]);
}
