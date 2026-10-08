import { noteHeading, noteProperties } from "../../../mcp/src/lists.js";
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
 * fifty at a time. Parsed properties are kept in memory only, keyed by
 * version, so a redraw re-reads only notes that changed; nothing is written to
 * the device. `mirrorLists.ts` is the offline half and parses the same way.
 */

export interface ServerListIO {
  manifest(folder: string, cursor: string | undefined): Promise<ManifestPage>;
  readNotes(paths: string[]): Promise<BatchRead[]>;
}

/** Parsed notes by path, each at the version it was parsed from. */
export type ServerListMemo = Map<string, { etag: string; note: ListNote }>;

const READ_BATCH = 50;
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
  while (queue.length > 0) {
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
      missing.push(...deferred, ...queue);
      break;
    }
    queue.unshift(...deferred);
  }

  for (const path of [...memo.keys()]) {
    if (inFolder(path, folder, subfolders) && !versions.has(path)) memo.delete(path);
  }
  return { notes, complete: complete && missing.length === 0, ...(complete ? { missing } : {}) };
}
