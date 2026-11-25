/**
 * The Areas folder's `people/` cards, read from wherever the page is.
 *
 * A folder page holds its own folder's notes and the front notes above it
 * (`pageCache.ts` `readFolder`). The cards live in the Areas folder's
 * `people/`, beside the areas rather than under any one, so a page opened on
 * an area or a sub-area never held them: a bot's logo, named on its card,
 * fell back to the plain robot one level down (the owner, 2026-11-25: "the
 * images arent loading when you get out of the first layer?"), and the card
 * looked missing to anything that edits it there.
 *
 * On the Areas folder itself its own notes already hold them, so nothing more
 * is read. Below it the cards folder is read once, drawn first from what a
 * read of the Areas folder already holds.
 */

import { useEffect, useMemo, useState } from "react";
import type { FolderListSource, ListNote } from "../../listBlock/model";
import { cachedFolder, readFolder } from "../pageCache";
import { peopleFolder } from "./seat";

const NONE: readonly ListNote[] = [];

/** Only the cards: the notes directly in the cards folder. */
function cardsIn(notes: readonly ListNote[], folder: string): readonly ListNote[] {
  const prefix = `${folder}/`;
  return notes.filter((note) => note.path.startsWith(prefix) && !note.path.slice(prefix.length).includes("/"));
}

/** `notes` with the Areas folder's cards added where the page's own read does not hold them. */
export function useAreaCards(source: FolderListSource | undefined, root: string, folder: string, notes: readonly ListNote[]): readonly ListNote[] {
  const cardsFolder = peopleFolder(root);
  const needed = folder !== root && source !== undefined;
  const [read, setRead] = useState<{ source: FolderListSource; folder: string; notes: readonly ListNote[] } | null>(null);
  useEffect(() => {
    if (!needed || source === undefined) return;
    let current = true;
    void readFolder(source, cardsFolder)
      .then((result) => {
        if (current) setRead({ source, folder: cardsFolder, notes: cardsIn(result.notes, cardsFolder) });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [needed, source, cardsFolder]);
  return useMemo(() => {
    if (!needed || source === undefined) return notes;
    const cards =
      read !== null && read.source === source && read.folder === cardsFolder
        ? read.notes
        : cardsIn(cachedFolder(source, cardsFolder)?.notes ?? NONE, cardsFolder);
    if (cards.length === 0) return notes;
    const held = new Set(notes.map((note) => note.path));
    const missing = cards.filter((card) => !held.has(card.path));
    return missing.length === 0 ? notes : [...notes, ...missing];
  }, [needed, source, notes, read, cardsFolder]);
}
