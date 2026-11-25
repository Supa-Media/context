/**
 * The Areas folder's cards, `bots/<bot>/about.md` and the older `people/<holder>.md`, read from wherever the page is.
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
import { botsFolder, isBotCardPath, peopleFolder } from "./seat";

const NONE: readonly ListNote[] = [];

/** Only the cards: the notes directly in `people/`, and each bot's `bots/<bot>/about.md`. */
function cardsIn(notes: readonly ListNote[], root: string): readonly ListNote[] {
  const people = `${peopleFolder(root)}/`;
  return notes.filter((note) => (note.path.startsWith(people) && !note.path.slice(people.length).includes("/")) || isBotCardPath(root, note.path));
}

/** `notes` with the Areas folder's cards added where the page's own read does not hold them. */
export function useAreaCards(source: FolderListSource | undefined, root: string, folder: string, notes: readonly ListNote[]): readonly ListNote[] {
  const needed = folder !== root && source !== undefined;
  const [read, setRead] = useState<{ source: FolderListSource; root: string; notes: readonly ListNote[] } | null>(null);
  useEffect(() => {
    if (!needed || source === undefined) return;
    let current = true;
    void Promise.all([readFolder(source, peopleFolder(root)).catch(() => null), readFolder(source, botsFolder(root)).catch(() => null)])
      .then(([people, bots]) => {
        if (current) setRead({ source, root, notes: cardsIn([...(people?.notes ?? NONE), ...(bots?.notes ?? NONE)], root) });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [needed, source, root]);
  return useMemo(() => {
    if (!needed || source === undefined) return notes;
    const cards =
      read !== null && read.source === source && read.root === root
        ? read.notes
        : cardsIn([...(cachedFolder(source, peopleFolder(root))?.notes ?? NONE), ...(cachedFolder(source, botsFolder(root))?.notes ?? NONE)], root);
    if (cards.length === 0) return notes;
    const held = new Set(notes.map((note) => note.path));
    const missing = cards.filter((card) => !held.has(card.path));
    return missing.length === 0 ? notes : [...notes, ...missing];
  }, [needed, source, notes, read, root]);
}
