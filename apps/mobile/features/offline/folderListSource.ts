import { rewriteNote, writeNoteProperties } from "../console/files/listBlock/writeProperty";
import { setNoteLede } from "../console/files/folderPage/lede";
import type { FolderListSource } from "../console/files/listBlock/model";
import type { OpenNote } from "../console/files/types";
import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { forgetMirroredNote, mirroredBodyAt, parseIndex, putMirroredNotes, type Needed } from "./mirror";
import { onMirrorListed, onMirrorNotesChanged, publishMirrorNotesChanged, requestMirrorFolder } from "./mirrorEvents";
import { mirroredListNotes } from "./mirrorLists";
import type { MirrorStore } from "./mirrorStoreCore";
import { onBucketWrite } from "../console/files/bucketWrites";
import { FRONT_NOTES } from "../../../mcp/src/lists/grammar.js";
import { serverFrontNotes, serverListNotes, tableListNotes, type ServerListIO, type ServerListMemo } from "./serverLists";

/**
 * Where the console's folder lists read their notes, and the one road a list
 * write takes — `useFolderLists` without React, so it can be driven with a
 * store and a bucket in a test.
 *
 * **Reads** come from the server whenever it can be reached (decided by the
 * owner, 2026-10-08: "when connected to the internet we should always be
 * using server"), through `serverListNotes`. This device's copy at one
 * clearance (`mirroredListNotes`) answers only offline, and only where there
 * is one: the desktop and phone apps. A browser keeps no copy at all. A list
 * re-reads after its own writes, after any write announced on the bucket bus,
 * and whenever the mirror commits a new listing or new bodies.
 *
 * **A write** reads the note from the bucket, changes one frontmatter line and
 * writes it back against the version read (`writeNoteProperty`). Then it
 * reads the note back and puts that into the mirror, and says so. That last
 * step is the fix for "I refresh and it goes back": a list draws from the
 * mirror, and without it the mirror kept the old copy until a sync happened to
 * fetch the note — while the page showed the new value only as an overlay held
 * in memory, which a refresh drops. Read back rather than composed from the
 * text sent: the bucket may have merged the write into someone's typing
 * (docs/decisions/collaboration.md), a new front note needs the visibility
 * fields a listing carries and a write result does not, and `putMirroredNotes`
 * keeps the ancestor any queued edit still needs.
 *
 * The write-back is a copy, never the change: if it fails, the write stands
 * and the next sync brings the note.
 */

export interface FolderListIO extends ServerListIO {
  readNote(path: string): Promise<OpenNote & { updatedAt?: number }>;
  /** `expectedEtag` undefined is a create, refused if the note exists. */
  writeNote(path: string, text: string, expectedEtag: string | undefined): Promise<{ path: string }>;
}

export interface FolderListInputs {
  workspaceId: string;
  /** The clearance the reader's role gives; copies are filed under it. */
  scope: CacheScope;
  canEdit: boolean;
  io: FolderListIO;
  openMirror: () => Promise<MirrorStore | null>;
  /** Which versions local work is based on — `neededEtags`. */
  needed: (workspaceId: string) => Promise<Needed>;
  /** False only when the device is known to be offline: then the mirror answers. */
  online: () => boolean;
}

/**
 * After notes were created, moved or removed outside `setProperty` — a
 * project List adding or nesting a task — `remember` reads `written` back
 * into this device's copy and drops `gone` from it, so a reload draws what
 * was saved rather than waiting for a sync ("A list write is what this
 * device holds afterwards"). Best effort: a failure leaves the next sync to
 * bring them. Absent for a reader who may not write.
 */
export interface ListWriteBack {
  remember?(written: readonly string[], gone: readonly string[]): Promise<void>;
}

