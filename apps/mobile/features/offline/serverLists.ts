import { noteHeading, noteProperties } from "../../../mcp/src/lists.js";
import { FRONT_NOTES } from "../../../mcp/src/lists/grammar.js";
import { noteLede } from "../console/files/folderPage/lede";
import { isNotePath } from "./mirror";
import type { BatchRead, ManifestPage } from "./mirrorSync";
import type { ListNote, ListSource, PropertyValue } from "../console/files/listBlock/model";

/**
 * The notes a folder List or Board chooses from, read from the server.
 *
 * **Online, the server answers** (decided by the owner, 2026-10-08), and in a
 * browser it is the only answer: the web keeps no copy of a workspace, only
 * the desktop and phone apps do. So a List walks the folder's manifest
 * (`syncManifest` with `folder`, filtered by the same `canSee` as every read)
 * and reads the notes whose version it has not parsed yet through `readNotes`,
 * fifty at a time and `READ_PARALLEL` calls at once. Parsed properties are
 * kept in memory only, keyed by version, so a redraw re-reads only notes that
 * changed; nothing is written to the device. `mirrorLists.ts` is the offline
 * half and parses the same way.
 *
 * The reads are plain (`readNotes` with `plain`): the Markdown as stored, one
 * bucket GET a note, without opening each note's collaboration document — a
 * List wants front matter, not an editable copy. That and asking several
 * batches at once is most of what took a project Board from minutes to
 * seconds (2026-10-08).
 */

export interface ServerListIO {
  manifest(folder: string, cursor: string | undefined): Promise<ManifestPage>;
  readNotes(paths: string[]): Promise<BatchRead[]>;
  /**
   * One page of the folder's notes from the tree's properties table
   * (`folderNotes`): front matter already parsed, one query. Absent where
   * there is no such call; `available: false` where the table cannot answer.
   */
  folderNotes?(folder: string, subfolders: boolean, cursor: string | undefined): Promise<FolderNotesPage>;
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
 * The folder's notes from the tree's properties table, or null when the table
 * cannot answer and the folder is read from the bucket instead
 * (`serverListNotes`). Decided by the owner, 2026-10-09: a project Board is
 * one query, whatever the folder holds.
 */
export async function tableListNotes(
  io: ServerListIO,
  folder: string,
  subfolders: boolean,
): Promise<ListSource | null> {
  if (io.folderNotes === undefined) return null;
  const notes: ListNote[] = [];
  const missing: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TABLE_PAGES; page += 1) {
    const answer = await io.folderNotes(folder, subfolders, cursor);
    if (!answer.available) return null;
    for (const row of answer.notes) {
      const parsed = JSON.parse(row.props) as { properties?: Record<string, PropertyValue>; heading?: string | null; lede?: string | null };
      notes.push({
        path: row.path,
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
        properties: parsed.properties ?? {},
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

/** Parsed notes by path, each at the version it was parsed from. */
export type ServerListMemo = Map<string, { etag: string; note: ListNote }>;

const READ_BATCH = 50;
/** `readNotes` calls in flight at once. Each is one Convex action reading eight notes at a time. */
export const READ_PARALLEL = 4;
const MAX_PAGES = 20;

function inFolder(path: string, folder: string, subfolders: boolean): boolean {
  const prefix = folder === "" ? "" : `${folder}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
  return subfolders || !rest.includes("/");
}

export function parseListNote(path: string, body: string, updatedAt?: number): ListNote {
  return {
    path,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    properties: noteProperties(body) as Record<string, PropertyValue>,
    heading: noteHeading(body) as string | null,
    lede: noteLede(body),
  };
}

export async function serverListNotes(
  io: ServerListIO,
  memo: ServerListMemo,
  folder: string,
  subfolders: boolean,
): Promise<ListSource> {
  const listed: { path: string; etag?: string; updatedAt?: number }[] = [];
  let complete = true;
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      complete = false;
      break;
    }
    const result = await io.manifest(folder, cursor);
    for (const entry of result.entries) {
      if (isNotePath(entry.path) && inFolder(entry.path, folder, subfolders)) listed.push(entry);
    }
    if (result.truncated) complete = false;
    if (result.truncated || result.cursor === null || result.cursor === cursor) break;
    cursor = result.cursor;
  }

  const notes: ListNote[] = [];
  const missing: string[] = [];
  const wanted: string[] = [];
  const versions = new Map<string, { etag?: string; updatedAt?: number }>();
  for (const entry of listed) {
    versions.set(entry.path, entry);
    const known = memo.get(entry.path);
    if (known !== undefined && entry.etag !== undefined && known.etag === entry.etag) notes.push(known.note);
    else wanted.push(entry.path);
  }

  const queue = [...wanted];
  let stalled = false;
  const reader = async (): Promise<void> => {
    while (queue.length > 0 && !stalled) {
      const batch = queue.splice(0, READ_BATCH);
      const results = await io.readNotes(batch);
      const deferred: string[] = [];
      let read = 0;
      for (const result of results) {
        if (!batch.includes(result.path)) continue; // an answer to a question not asked
        if (result.outcome === "deferred") {
          deferred.push(result.path);
          continue;
        }
        if (result.outcome === "error") {
          // Refused or gone since the walk: not a row, and not a gap either.
          if (result.code !== "FILE_NOT_FOUND") missing.push(result.path);
          continue;
        }
        read += 1;
        // Encrypted notes are left out, as offline: their frontmatter is sealed.
        if (result.note.encrypted === true) continue;
        const version = versions.get(result.path);
        const note = parseListNote(result.path, result.note.text, version?.updatedAt);
        memo.set(result.path, { etag: version?.etag ?? result.note.etag, note });
        notes.push(note);
      }
      if (read === 0 && deferred.length === batch.length) {
        // The byte budget let nothing through; asking again would ask forever.
        stalled = true;
        missing.push(...deferred, ...queue.splice(0));
        return;
      }
      queue.unshift(...deferred);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_PARALLEL, Math.ceil(queue.length / READ_BATCH)) }, reader));
  // Anything another reader put back after one stalled was never answered.
  missing.push(...queue.splice(0));

  for (const path of [...memo.keys()]) {
    if (inFolder(path, folder, subfolders) && !versions.has(path)) memo.delete(path);
  }
  return { notes, complete: complete && missing.length === 0, ...(complete ? { missing } : {}) };
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
      notes.push(parseListNote(result.path, result.note.text));
    }
  }
  return notes;
}
