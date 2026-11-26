/**
 * The Areas folder's cards, `bots/<bot>/about.md` and the older `people/<holder>.md`, read from wherever the page is.
 *
 * A folder page holds its own folder's notes and the front notes above it
 * (`pageCache.ts` `readFolder`). The cards live beside the areas rather than
 * under any one, so a page opened on an area or a sub-area never held them: a
 * bot's logo, named on its card, fell back to the plain robot one level down
 * (the owner, 2026-11-25: "the images arent loading when you get out of the
 * first layer?"), and the card looked missing to anything that edits it there.
 *
 * The bots folder beside the Areas folder (the owner, 2026-11-25: "top level
 * bots yes") is read on every page, the Areas folder's own included. The
 * cards still in the Areas folder (`people/` and the old `bots/`) are in the
 * Areas folder's own read, so only a page below it reads them. Each is drawn
 * first from what an earlier read already holds.
 */

import { useEffect, useMemo, useState } from "react";
import type { FolderListSource, ListNote } from "../../listBlock/model";
import { cachedFolder, readFolder } from "../pageCache";
import { botsFolder, isBotCardPath, legacyBotsFolder, peopleFolder } from "./seat";

const NONE: readonly ListNote[] = [];

/** Only the cards: the notes directly in `people/`, and each bot's `bots/<bot>/about.md` (beside the Areas folder or in it). */
function cardsIn(notes: readonly ListNote[], root: string): readonly ListNote[] {
  const people = `${peopleFolder(root)}/`;
  return notes.filter((note) => (note.path.startsWith(people) && !note.path.slice(people.length).includes("/")) || isBotCardPath(root, note.path));
}

/** The folders a page at `folder` must read for its cards. */
function cardFolders(root: string, folder: string): readonly string[] {
  return folder === root ? [botsFolder(root)] : [botsFolder(root), legacyBotsFolder(root), peopleFolder(root)];
}

/** `notes` with the Areas folder's cards added where the page's own read does not hold them. */
export function useAreaCards(source: FolderListSource | undefined, root: string, folder: string, notes: readonly ListNote[]): readonly ListNote[] {
  const folders = cardFolders(root, folder);
  const key = folders.join("\n");
  const [read, setRead] = useState<{ source: FolderListSource; key: string; notes: readonly ListNote[] } | null>(null);
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    void Promise.all(key.split("\n").map((each) => readFolder(source, each).catch(() => null)))
      .then((found) => {
        if (current) setRead({ source, key, notes: cardsIn(found.flatMap((each) => each?.notes ?? NONE), root) });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [source, key, root]);
  return useMemo(() => {
    if (source === undefined) return notes;
    const cards = read !== null && read.source === source && read.key === key ? read.notes : cardsIn(key.split("\n").flatMap((each) => cachedFolder(source, each)?.notes ?? NONE), root);
    if (cards.length === 0) return notes;
    const held = new Set(notes.map((note) => note.path));
    const missing = cards.filter((card) => !held.has(card.path));
    return missing.length === 0 ? notes : [...notes, ...missing];
  }, [source, notes, read, key, root]);
}
