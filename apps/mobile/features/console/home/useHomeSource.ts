import { useEffect, useMemo, useState } from "react";
import { currentEpoch } from "../../offline/epoch";
import { readIndex, treeOf } from "../../offline/mirror";
import { onMirrorListed, onMirrorNotesChanged } from "../../offline/mirrorEvents";
import { mirroredListNotes } from "../../offline/mirrorLists";
import { openMirrorStore } from "../../offline/mirrorStore";
import { tagsOf } from "../files/folderPage/taskProps";
import { isMarkdown } from "../files/paths";
import type { FolderListing } from "../files/types";
import { visibilityTierForRole } from "../visibility";
import { noteTitle, type HomeNote } from "./homeModel";

export interface HomeSource {
  notes: HomeNote[];
  folders: string[];
  shared: ReadonlySet<string>;
}

const EMPTY: HomeSource = { notes: [], folders: [], shared: new Set() };

/**
 * What the phone's Home is built from: every note and folder in this
 * workspace, from this device's copy of it.
 *
 * The mirror is read at exactly the clearance the role gives — the rule every
 * mirror reader keeps (`mirrorLists.ts`), so a `team` reader never counts a
 * note filed at `private`. Titles, first lines and tags come from the notes'
 * own frontmatter through `mirroredListNotes`, which keeps them keyed by etag,
 * so a redraw after one note changes re-reads that note and nothing else. An
 * encrypted note still counts; its title is its file name, because its
 * frontmatter is inside the envelope.
 *
 * Where there is no copy on the device yet (a first launch, a visitor on the
 * homepage), the folders the console has already listed stand in: counts are
 * then what has been listed, which is what the tree itself would say.
 */
export function useHomeSource(
  workspaceId: string | null | undefined,
  role: string | undefined,
  listings: Readonly<Record<string, FolderListing | undefined>>,
): HomeSource {
  const tier = visibilityTierForRole(role);
  const [mirrored, setMirrored] = useState<HomeSource | null>(null);

  useEffect(() => {
    setMirrored(null);
    if (workspaceId == null || tier === "unknown") return;
    let cancelled = false;
    let running = false;
    let again = false;
    const epoch = currentEpoch();
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const store = await openMirrorStore();
        if (store === null || cancelled) return;
        const index = await readIndex(store, tier, workspaceId);
        if (index === null || cancelled) return;
        const listed = await mirroredListNotes(store, tier, workspaceId, "", true);
        // A sign-out while this was reading: the names belong to a session that is over.
        if (cancelled || epoch !== currentEpoch()) return;
        const read = new Map((listed?.notes ?? []).map((note) => [note.path, note]));
        const notes: HomeNote[] = [];
        for (const entry of index.entries.values()) {
          if (!isMarkdown(entry.path)) continue;
          const note = read.get(entry.path);
          notes.push({
            path: entry.path,
            ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
            title: noteTitle(entry.path, note?.properties.title, note?.heading),
            lede: note?.lede ?? null,
            tags: note === undefined ? [] : tagsOf(note.properties),
          });
        }
        const tree = treeOf(index);
        const shared = new Set<string>();
        for (const [folder, listing] of tree) if (listing.folderDefault === "team") shared.add(folder);
        setMirrored({ notes, folders: [...tree.keys()], shared });
      } catch {
        // No copy on the device is the listings' answer below, not an error on Home.
      } finally {
        running = false;
        if (again && !cancelled) {
          again = false;
          void load();
        }
      }
    };
    void load();
    const mine = (changed: string) => {
      if (changed === workspaceId) void load();
    };
    const stopListed = onMirrorListed(mine);
    const stopNotes = onMirrorNotesChanged(mine);
    return () => {
      cancelled = true;
      stopListed();
      stopNotes();
    };
  }, [workspaceId, tier]);

  const listed = useMemo<HomeSource>(() => {
    const notes: HomeNote[] = [];
    const folders = new Set<string>();
    const shared = new Set<string>();
    for (const listing of Object.values(listings)) {
      if (listing === undefined) continue;
      if (listing.path !== "") folders.add(listing.path);
      if (listing.path !== "" && listing.folderDefault === "team") shared.add(listing.path);
      for (const entry of listing.entries) {
        if (entry.kind === "folder") {
          folders.add(entry.path);
          if (entry.visibility === "team") shared.add(entry.path);
        } else if (isMarkdown(entry.name)) {
          notes.push({
            path: entry.path,
            ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
            title: noteTitle(entry.path, undefined, undefined),
            lede: null,
            tags: [],
          });
        }
      }
    }
    return notes.length === 0 && folders.size === 0 ? EMPTY : { notes, folders: [...folders], shared };
  }, [listings]);

  return mirrored ?? listed;
}
