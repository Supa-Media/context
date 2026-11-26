/**
 * The bots folder's page: `bots/` beside the Areas folder lists every bot, and `bots/<bot>/` is that bot's page (the
 * owner, 2026-11-25: "top level bots yes", in place of the Areas folder's Bots and Mail tabs).
 *
 * A bot's page says which areas it holds, its caps there and its routines, so the page needs the Areas folder's notes
 * as well as its own: they are read once and drawn first from what an earlier read already holds (`pageCache.ts`).
 */

import { useEffect, useMemo, useState } from "react";
import type { FolderListSource, ListNote } from "../../listBlock/model";
import { cachedFolder, readFolder } from "../pageCache";
import { botsFolder, botsFolderOfBot } from "./seat";

/** What the folder at `folder` is: the bots folder (`bot` null), one bot's folder (its slug), or neither (null). */
export function botsShelfOf(root: string, folder: string): { bot: string | null } | null {
  if (root === "") return null;
  if (folder === botsFolder(root)) return { bot: null };
  if (botsFolderOfBot(root, folder) !== null) return { bot: folder.slice(folder.lastIndexOf("/") + 1) };
  return null;
}

/** The page's own notes and the Areas folder's, each once; null until both have come. */
export function useBotsFolderNotes(source: FolderListSource | undefined, root: string, active: boolean, notes: readonly ListNote[] | null): readonly ListNote[] | null {
  const [read, setRead] = useState<{ source: FolderListSource; root: string; notes: readonly ListNote[] } | null>(null);
  useEffect(() => {
    if (!active || source === undefined) return;
    let current = true;
    void readFolder(source, root)
      .then((found) => {
        if (current) setRead({ source, root, notes: found.notes });
      })
      .catch(() => {
        if (current) setRead({ source, root, notes: [] });
      });
    return () => {
      current = false;
    };
  }, [active, source, root]);
  return useMemo(() => {
    if (!active || source === undefined || notes === null) return null;
    const areas = read !== null && read.source === source && read.root === root ? read.notes : cachedFolder(source, root)?.notes;
    if (areas === undefined) return null;
    const held = new Set(notes.map((note) => note.path));
    return [...notes, ...areas.filter((note) => !held.has(note.path))];
  }, [active, source, root, notes, read]);
}
