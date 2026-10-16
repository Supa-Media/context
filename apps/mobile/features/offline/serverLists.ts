import { inlineTags, noteHeading, noteProperties } from "../../../mcp/src/lists.js";
import { FRONT_NOTES } from "../../../mcp/src/lists/grammar.js";
import { noteLede } from "../console/files/folderPage/lede";
import type { BatchRead } from "./mirrorSync";
import type { ListNote, ListSource, PropertyValue } from "../console/files/listBlock/model";

/**
 * The notes a folder List or Board chooses from, read from the server.
 *
 * **Online, the server answers** (decided by the owner, 2026-10-08), and in a
 * browser it is the only answer: the web keeps no copy of a workspace, only
 * the desktop and phone apps do. `mirrorLists.ts` is the offline half and
 * parses the same way.
 *
 * The server answers from the Convex tree and each note's parsed front
 * matter (`folderNotes`), one query a page, and never reads a note for it
 * (decided by the owner, 2026-10-13: "the only thing that should be reading
 * from storage directly should be actually opening and editing a note"). A
 * note it has not parsed yet is a gap the List admits to (`missing`), and a
 * note saved since shows what was last parsed until the facts catch up. It
 * used to walk the folder and read every note whose version it had not
 * parsed, fifty at a time; that read is gone, not kept as a fallback.
 */

export interface ServerListIO {
  /** Reads by name: the front notes a folder page inherits statuses from (`serverFrontNotes`). */
  readNotes(paths: string[]): Promise<BatchRead[]>;
  /**
   * One page of the folder's notes with their front matter already parsed.
   * `available: false` where the server cannot answer yet.
   */
  folderNotes(folder: string, subfolders: boolean, cursor: string | undefined): Promise<FolderNotesPage>;
}

export interface FolderNotesPage {
  available: boolean;
  notes: { path: string; updatedAt?: number; props: string }[];
  cursor: string | null;
  missing: string[];
}

/** Pages of a folder read from the table, at most: a bound on a loop, not on a folder. */
const MAX_TABLE_PAGES = 50;

/**
 * The folder's notes from the server's parsed front matter (decided by the
 * owner, 2026-10-09: a project Board is one query, whatever the folder
 * holds). Where it cannot answer yet the List is drawn incomplete, never
 * filled in by reading the notes. A failure to answer at all is thrown, so
 * the caller can fall back to the device's copy.
 */
export async function tableListNotes(io: ServerListIO, folder: string, subfolders: boolean): Promise<ListSource> {
  const notes: ListNote[] = [];
  const missing: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TABLE_PAGES; page += 1) {
    const answer = await io.folderNotes(folder, subfolders, cursor);
    if (!answer.available) return { notes: [], complete: false };
    for (const row of answer.notes) {
      const parsed = JSON.parse(row.props) as {
        properties?: Record<string, PropertyValue>;
        inlineTags?: string[];
        heading?: string | null;
        lede?: string | null;
      };
      notes.push({
        path: row.path,
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
        properties: parsed.properties ?? {},
        ...(Array.isArray(parsed.inlineTags) && parsed.inlineTags.length > 0 ? { inlineTags: parsed.inlineTags } : {}),
        heading: parsed.heading ?? null,
        lede: parsed.lede ?? null,
      });
    }
    missing.push(...answer.missing);
    if (answer.cursor === null) return { notes, complete: missing.length === 0, missing };
    cursor = answer.cursor;
  }
  return { notes, complete: false };
}

const READ_BATCH = 50;

export function parseListNote(path: string, body: string, updatedAt?: number): ListNote {
  return {
    path,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    properties: noteProperties(body) as Record<string, PropertyValue>,
    inlineTags: inlineTags(body),
    heading: noteHeading(body) as string | null,
    lede: noteLede(body),
  };
}

/**
 * The front notes (`about.md`, `overview.md`, …) of each of `folders`, read by
 * name: what a folder page needs from the folders above it, whose status
 * lists it inherits (`folderPage/statuses.ts`). Asked for directly rather
 * than by walking each folder above, which for `1-projects/x` meant listing
 * and reading every note directly in `1-projects`. A path that is missing, or
 * hidden from this reader, answers as missing and is simply not a row.
 */
export async function serverFrontNotes(io: Pick<ServerListIO, "readNotes">, folders: readonly string[]): Promise<ListNote[]> {
  const paths = folders.flatMap((folder) => FRONT_NOTES.map((name) => (folder === "" ? name : `${folder}/${name}`)));
  const notes: ListNote[] = [];
  for (let at = 0; at < paths.length; at += READ_BATCH) {
    const batch = paths.slice(at, at + READ_BATCH);
    for (const result of await io.readNotes(batch)) {
      if (result.outcome !== "read" || !batch.includes(result.path) || result.note.encrypted === true) continue;
      // The text comes along: the page draws the front note's words, and need not read it again.
      notes.push({ ...parseListNote(result.path, result.note.text), text: result.note.text });
    }
  }
  return notes;
}
