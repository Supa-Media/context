/**
 * A published site's emoji as the editor's host: the pictures the site sent
 * with its pages, read-only. The homepage opens its notes in the app's own
 * editor, and this is what lets that editor draw a workspace's `:name:` there
 * without an account or a server call.
 */

import { useMemo, useRef } from "react";

import type { EmojiPictures } from "../../share/emojiPictures";
import type { CustomEmojiValue } from "./context";

const READ_ONLY = "Emoji on a published site cannot be changed here.";

export function usePublishedEmoji(pictures: EmojiPictures): CustomEmojiValue {
  // A new set of pictures (a Publish) is a new generation, so a drawn note
  // asks again for any name it drew as text.
  const generation = useRef(0);
  return useMemo(() => {
    generation.current += 1;
    const names = Object.keys(pictures);
    return {
      generation: generation.current,
      names,
      canEdit: false,
      custom: () => names,
      load: (name: string) => Promise.resolve(pictures[name] ?? null),
      rename: () => Promise.resolve(READ_ONLY),
      remove: () => Promise.resolve(READ_ONLY),
    };
  }, [pictures]);
}
