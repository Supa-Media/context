import { getNote, putNote } from "../cache";
import { forgetMirroredNote, mirroredNote, moveMirroredBody, putMirroredNotes } from "../mirror";
import { neededEtags } from "../mirrorHolds";
import { openMirrorStore } from "../mirrorStore";
import type { KeyValueStore } from "../memory";
import type { OpSent } from "../sync";
import type { CacheScope } from "../keys";
import type { OpenNote } from "../../console/files/types";

/*
  The three writers `useOfflineNotes` uses to move this device's copy of a note
  after something reached the bucket. Each is the body of one of that hook's
  `useCallback`s, which still owns the dependency list; everything it read from
  the render is handed in, and the epoch ref is read at call time as before.
  The epoch gate is argued in the file comment of `useOfflineNotes.ts`.
*/

/** What every copy writer below closes over. */
export interface CopyWriterInputs {
  workspaceId: string | null;
  scope: CacheScope | null;
  store: KeyValueStore;
  mine: () => boolean;
  epochRef: { readonly current: number };
}

/**
 * Move this device's copy of a note onto text and an etag that are now in the
 * bucket. The mirror where there is one — at every clearance holding the
 * note, keeping any ancestor still needed — and the bounded cache where there
 * is not. Neither invents an entry for a note it does not hold: a save result
 * carries none of the visibility fields.
 */
export function rememberSentCopy(
  { workspaceId, scope, store, mine, epochRef }: CopyWriterInputs,
  body: { path: string; text: string; etag: string },
): void {
    if (workspaceId === null || scope === null || !mine()) return;
    const epoch = epochRef.current;
    void (async () => {
      const mirror = await openMirrorStore();
      if (mirror !== null) {
        const needed = await neededEtags(store, workspaceId);
        if (!mine()) return;
        await moveMirroredBody(mirror, epoch, workspaceId, body, needed, Date.now());
        return;
      }
      const cached = await getNote(store, scope, workspaceId, body.path);
      /*
        Checked again here, and this is the one writer where the entry gate
        is not enough: every other one writes synchronously after it, or
        re-checks when its timer fires. This one awaits a read first, so the
        session can end in the gap.

        Web hid it — `store.web.ts` reads `localStorage` synchronously inside
        an async function, so the whole chain drains in microtasks before a
        press can be handled. Native does not: `AsyncStorage.getItem` is a
        queued bridge call, so a read issued before sign-out resolves after
        the clear has walked past that key, and the write behind it lands on
        a device whose session is over. Measured that way round, from
        `useFileBrowser`'s two call sites — a save, then sign out.
      */
      if (cached === null || !mine()) return;
      await putNote(
        store,
        scope,
        workspaceId,
        { ...cached.value, text: body.text, etag: body.etag },
        Date.now(),
      );
    })().catch(() => {});
}

/**
 * Move this device's copy of a note onto where an op just put it in the
 * bucket: a renamed note's body to its new name (at the version the move
 * returned, where it said), and a deleted or archived one off the device —
 * the next sync brings the archived copy back where the archive put it.
 * Without this the tree drawn from the mirror shows the note under its old
 * name, beside the new one, until the next sync prunes it.
 */
/** A note this device created, now in the bucket: into the mirror. See the drain. */
export function rememberCreatedCopy(
  { workspaceId, scope, store, mine, epochRef }: CopyWriterInputs,
  note: OpenNote,
): void {
    if (workspaceId === null || scope === null || !mine()) return;
    const epoch = epochRef.current;
    void (async () => {
      const mirror = await openMirrorStore();
      if (mirror === null) return;
      const needed = await neededEtags(store, workspaceId);
      if (!mine()) return;
      await putMirroredNotes(mirror, epoch, scope, workspaceId, [note], needed, Date.now());
    })().catch(() => {});
}

export function rememberOpDoneCopy(
  { workspaceId, scope, store, mine, epochRef }: CopyWriterInputs,
  done: OpSent,
): void {
    if (workspaceId === null || scope === null || !mine()) return;
    if (done.kind === "folder") return;
    const epoch = epochRef.current;
    void (async () => {
      const mirror = await openMirrorStore();
      if (mirror === null) return;
      if (done.kind === "move" && done.to !== undefined) {
        const copy = await mirroredNote(mirror, scope, workspaceId, done.path);
        if (copy !== null && mine()) {
          const needed = await neededEtags(store, workspaceId);
          if (!mine()) return;
          await putMirroredNotes(
            mirror,
            epoch,
            scope,
            workspaceId,
            [{ ...copy.value, path: done.to, etag: done.etag ?? copy.value.etag }],
            needed,
            Date.now(),
          );
        }
      }
      if (!mine()) return;
      await forgetMirroredNote(mirror, epoch, workspaceId, done.path);
    })().catch(() => {});
}
