import { pasteImageLeafOf } from "@context/shared/src/pasteImage";
import { bytesFromBase64, dataUrlFor } from "../console/files/imageBytes";
import { readableAt, type CacheScope } from "./keys";
import type { MirrorStore } from "./mirrorStoreCore";
import { sha256Hex } from "./pictureHash";

/**
 * Pictures kept on this device: the ones a note here has shown, and the ones
 * pasted here offline, waiting to be sent (owner, 2026-11-09, approving the
 * offline-first boards: "pictures kept on the phone").
 *
 * ## Where
 *
 * In the mirror's own store, in a `pictures` slot beside each clearance's
 * note bodies: one file per picture natively, one IndexedDB row on the
 * desktop. So everything that clears the mirror (signing out, leaving a
 * workspace, losing access to it) clears these with it, and a picture is
 * filed under the clearance that read it and read back only at that one or
 * above (`readableAt`), as a note's body is. A browser tab keeps no mirror
 * and so keeps no pictures: there, pictures are the server's, as notes are.
 *
 * ## Named as the server will name them
 *
 * A pasted picture is stored under `paste-<SHA-256>.<ext>` of its bytes, and
 * the rule is `@context/shared`'s `pasteImageLeafOf`, the one the control
 * plane uses. A picture pasted offline is named here first, the note embeds
 * that name at once, and the upload later lands under the same one: nothing
 * in the note is rewritten when the connection comes back.
 *
 * ## Bounded
 *
 * Shown pictures are a cache: past `PICTURE_BUDGET` the least recently shown
 * go. A picture waiting to be sent is never evicted; it is the only copy.
 */

/** The most this device keeps of pictures it has only shown, per clearance and workspace. */
export const PICTURE_BUDGET = 150 * 1024 * 1024;

const SLOT = "pictures" as const;
/** Not a leaf: every leaf starts with a letter (`writeImage`'s rule). */
const INDEX = ".index";

interface PictureEntry {
  /** Bytes as kept: the data URL's length. */
  size: number;
  usedAt: number;
  /** Pasted here and not yet in the bucket. */
  pending?: { contentType: string; queuedAt: number };
}

type PictureIndex = Record<string, PictureEntry>;

/** The picture's stored name, from its bytes, or `null` for a type the store does not take. */
export async function pictureLeaf(bytes: ArrayBuffer, contentType: string): Promise<string | null> {
  return pasteImageLeafOf(await sha256Hex(bytes), contentType);
}

/** A leaf this module will file: what the control plane names, and nothing else. */
function isPictureLeaf(leaf: string): boolean {
  return /^paste-[a-f0-9]{8,16}\.[a-z]+$/.test(leaf);
}

function isPictureSrc(src: string): boolean {
  return src.startsWith("data:image/");
}

/*
  One index per clearance and workspace, updated read-modify-write. The store
  orders single operations; this orders the updates, so two pictures kept at
  once do not each write an index missing the other.
*/
const chains = new Map<string, Promise<unknown>>();
function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
  chains.set(key, next.catch(() => {}));
  return next;
}

async function readPictureIndex(store: MirrorStore, scope: CacheScope, workspaceId: string): Promise<PictureIndex> {
  const raw = await store.readBody(scope, workspaceId, SLOT, INDEX);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as PictureIndex) : {};
  } catch {
    return {};
  }
}

/**
 * Keep a picture on this device. `pending` marks one pasted here that the
 * bucket does not have yet. `false` when the session ended, the leaf is not
 * one the server names, or the source is not a picture.
 */
export function keepPicture(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  picture: { leaf: string; src: string; pending?: { contentType: string } },
  now: number,
): Promise<boolean> {
  const { leaf, src } = picture;
  if (!isPictureLeaf(leaf) || !isPictureSrc(src)) return Promise.resolve(false);
  return serially(`${scope}\u001f${workspaceId}`, async () => {
    const index = await readPictureIndex(store, scope, workspaceId);
    const known = index[leaf];
    if (known === undefined || known.size !== src.length) {
      if (!(await store.writeBody(epoch, scope, workspaceId, SLOT, leaf, src))) return false;
    }
    const pending = picture.pending === undefined ? known?.pending : { ...picture.pending, queuedAt: now };
    index[leaf] = { size: src.length, usedAt: now, ...(pending === undefined ? {} : { pending }) };
    for (const gone of overBudget(index)) {
      delete index[gone];
      await store.removeBody(scope, workspaceId, SLOT, gone);
    }
    return store.writeBody(epoch, scope, workspaceId, SLOT, INDEX, JSON.stringify(index));
  });
}

