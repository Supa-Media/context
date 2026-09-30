/**
 * Recognizing a replacement that already holds what the document gained.
 *
 * A replacement names the base it was written against, and the exact-base
 * merge keeps every character the document gained since that base as a
 * peer's unseen insertion. That is right for a peer, and wrong for the
 * writer's own typing: an editor that restarts, or a queue that drains late,
 * can send its whole draft against a base from before most of that draft had
 * already reached the document. Merged the ordinary way, everything typed
 * since the base is inserted a second time beside itself, and two such
 * replays interleave into the scrambled copies reported on 2026-09-30.
 *
 * The text is the evidence. When the desired text still contains every
 * character the document gained since the base, the writer had seen them, so
 * the replacement is applied as an edit of the document as it is now. When
 * the desired text only lacks characters the document gained, and adds and
 * removes nothing else, the writer is simply behind and nothing changes.
 * Anything else is a genuine concurrent edit and keeps the exact-base merge.
 */

import * as Y from "yjs";
import { diffChars } from "diff";

function visibleStrings(text, visit) {
  for (let item = text._start; item !== null; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentString) visit(item, item.content.str);
  }
}

/** For each UTF-16 unit of the current text: gained since the base? */
function gainedSinceBase(current, baseVector, length) {
  // Typed arrays: a note can be megabytes, and a boolean per character in a
  // plain array would cost eight bytes each inside a Worker's memory limit.
  const gained = new Uint8Array(length);
  let index = 0;
  visibleStrings(current.getText("note"), (item, value) => {
    const known = baseVector.get(item.id.client) ?? 0;
    for (let offset = 0; offset < value.length; offset += 1) gained[index + offset] = item.id.clock + offset >= known ? 1 : 0;
    index += value.length;
  });
  return gained;
}

/** Base text indices (UTF-16) that the document has since deleted. */
function deletedSinceBase(base, current) {
  const deletions = Y.createDeleteSetFromStructStore(current.store);
  const deleted = new Set();
  let index = 0;
  visibleStrings(base.getText("note"), (item, value) => {
    for (let offset = 0; offset < value.length; offset += 1) {
      if (Y.isDeleted(deletions, Y.createID(item.id.client, item.id.clock + offset))) deleted.add(index + offset);
    }
    index += value.length;
  });
  return deleted;
}

/** Base text indices (UTF-16) the desired text keeps. */
function keptByDesired(baseText, desired) {
  const kept = new Set();
  let index = 0;
  for (const part of diffChars(baseText, desired)) {
    if (part.added) continue;
    if (!part.removed) for (let offset = 0; offset < part.value.length; offset += 1) kept.add(index + offset);
    index += part.value.length;
  }
  return kept;
}

/**
 * How to apply `desired`, written against `base`, to `current`.
 *
 * @returns {"unchanged"|"rebase"|null} `unchanged`: the document already holds
 *   everything the replacement says; `rebase`: apply the replacement as a
 *   plain edit of the current text; `null`: a genuine concurrent edit, which
 *   keeps the exact-base merge.
 */
export function replayResolution(base, current, desired) {
  const currentText = current.getText("note").toString();
  if (currentText === desired) return "unchanged";

  // A peer deleted base text the writer still has. Applying the replacement
  // to the current text would put that text back; the exact-base merge keeps
  // the peer's deletion, so it keeps deciding.
  const deleted = deletedSinceBase(base, current);
  if (deleted.size > 0) {
    const kept = keptByDesired(base.getText("note").toString(), desired);
    for (const index of deleted) if (kept.has(index)) return null;
  }

  const gained = gainedSinceBase(current, Y.decodeStateVector(Y.encodeStateVector(base)), currentText.length);
  // Which unchanged stretch of the diff each current character sits in, or -1
  // when the desired text removes it.
  const stretch = new Int32Array(currentText.length).fill(-1);
  let index = 0;
  let stretches = 0;
  let inserts = false;
  let dropsGained = false;
  let dropsOlder = false;
  for (const part of diffChars(currentText, desired)) {
    if (part.added) {
      inserts = true;
      continue;
    }
    if (part.removed) {
      for (let offset = 0; offset < part.value.length; offset += 1) {
        if (gained[index + offset]) dropsGained = true;
        else dropsOlder = true;
      }
    } else {
      stretches += 1;
      stretch.fill(stretches, index, index + part.value.length);
    }
    index += part.value.length;
  }
  if (dropsGained) return !inserts && !dropsOlder ? "unchanged" : null;
  return gainedRunsRecognized(gained, stretch) ? "rebase" : null;
}

/**
 * Whether each run the document gained appears in the desired text as that
 * run, rather than as letters the diff borrowed from different words.
 *
 * A peer who typed "big " while an agent rewrote the sentence around it from
 * an older base can have every one of those four letters matched somewhere in
 * the agent's new words. Applying the agent's text as an edit would then drop
 * the peer's word without anything having removed it. A writer replaying its
 * own typing carries each run nearly whole, give or take a corrected typo, so
 * most of every run has to sit in one unchanged stretch.
 */
function gainedRunsRecognized(gained, stretch) {
  let start = 0;
  while (start < gained.length) {
    if (!gained[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < gained.length && gained[end]) end += 1;
    let longest = 0;
    let length = 0;
    for (let at = start; at < end; at += 1) {
      length = at > start && stretch[at] === stretch[at - 1] ? length + 1 : 1;
      longest = Math.max(longest, length);
    }
    if (longest * 5 < (end - start) * 4) return false;
    start = end;
  }
  return true;
}
