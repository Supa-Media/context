/**
 * The map `orient` draws of one context: every folder and note the caller
 * can see, merged into a tree.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { classifyCaptureKind } from "../communications/paths.js";
import { TreeUnavailable } from "../tree/served.js";
import { frontNotesAmong } from "./folderAbout.js";
import { mostRecent, ORIENT_RECENT_LIMIT, summarizeCaptured } from "./render.js";

/**
 * Survey the visible context: what folders exist, how much is in each, and what
 * was touched most recently. This is what `orient` is *for* — an agent that
 * only learns a list of folder names has no reason to look inside one.
 *
 * Every key comes from the Convex tree (`store.treeEntries`, `tree/served.js`),
 * one answer for the whole workspace, so every count is exact: the page
 * budget and the "312+" floors a bucket walk needed are gone with the walk.
 * Where the tree cannot answer, the survey is `unreadable` and draws no map
 * rather than listing the bucket.
 *
 * **Every count is a count of notes this connection can see.** Counting hidden
 * notes and printing the total would let a team member subtract and derive
 * exactly how much of the owner's context is being withheld from them — the
 * same reason the console's note census is owner-only. A folder earns its place
 * on the map by holding a visible note or a subfolder this connection may know
 * about; a count of zero is rendered as no count at all, because "0 notes" is a
 * claim about the folder and all we know is that nothing in it reached us.
 */
export async function surveyContext(store, scope, rules, overrides) {
  let objects;
  try {
    if (typeof store?.treeEntries !== "function") throw new TreeUnavailable();
    objects = await store.treeEntries();
  } catch (error) {
    if (error instanceof TreeUnavailable) return unreadableMap(error.message);
    throw error;
  }
  const isVisible = (key) => isVisibleNote(key, scope, rules, overrides);
  const root = layoutOf(objects, "");
  const rootNotes = root.objects.filter(({ key }) => isVisible(key)).map(({ key, uploaded }) => ({ key, uploaded }));

  const folders = root.prefixes.map((prefix) => {
    const under = objects.filter(({ key }) => key.startsWith(prefix));
    const notes = under.filter(({ key }) => isVisible(key)).map(({ key, uploaded }) => ({ key, uploaded }));
    return { prefix, layout: layoutOf(under, prefix), notes };
  });

  // The front notes a folder's description may come from, among the keys
  // directly inside it. `describeFolders` reads only these names.
  const visibleFolders = folders
    .map((folder) => ({
      prefix: folder.prefix,
      count: folder.notes.length,
      front: frontNotesAmong(folder.prefix, new Set(folder.layout.objects.map(({ key }) => key)), isVisible),
      children: mergeChildren(folder, scope, rules, overrides),
    }))
    .filter((folder) => folder.count > 0 || folder.children.length > 0);

  const everything = [...rootNotes, ...folders.flatMap((folder) => folder.notes)];
  // Automated capture — a channel-day note, a meeting, a saved session filed
  // at the unrouted default — is split out here, before `mostRecent` ever
  // sees it. `recent` therefore ranks only what a person actually touched;
  // `captured` is the collapsed pointer into everything else, at most one
  // entry per kind regardless of how many notes of that kind exist. See
  // `summarizeCaptured` and docs/decisions/communications.md, "A firehose is
  // not attention".
  const authored = everything.filter((note) => !classifyCaptureKind(note.key));
  return {
    rootNotes: rootNotes.sort((a, b) => a.key.localeCompare(b.key)),
    folders: visibleFolders.sort((a, b) => a.prefix.localeCompare(b.prefix)),
    total: everything.length,
    // Unchanged constant, unchanged function, now applied to the authored
    // subset only — never enlarged to make room for what `captured` adds.
    recent: mostRecent(authored, ORIENT_RECENT_LIMIT),
    captured: summarizeCaptured(everything),
  };
}

/** The survey of a workspace the tree cannot answer for: no map, and why. */
function unreadableMap(message) {
  return { rootNotes: [], folders: [], total: 0, recent: [], captured: [], unreadable: message };
}

/**
 * One level of `objects` under `prefix`: the keys directly inside it, and its
 * immediate subfolders (a dot folder is Context's own, never a place).
 */
function layoutOf(objects, prefix) {
  const direct = [];
  const prefixes = new Set();
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) direct.push(object);
    else if (!rest.startsWith(".")) prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
  }
  return { objects: direct, prefixes: [...prefixes].sort() };
}

export function isVisibleNote(key, scope, rules, overrides) {
  return key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides);
}

/**
 * The immediate subfolders of one top-level folder, each with its count.
 *
 * A child is listed on either of two independent grounds, and both are needed:
 * the folder default says this connection may know it exists, or it holds a
 * note this connection can already read. The second matters because an owner
 * can publish one team note inside a private-default folder, and hiding the
 * folder while showing the note in `list_notes` would just be inconsistent.
 */
function mergeChildren(folder, scope, rules, overrides) {
  const counts = new Map();
  for (const note of folder.notes) {
    const remainder = note.key.slice(folder.prefix.length);
    const slash = remainder.indexOf("/");
    if (slash === -1) continue;
    const childPrefix = `${folder.prefix}${remainder.slice(0, slash + 1)}`;
    counts.set(childPrefix, (counts.get(childPrefix) || 0) + 1);
  }
  const named = (folder.layout?.prefixes || []).filter((childPrefix) =>
    canSee(childPrefix.replace(/\/$/, ""), scope, rules, overrides)
  );
  // A child's front note is one of the folder's visible keys.
  const keys = new Set(folder.notes.map(({ key }) => key));
  const isVisible = (key) => isVisibleNote(key, scope, rules, overrides);
  return [...new Set([...named, ...counts.keys()])]
    .map((childPrefix) => ({
      prefix: childPrefix,
      count: counts.get(childPrefix) ?? null,
      front: frontNotesAmong(childPrefix, keys, isVisible),
    }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}
