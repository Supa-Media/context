import { deviceFirst } from "./deviceFirst";
import { devicePicture, keepPicture } from "./devicePictures";
import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { openMirrorStore } from "./mirrorStore";

/**
 * Bots' logos kept on this device (the phone and desktop apps, which keep a copy of the notes), so a logo is drawn at
 * once on the next launch while the server is asked again (`botPictures.ts`; Dev2, 2026-11-26: "can we have it be
 * instant? like the person images?"). Kept in the mirror's `pictures` slot under the clearance that read it, so
 * signing out or losing the workspace clears it with the notes (`devicePictures.ts`). A browser tab keeps none.
 */
export async function keptLogo(scope: CacheScope, workspaceId: string, leaf: string): Promise<string | null> {
  if (!deviceFirst()) return null;
  try {
    const mirror = await openMirrorStore();
    return mirror === null ? null : await devicePicture(mirror, scope, workspaceId, leaf);
  } catch {
    return null;
  }
}

/** Keep a logo the server just answered, for the next launch. Never fails the drawing. */
export function keepLogo(scope: CacheScope, workspaceId: string, leaf: string, src: string): void {
  if (!deviceFirst()) return;
  const epoch = currentEpoch();
  void (async () => {
    const mirror = await openMirrorStore();
    if (mirror !== null) await keepPicture(mirror, epoch, scope, workspaceId, { leaf, src }, Date.now());
  })().catch(() => undefined);
}
