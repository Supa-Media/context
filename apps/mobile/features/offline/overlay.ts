import { localPathOf, opsOf, type Outbox } from "./outbox";
import type { FileEntry, FolderListing } from "../console/files/types";

/**
 * The tree as this device has it: the bucket's listings, with the queue's
 * renames, moves, deletes, new notes and new folders already applied.
 *
 * ## Why it is a view and not a write into the mirror
 *
 * The mirror is a copy of what the bucket said, pruned on every complete sync
 * against the server's own manifest — a note created on a train written into
 * it would be deleted by the first sync that ran before the create was sent,
 * and a renamed note written under its new name would be pruned for the same
 * reason. The typing is not in the mirror, by rule, and neither is anything
 * else that is only intent. So the listings stay the bucket's, and this lays
 * the queue over them wherever a listing is drawn: offline from the mirror,
 * online from the bucket, while anything is still waiting.
 *
 * ## Why a parked op is still drawn as done
 *
 * A rename refused because the note changed is drawn at its new name, with
 * the `crit` mark `pendingMarks` gives it. That is where the person put it and
 * where they will look for it; drawing it back at the old name would read as
 * the rename having been lost, which is exactly what did not happen — it is
 * waiting for them.
 *
 * Pure, and the input map is returned untouched when there is nothing queued,
 * so a memo over it costs nothing on the common path.
 */
export function overlayListings(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  outbox: Outbox,
): Record<string, FolderListing | undefined> {
  const ops = [...opsOf(outbox)].sort((a, b) => a.queuedAt - b.queuedAt);
  const creates = outbox.writes.filter((write) => write.baseEtag === null);
  if (ops.length === 0 && creates.length === 0) return listings as Record<string, FolderListing | undefined>;

  const next: Record<string, FolderListing | undefined> = { ...listings };
  const touched = new Set<string>();
  /** A listing this pass may change, copied once. */
  const editable = (folder: string): FolderListing | undefined => {
    const listing = next[folder];
    if (listing === undefined) return undefined;
    if (!touched.has(folder)) {
      touched.add(folder);
      next[folder] = { ...listing, entries: [...listing.entries] };
    }
    return next[folder];
  };
  const take = (path: string): FileEntry | undefined => {
    const listing = editable(parentOf(path));
    if (listing === undefined) return undefined;
    const index = listing.entries.findIndex((entry) => entry.path === path);
    if (index === -1) return undefined;
    return listing.entries.splice(index, 1)[0];
  };
  const put = (entry: FileEntry): void => {
    const listing = editable(parentOf(entry.path));
    if (listing === undefined) return;
    if (listing.entries.some((one) => one.path === entry.path)) return;
    listing.entries.push(entry);
  };

  for (const op of ops) {
    if (op.kind === "folder") {
      put(folderEntry(op.path, next[parentOf(op.path)]));
      /*
        Its own listing, empty, so opening it draws a folder rather than a
        spinner waiting on a read that has nothing to find — neither the bucket
        nor the mirror has heard of it.
      */
      if (next[op.path] === undefined) {
        const parent = next[parentOf(op.path)];
        next[op.path] = {
          path: op.path,
          folderDefault: parent?.folderDefault ?? "private",
          entries: [],
          truncated: false,
          manifestUsable: parent?.manifestUsable ?? true,
        };
        touched.add(op.path);
      }
      continue;
    }
    const entry = take(op.path);
    if (op.kind !== "move" || op.to === undefined) continue;
    put(
      entry === undefined
        ? fileEntry(op.to, next[parentOf(op.to)])
        : { ...entry, path: op.to, name: baseName(op.to) },
    );
  }

  for (const create of creates) {
    const path = localPathOf(outbox, create.path);
    put(fileEntry(path, next[parentOf(path)]));
  }

  for (const folder of touched) {
    const listing = next[folder];
    if (listing !== undefined) listing.entries.sort(compareEntries);
  }
  return next;
}

/**
 * A note the bucket has not listed, drawn with the visibility it will get.
 *
 * The folder's default, because that is what the server gives a new key with
 * no exception of its own — and a renamed note whose entry was not loaded is
 * the same guess. Never `team` when the folder's rule is unknown: an unknown
 * folder reads `private`, so nothing drawn from here ever claims to be shared.
 */
function fileEntry(path: string, parent: FolderListing | undefined): FileEntry {
  const visibility = parent?.folderDefault ?? "private";
  return {
    kind: "file",
    path,
    name: baseName(path),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

function folderEntry(path: string, parent: FolderListing | undefined): FileEntry {
  return { ...fileEntry(path, parent), kind: "folder" };
}

/** The server's order (`compareEntries` in `fileOps.ts`): folders, then names. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * What `overlayListings` depends on, as a string: which ops, where, and which
 * notes are creates — and nothing about their text. Typing into a note created
 * offline changes the queue on every keystroke and changes none of this, so a
 * caller that memoises on this key redraws the tree only when the tree changed.
 */
export function overlayKey(outbox: Outbox): string {
  const ops = opsOf(outbox).map((op) => `${op.id}:${op.kind}:${op.path}>${op.to ?? ""}:${op.queuedAt}`);
  const creates = outbox.writes.filter((write) => write.baseEtag === null).map((write) => write.path);
  return `${ops.join("|")}#${creates.join("|")}`;
}
