/**
 * The pasted pictures a published page shows, carried with the page.
 *
 * A site loads no images (`docs/decisions/websites.md`), so an `![[paste-….png]]`
 * a page embeds arrives inside the answer, as a `data:` URL, the way its emoji
 * do (`./emoji.ts`). Only leaves the published text embeds outside code are
 * read (`publishedImageLeaves`): publishing a page publishes the pictures in
 * it and no other object in the store. A leaf with no object, a read that
 * fails, or a picture over the caps is simply absent, and the page says so
 * where the picture would be.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { publishedImageLeaves } from "@context/shared";
import { PUBLICATION_CLEARANCE } from "./publication";

/** How many different pictures one answer carries. */
export const MAX_PUBLISHED_IMAGES = 24;
/** One picture's bytes; a bigger one is left out. A pasted screenshot fits. */
export const MAX_PUBLISHED_IMAGE_BYTES = 2 * 1024 * 1024;
/** All pictures in one answer together, the homepage's whole site included. */
export const MAX_PUBLISHED_IMAGES_TOTAL = 4 * 1024 * 1024;

const PICTURE_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** `leaf → data: URL` for the stored pictures `markdowns` embed, within the caps. */
export async function readPublishedImages(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  markdowns: readonly string[],
): Promise<Record<string, string>> {
  const leaves = [...new Set(markdowns.flatMap(publishedImageLeaves))].slice(0, MAX_PUBLISHED_IMAGES);
  if (leaves.length === 0) return {};
  const pictures = await Promise.all(
    leaves.map((leaf) =>
      ctx
        .runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          ...PUBLICATION_CLEARANCE,
          operation: { kind: "readImage" as const, leaf },
        })
        .catch(() => null),
    ),
  );
  const images: Record<string, string> = {};
  let total = 0;
  leaves.forEach((leaf, index) => {
    const picture = pictures[index];
    // The type comes from the extension, as `readNoteImage` takes it: the store
    // is not obliged to hand one back.
    const type = PICTURE_TYPES.get(leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase());
    if (picture?.kind !== "image" || type === undefined) return;
    const size = picture.bytes.byteLength;
    if (size > MAX_PUBLISHED_IMAGE_BYTES || total + size > MAX_PUBLISHED_IMAGES_TOTAL) return;
    total += size;
    images[leaf] = `data:${type};base64,${base64(new Uint8Array(picture.bytes))}`;
  });
  return images;
}