export function folderListSource({ workspaceId, scope, canEdit, io, openMirror, needed, online }: FolderListInputs): FolderListSource & ListWriteBack {
  // Parsed frontmatter by version, in memory only, so a redraw reads only what changed.
  const memo: ServerListMemo = new Map();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    load: async (folder, subfolders) => {
      if (online()) {
        try {
          // The tree's properties table first: one query. Where it cannot
          // answer yet, every note is read from the bucket.
          const fromTable = await tableListNotes(io, folder, subfolders).catch(() => null);
          if (fromTable !== null) return fromTable;
          return await serverListNotes(io, memo, folder, subfolders);
        } catch (error) {
          // The server did not answer: the device's copy, where there is one, rather than nothing.
          const store = await openMirror().catch(() => null);
          if (store === null) throw error;
          return mirroredListNotes(store, scope, workspaceId, folder, subfolders);
        }
      }
      const store = await openMirror();
      if (store === null) return null;
      return mirroredListNotes(store, scope, workspaceId, folder, subfolders);
    },
    loadFront: async (folders) => {
      const offlineFront = async () => {
        const store = await openMirror().catch(() => null);
        if (store === null) return [];
        const out = [];
        for (const folder of folders) {
          const listed = await mirroredListNotes(store, scope, workspaceId, folder, false);
          for (const note of listed?.notes ?? []) {
            if (FRONT_NOTES.includes(note.path.slice(note.path.lastIndexOf("/") + 1))) out.push(note);
          }
        }
        return out;
      };
      if (online()) {
        try {
          return await serverFrontNotes(io, folders);
        } catch {
          return await offlineFront();
        }
      }
      return await offlineFront();
    },
    readBody: async (path) => {
      /*
        Online, the bucket through the server, which applies the reader's
        clearance. Offline (or if the server fails), this device's copy, read
        at exactly the clearance the lists are (`mirroredListNotes`' rule), so
        a team reader is never handed a body filed under private.
      */
      const fromServer = async () => {
        const note = await io.readNote(path);
        return { text: note.encrypted === true ? "" : note.text, encrypted: note.encrypted === true };
      };
      if (online()) {
        try {
          return await fromServer();
        } catch {
          // Fall through to the device's copy.
        }
      }
      const store = await openMirror().catch(() => null);
      if (store !== null) {
        const entry = parseIndex(await store.readIndex(scope, workspaceId))?.entries.get(path);
        if (entry?.encrypted === true) return { text: "", encrypted: true };
        const text = entry === undefined ? null : await mirroredBodyAt(store, scope, workspaceId, entry);
        if (text !== null) return { text, encrypted: false };
      }
      if (online()) return null;
      try {
        return await fromServer();
      } catch {
        return null;
      }
    },
    freshen: (folder) => requestMirrorFolder(workspaceId, folder),
    subscribe: (listener) => {
      const mine = (changed: string) => {
        if (changed === workspaceId) listener();
      };
      const stopListed = onMirrorListed(mine);
      const stopNotes = onMirrorNotesChanged(mine);
      const stopWrites = onBucketWrite((write) => mine(write.workspaceId));
      listeners.add(listener);
      return () => {
        stopListed();
        stopNotes();
        stopWrites();
        listeners.delete(listener);
      };
    },
    ...(canEdit
      ? {
          setProperty: (path: string, key: string, value: string | null, options?: { create?: boolean }) =>
            write(path, [[key, value]], options),
          setProperties: (
            path: string,
            changes: readonly (readonly [string, string | readonly string[] | null])[],
            options?: { create?: boolean },
          ) => write(path, changes, options),
          setLede: (path: string, text: string, options?: { create?: boolean }) =>
            rewrite(path, (current) => setNoteLede(current, text), options),
          remember: async (written: readonly string[], gone: readonly string[]) => {
            for (const path of written) await remember(path).catch(() => {});
            if (gone.length > 0) await forget(gone).catch(() => {});
            changed();
          },
        }
      : {}),
  };

  async function forget(paths: readonly string[]): Promise<void> {
    const epoch = currentEpoch();
    const store = await openMirror();
    if (store === null) return;
    for (const path of paths) {
      if (epoch !== currentEpoch()) return;
      await forgetMirroredNote(store, epoch, workspaceId, path);
    }
    if (epoch === currentEpoch()) publishMirrorNotesChanged(workspaceId);
  }

  async function write(
    path: string,
    changes: readonly (readonly [string, string | readonly string[] | null])[],
    options?: { create?: boolean },
  ): Promise<string | null> {
    return remembering(path, (noteIO) => writeNoteProperties(noteIO, path, changes, options));
  }

  async function rewrite(
    path: string,
    change: (text: string) => { text: string } | { error: string },
    options?: { create?: boolean },
  ): Promise<string | null> {
    return remembering(path, (noteIO) => rewriteNote(noteIO, path, change, options));
  }

  /** Run one write, then read what it wrote back into this device's copy. */
  async function remembering(
    path: string,
    run: (noteIO: Parameters<typeof rewriteNote>[0]) => Promise<string | null>,
  ): Promise<string | null> {
    let written = path;
    const answer = await run({
      read: (at) => io.readNote(at),
      write: async (at, text, expectedEtag) => {
        written = (await io.writeNote(at, text, expectedEtag)).path;
      },
    });
    if (answer === null) {
      await remember(written).catch(() => {});
      changed();
    }
    return answer;
  }

  async function remember(path: string): Promise<void> {
    const epoch = currentEpoch();
    const store = await openMirror();
    if (store === null) return;
    const note = await io.readNote(path);
    const holds = await needed(workspaceId);
    if (epoch !== currentEpoch()) return;
    const kept = await putMirroredNotes(store, epoch, scope, workspaceId, [note], holds, Date.now());
    if (kept && epoch === currentEpoch()) publishMirrorNotesChanged(workspaceId);
  }
}
