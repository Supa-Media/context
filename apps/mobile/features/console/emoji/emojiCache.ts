/**
 * Custom emoji pictures this session has fetched, by workspace and name.
 *
 * One cache for both roads a picture takes: the web editor asks the emoji
 * provider directly, and the native editor asks over the image bridge, which
 * lands in `useWritesAndImages`. Both come here, so a note drawn on either
 * fetches each emoji once, and adding or removing one forgets it for both.
 */

import { dataUrlFor } from "../files/imageBytes";

type Read = (args: { name: string }) => Promise<{ bytes: ArrayBuffer; contentType: string }>;

const pictures = new Map<string, Promise<string | null>>();

const keyOf = (workspaceId: string, name: string): string => `${workspaceId}|${name}`;

/** A `data:` URL for `:name:` in this workspace, or `null` when it has none. */
export function loadCustomEmoji(workspaceId: string, name: string, read: Read): Promise<string | null> {
  const key = keyOf(workspaceId, name);
  const cached = pictures.get(key);
  if (cached !== undefined) return cached;
  const pending = read({ name })
    .then((picture) => dataUrlFor(picture.bytes, picture.contentType))
    .catch(() => {
      // A miss is not remembered: the emoji may be added a moment from now.
      pictures.delete(key);
      return null;
    });
  pictures.set(key, pending);
  return pending;
}

/** Forget one emoji, or every emoji of a workspace, after it changed. */
export function forgetCustomEmoji(workspaceId: string, name?: string): void {
  if (name !== undefined) {
    pictures.delete(keyOf(workspaceId, name));
    return;
  }
  for (const key of [...pictures.keys()]) if (key.startsWith(`${workspaceId}|`)) pictures.delete(key);
}
