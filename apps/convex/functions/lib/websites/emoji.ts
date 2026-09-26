/**
 * The workspace emoji a published page shows, carried with the page.
 *
 * A site loads no images (`docs/decisions/websites.md`), so a `:name:` a page
 * uses arrives inside the answer, as a `data:` URL, rather than as an address
 * a visitor's browser fetches. Only names the published text uses outside code
 * are read: publishing a page publishes the pictures in it and nothing else
 * from the workspace's emoji. A name with no emoji, a read that fails, or a
 * picture over the caps is simply absent, and the page shows its name.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { publishedEmojiNames } from "@context/shared";

/** How many different emoji one answer carries. */
export const MAX_PUBLISHED_EMOJI = 48;
/** One picture's bytes; a bigger one shows as its name. */
export const MAX_PUBLISHED_EMOJI_BYTES = 128 * 1024;
/** All pictures in one answer together. */
export const MAX_PUBLISHED_EMOJI_TOTAL = 768 * 1024;

const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** `name → data: URL` for the emoji `markdowns` use, within the caps. */
export async function readPublishedEmoji(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  markdowns: readonly string[],
): Promise<Record<string, string>> {
  const names = [...new Set(markdowns.flatMap(publishedEmojiNames))].slice(0, MAX_PUBLISHED_EMOJI);
  if (names.length === 0) return {};
  const pictures = await Promise.all(
    names.map((name) =>
      ctx
        .runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "team" as const,
          grantedNames: [],
          operation: { kind: "emojiRead" as const, name },
        })
        .catch(() => null),
    ),
  );
  const emoji: Record<string, string> = {};
  let total = 0;
  names.forEach((name, index) => {
    const picture = pictures[index];
    if (picture?.kind !== "emojiImage" || !PICTURE_TYPES.has(picture.contentType)) return;
    const size = picture.bytes.byteLength;
    if (size > MAX_PUBLISHED_EMOJI_BYTES || total + size > MAX_PUBLISHED_EMOJI_TOTAL) return;
    total += size;
    emoji[name] = `data:${picture.contentType};base64,${base64(new Uint8Array(picture.bytes))}`;
  });
  return emoji;
}
