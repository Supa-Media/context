import { relativeWhen, rowText, targetOf, type ActivityEntry } from "../activity/activity";

/**
 * What the phone's folder page says under its title (board 07 of the Home
 * artboards the owner approved on 2026-09-30): what the folder holds, who has
 * been in it this week, and its latest change in one line.
 *
 * Built from the workspace's activity (`activity.md`, already read through the
 * privacy filter) and the device's copy of the tree, so it asks nothing new of
 * the server and names nothing the reader could not already see.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FACES = 3;

export interface FolderActor {
  key: string;
  /** "@ada" for a person, the client's name for an agent. */
  name: string | null;
  /** An agent is drawn as a robot, never as its owner's face (Dev2, 2026-09-28). */
  agent: boolean;
}

export interface FolderLatest {
  /** "@ada revised Acme brief", the sentence the activity list uses. */
  text: string;
  /** "2h", "Mon", "12 Sep". */
  when: string;
  /** What the line opens, when the change left something to open. */
  path: string | null;
  actor: FolderActor;
}

/** A path inside a folder, never a sibling that only shares its name's start. */
export function isInside(path: string, folder: string): boolean {
  return folder === "" || path.startsWith(`${folder}/`);
}

const isPlumbing = (path: string) => path.split("/").some((segment) => segment.startsWith("."));

function actorOf(entry: ActivityEntry): FolderActor {
  if (entry.via) return { key: `agent:${entry.by ?? ""}:${entry.via}`, name: entry.via, agent: true };
  return { key: `person:${entry.by ?? ""}`, name: entry.by, agent: false };
}

export function folderActivity(
  entries: readonly ActivityEntry[],
  folder: string,
  now: number,
): { latest: FolderLatest | null; actors: FolderActor[] } {
  const here = entries
    .filter((entry) => entry.paths.some((path) => isInside(path, folder)))
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => b.at - a.at);
  const newest = here[0]?.entry;
  const actors: FolderActor[] = [];
  for (const { entry, at } of here) {
    if (now - at > WEEK_MS || actors.length === FACES) break;
    const actor = actorOf(entry);
    if (!actors.some((seen) => seen.key === actor.key)) actors.push(actor);
  }
  return {
    latest:
      newest === undefined
        ? null
        : { text: rowText(newest).title, when: relativeWhen(newest.at, now), path: targetOf(newest), actor: actorOf(newest) },
    actors,
  };
}

/** What a folder holds, counted all the way down, as Home counts it. */
export function folderCounts(
  notes: readonly string[],
  folders: readonly string[],
  folder: string,
): { notes: number; folders: number } {
  const inside = (path: string) => isInside(path, folder) && !isPlumbing(path);
  return {
    notes: notes.filter(inside).length,
    folders: folders.filter((path) => path !== folder && inside(path)).length,
  };
}