/** The least recently shown pictures past the budget. Never one waiting to be sent. */
export function overBudget(index: PictureIndex): string[] {
  let total = 0;
  for (const entry of Object.values(index)) total += entry.size;
  const gone: string[] = [];
  const shown = Object.entries(index)
    .filter(([, entry]) => entry.pending === undefined)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [leaf, entry] of shown) {
    if (total <= PICTURE_BUDGET) break;
    total -= entry.size;
    gone.push(leaf);
  }
  return gone;
}

/** A picture this device keeps, read at this clearance or a narrower one, or `null`. */
export async function devicePicture(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  leaf: string,
): Promise<string | null> {
  if (!isPictureLeaf(leaf)) return null;
  for (const at of readableAt(scope)) {
    const src = await store.readBody(at, workspaceId, SLOT, leaf);
    if (src !== null && isPictureSrc(src)) return src;
  }
  return null;
}

/** How many pictures pasted here are waiting to be sent. */
export async function pendingPictureCount(store: MirrorStore, scope: CacheScope, workspaceId: string): Promise<number> {
  const index = await readPictureIndex(store, scope, workspaceId);
  return Object.values(index).filter((entry) => entry.pending !== undefined).length;
}

/**
 * Send every picture pasted here offline, oldest first, and stop at the first
 * failure: the connection is gone again, and the rest wait with it. A picture
 * the server stored is kept as a shown one. `send` answers the server's own
 * name for it, which the shared rule makes the same; if it ever is not, the
 * picture is still settled, since a second send would store it under the same
 * other name.
 */
export async function sendPendingPictures(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  send: (picture: { bytes: ArrayBuffer; contentType: string }) => Promise<string>,
  mine: () => boolean,
): Promise<{ sent: number; failed: boolean }> {
  const index = await readPictureIndex(store, scope, workspaceId);
  const waiting = Object.entries(index)
    .filter((entry): entry is [string, PictureEntry & { pending: NonNullable<PictureEntry["pending"]> }] =>
      entry[1].pending !== undefined,
    )
    .sort((a, b) => a[1].pending.queuedAt - b[1].pending.queuedAt);
  let sent = 0;
  for (const [leaf, entry] of waiting) {
    if (!mine()) return { sent, failed: false };
    const src = await store.readBody(scope, workspaceId, SLOT, leaf);
    if (src === null || !isPictureSrc(src)) {
      // The only copy is gone: nothing to send, and nothing to wait for.
      await settle(store, epoch, scope, workspaceId, leaf);
      continue;
    }
    try {
      await send({ bytes: bytesFromBase64(src.slice(src.indexOf(",") + 1)), contentType: entry.pending.contentType });
    } catch {
      return { sent, failed: true };
    }
    await settle(store, epoch, scope, workspaceId, leaf);
    sent += 1;
  }
  return { sent, failed: false };
}

function settle(store: MirrorStore, epoch: number, scope: CacheScope, workspaceId: string, leaf: string): Promise<boolean> {
  return serially(`${scope}\u001f${workspaceId}`, async () => {
    const index = await readPictureIndex(store, scope, workspaceId);
    const entry = index[leaf];
    if (entry === undefined) return true;
    const { pending: _sent, ...shown } = entry;
    index[leaf] = shown;
    return store.writeBody(epoch, scope, workspaceId, SLOT, INDEX, JSON.stringify(index));
  });
}

/** The data URL a picture is kept as. */
export function pictureSrc(bytes: ArrayBuffer, contentType: string): string {
  return dataUrlFor(bytes, contentType);
}
