import { writeNoteProperty } from "../console/files/listBlock/writeProperty";
import type { FolderListSource } from "../console/files/listBlock/model";
import type { OpenNote } from "../console/files/types";
import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { putMirroredNotes, type Needed } from "./mirror";
import { onMirrorListed, onMirrorNotesChanged, publishMirrorNotesChanged } from "./mirrorEvents";
import { mirroredListNotes } from "./mirrorLists";
import type { MirrorStore } from "./mirrorStoreCore";

/**
 * Where the console's folder lists read their notes, and the one road a list
 * write takes — `useFolderLists` without React, so it can be driven with a
 * store and a bucket in a test.
 *
 * **Reads** are this device's copy at one clearance (`mirroredListNotes`), and
 * a list re-reads whenever the mirror commits a new listing of the workspace
 * or new bodies for it.
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

export interface FolderListIO {
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
}

export function folderListSource({ workspaceId, scope, canEdit, io, openMirror, needed }: FolderListInputs): FolderListSource {
  return {
    load: async (folder, subfolders) => {
      const store = await openMirror();
      if (store === null) return null;
      return mirroredListNotes(store, scope, workspaceId, folder, subfolders);
    },
    subscribe: (listener) => {
      const mine = (changed: string) => {
        if (changed === workspaceId) listener();
      };
      const stopListed = onMirrorListed(mine);
      const stopNotes = onMirrorNotesChanged(mine);
      return () => {
        stopListed();
        stopNotes();
      };
    },
    ...(canEdit
      ? {
          setProperty: async (path: string, key: string, value: string | null, options?: { create?: boolean }) => {
            let written = path;
            const answer = await writeNoteProperty(
              {
                read: (at) => io.readNote(at),
                write: async (at, text, expectedEtag) => {
                  written = (await io.writeNote(at, text, expectedEtag)).path;
                },
              },
              path,
              key,
              value,
              options,
            );
            if (answer === null) await remember(written).catch(() => {});
            return answer;
          },
        }
      : {}),
  };

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
