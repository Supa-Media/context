import { CACHE_SCOPES } from "./keys";
import { placeBody, updateIndex, type Needed } from "./mirror";
import { publishMirrorNotesChanged } from "./mirrorEvents";
import { utf8Length } from "./mirrorPath";
import type { MirrorStore } from "./mirrorStoreCore";

/**
 * Move a mirrored note onto text and an etag that were just written.
 *
 * For a save that landed and a queued write that drained — the person's own
 * text, now in the bucket at `etag`. Only a note the mirror already holds is
 * moved, at every clearance that holds it: a save result carries none of the
 * visibility fields, so inventing an entry would put wrong access markers on a
 * note read offline, and the next sync lists it properly. Writing a person's
 * own text into a `team` copy discloses nothing: the entry being there is the
 * proof that clearance could read that path.
 */
export async function moveMirroredBody(
  store: MirrorStore,
  epoch: number,
  workspaceId: string,
  body: { path: string; text: string; etag: string; rawEtag?: string },
  needed: Needed,
  now: number,
): Promise<void> {
  let moved = false;
  for (const scope of CACHE_SCOPES) {
    const done = await updateIndex(
      store,
      epoch,
      scope,
      workspaceId,
      async (index) => {
        const existing = index.entries.get(body.path);
        if (existing === undefined || !existing.body) return false;
        const placed = await placeBody(
          store,
          epoch,
          scope,
          workspaceId,
          index,
          { ...body, encrypted: existing.encrypted === true },
          needed,
        );
        if (placed === false) return false;
        const { base: _previousBase, ...rest } = existing;
        const rawEtag = body.rawEtag ??
          (body.etag.startsWith("c2.") ? existing.rawEtag : body.etag);
        index.entries.set(body.path, {
          ...rest,
          etag: body.etag,
          ...(rawEtag === undefined ? {} : { rawEtag }),
          size: utf8Length(body.text),
          /*
            The note just changed, so it was edited now. Keeping the listing's
            old time left an edit made on this phone out of Home's Recent until
            the next full sync listed it again (owner, 2026-10-05: "a recently
            edited note that I edited doesn't show up in recents"). The next
            listing replaces it with the bucket's own time.
          */
          updatedAt: now,
          syncedAt: now,
          ...(placed.base !== undefined ? { base: placed.base } : {}),
        });
        return true;
      },
      { create: false },
    );
    moved ||= done;
  }
  // Home's Recent and the folder lists read these entries: tell them, as a sync does.
  if (moved) publishMirrorNotesChanged(workspaceId);
}
