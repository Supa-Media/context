/**
 * The map `orient` draws of one context: every folder and note the caller
 * can see, merged into a tree.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { classifyCaptureKind } from "../communications/paths.js";
import { listBoundedKeys, listImmediateLayout, mapInBatches } from "../notes/storage.js";
import {
  mostRecent,
  ORIENT_FOLDER_PAGE_CAP,
  ORIENT_RECENT_LIMIT,
  summarizeCaptured,
} from "./render.js";

/**
 * Survey the visible context: what folders exist, how much is in each, and what
 * was touched most recently. This is what `orient` is *for* — an agent that
 * only learns a list of folder names has no reason to look inside one.
 *
 * Two properties are load-bearing:
 *
 * **Every count is a count of notes this connection can see.** Counting hidden
 * notes and printing the total would let a team member subtract and derive
 * exactly how much of the owner's context is being withheld from them — the
 * same reason the console's note census is owner-only. A folder earns its place
 * on the map by holding a visible note or a subfolder this connection may know
 * about; a count of zero is rendered as no count at all, because "0 notes" is a
 * claim about the folder and all we know is that nothing in it reached us.
 *
 * **The walk is delimited at the root and flat inside each real folder.** A
 * flat walk from the root spends its whole budget inside `.history/`, because
 * "." sorts before every digit and letter, and then reports zero notes for the
 * largest contexts there are.
 */
export async function surveyContext(store, scope, rules, overrides) {
  const root = await listImmediateLayout(store);
  const rootNotes = root.objects
    .filter(({ key }) => isVisibleNote(key, scope, rules, overrides))
    .map(({ key, uploaded }) => ({ key, uploaded }));

  // Two listings per folder, and they answer different questions.
  //
  // The delimited one names every immediate subfolder for one page's worth of
  // keys, which is what makes the *map* complete. The flat one counts notes and
  // dates them, and it is the one with a budget — so in a context with one
  // enormous folder the walk can stop inside it having never reached its
  // siblings. Deriving the map from the walk alone looked simpler and quietly
  // dropped whole projects from the orientation of exactly the people with the
  // most in here.
  //
  // Each folder gets its own try. The prefixes are names the customer chose,
  // and the adapter refuses some of them outright (a backslash, a "." segment);
  // under one outer catch a single oddly named folder would suppress the whole
  // survey — the bug the note census shipped first.
  const folders = await mapInBatches(root.prefixes, 6, async (prefix) => {
    try {
      const [layout, walk] = await Promise.all([
        listImmediateLayout(store, prefix),
        listBoundedKeys(store, prefix, ORIENT_FOLDER_PAGE_CAP),
      ]);
      const notes = walk.keys.filter(({ key }) => isVisibleNote(key, scope, rules, overrides));
      return { prefix, layout, notes, truncated: walk.truncated, walked: true };
    } catch {
      return { prefix, layout: null, notes: [], truncated: true, walked: false };
    }
  });

  const visibleFolders = folders
    .map((folder) => ({
      prefix: folder.prefix,
      count: folder.notes.length,
      truncated: folder.truncated,
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
    // A count is a floor when any folder ran out of budget, or when one refused
    // to be walked at all. Both render as "312+".
    truncated: folders.some((folder) => folder.truncated),
    // Named only to a connection that could have seen inside it anyway. We
    // could not read the folder, so its own path is all `canSee` has to go on.
    unwalkable: folders
      .filter((folder) => !folder.walked)
      .map((folder) => folder.prefix)
      .filter((prefix) => canSee(prefix.replace(/\/$/, ""), scope, rules, overrides)),
    // Unchanged constant, unchanged function, now applied to the authored
    // subset only — never enlarged to make room for what `captured` adds.
    recent: mostRecent(authored, ORIENT_RECENT_LIMIT),
    captured: summarizeCaptured(everything),
  };
}

export function isVisibleNote(key, scope, rules, overrides) {
  return key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides);
}

/**
 * The immediate subfolders of one top-level folder, with a count where the
 * bounded walk got far enough to have one.
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
  return [...new Set([...named, ...counts.keys()])]
    .map((childPrefix) => ({ prefix: childPrefix, count: counts.get(childPrefix) ?? null }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}
