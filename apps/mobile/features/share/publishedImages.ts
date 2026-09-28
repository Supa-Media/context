/**
 * The pasted pictures a published page carries, `leaf → data: URL`, checked.
 *
 * A site loads no images, so these arrive with the page
 * (`lib/websites/images.ts` in the control plane), the way its emoji do
 * (`emojiPictures.ts`). Only a picture of one of the four types, inline, under
 * a stored leaf, is kept: anything else would be an address the reader's
 * browser fetches, which is exactly what a site never does. A dropped entry
 * shows as a missing picture.
 */

import { PUBLISHED_IMAGE_LEAF } from "@context/shared";

const PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX = 24;

export type PublishedImages = Readonly<Record<string, string>>;

export const NO_PUBLISHED_IMAGES: PublishedImages = {};

export function publishedImages(value: unknown): PublishedImages {
  const kept: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return kept;
  for (const [leaf, url] of Object.entries(value).slice(0, MAX)) {
    if (PUBLISHED_IMAGE_LEAF.test(leaf) && typeof url === "string" && PICTURE.test(url)) kept[leaf] = url;
  }
  return kept;
}
