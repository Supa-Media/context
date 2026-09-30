import { useEffect, useRef, useState } from "react";
import { publishedEmojiNames } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { emojiPictures, type EmojiPictures } from "../share/emojiPictures";

/** Reads a workspace emoji as a `data:` URL, or `null` when there is none. */
export type LoadEmoji = (name: string) => Promise<string | null>;

/** The caps a published page has (`lib/websites/emoji.ts`), with less in all: these ride in an address. */
const MAX_NAMES = 48;
const MAX_ONE = 128 * 1024;
const MAX_ALL = 512 * 1024;

/** The workspace emoji a scene and the pages it opens use, as the site would publish them. */
export function sceneEmojiNames(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => publishedEmojiNames(stripFrontmatter(text))))].slice(0, MAX_NAMES);
}

/**
 * The pictures for those names, read through the workspace's own emoji, so
 * the studio's stage draws `:annoyed:` the way the published page will. The
 * stage only keeps inline pictures of the four image types (`emojiPictures`);
 * anything bigger than the caps shows as its name, as it would on the site.
 */
export async function sceneEmoji(names: readonly string[], load: LoadEmoji): Promise<EmojiPictures> {
  const pictures = await Promise.all(names.map((name) => load(name).catch(() => null)));
  const kept: Record<string, string> = {};
  let total = 0;
  names.forEach((name, index) => {
    const url = pictures[index];
    if (typeof url !== "string" || url.length > MAX_ONE || total + url.length > MAX_ALL) return;
    total += url.length;
    kept[name] = url;
  });
  return emojiPictures(kept);
}

/** `sceneEmoji` for the texts on screen, read again only when the names change. */
export function useSceneEmoji(texts: readonly string[], load: LoadEmoji | undefined): EmojiPictures {
  const names = sceneEmojiNames(texts);
  const key = names.join(" ");
  const loader = useRef(load);
  loader.current = load;
  const [pictures, setPictures] = useState<EmojiPictures>({});
  useEffect(() => {
    const read = loader.current;
    if (read === undefined || names.length === 0) {
      setPictures((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }
    let live = true;
    void sceneEmoji(names, read).then((found) => {
      if (live) setPictures(found);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the names, not the array holding them
  }, [key]);
  return pictures;
}
