/**
 * The pictures in a shared note, asked for through the link.
 *
 * A member's console asks `readNoteImage` with the note on screen; a link's
 * reader asks `readSharedImage` with the link and the note on screen instead,
 * and the server reads that note through the link before handing back any
 * picture it embeds. Nothing here decides what may be shown: a picture the note
 * does not embed, a link that stopped working and a store that is down all come
 * back as `null`, and the editor draws the same absence for each.
 *
 * Cached on link, note and picture for as long as the page lives, because the
 * editor asks again every time it redraws a row.
 */

import type { ShortLinkAddress } from "./share";
import { dataUrlFor } from "../console/files/imageBytes";

export type SharedImageAddress = { token: string } | ShortLinkAddress;

export type ReadSharedImage = (
  args: SharedImageAddress & { path?: string; leaf: string },
) => Promise<{ bytes: ArrayBuffer; contentType: string }>;

export function sharedImageLoader(
  read: ReadSharedImage,
  address: SharedImageAddress,
  path: string,
  entryPath: string,
  cache: Map<string, string>,
): (target: string) => Promise<string | null> {
  return async (target) => {
    const key = `${path}|${target}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    try {
      // The entry note is asked for as itself, the way the page asked for it.
      const pathArg = path === entryPath ? {} : { path };
      const picture = await read({ ...address, ...pathArg, leaf: target });
      const src = dataUrlFor(picture.bytes, picture.contentType);
      cache.set(key, src);
      return src;
    } catch {
      return null;
    }
  };
}
