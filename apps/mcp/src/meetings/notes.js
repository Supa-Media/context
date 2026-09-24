/** Where a meeting note lives, and publishing a finished one into the context. */

import {
  canSee,
  isPlumbing,
  overrideFor,
  visibilityOf,
} from "../privacy/engine.js";
import { createSearchBudget } from "../search/maintain.js";
import {
  generatedCollaborationBase,
  generatedNoteFor,
  storedTextAt,
  writeGeneratedNote,
} from "../notes/sealing.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { loadPrivacyState, persistExactVisibility } from "../privacy/state.js";
import { MEETING_RESOLVE_CANDIDATES, MEETING_RESOLVE_SEARCH_BUDGET } from "../tools/communicationsSupport.js";
import { MeetingRefusal } from "./state.js";
import { normalizePath } from "../notes/paths.js";
// The meeting core is imported by relative path rather than by package name:
// this worker has no npm dependencies and no bundler resolution to lean on, so
// the same specifier works under plain `node` in the suite and under wrangler
// in production.
import { parseMeetingNote } from "../../../../packages/meetings/src/note.js";
import { recordChange } from "../activity/record.js";
import { searchIndexedNotes } from "../search/visible.js";

/**
 * Where a completed session's note actually is, resolved fresh rather than
 * trusted from `session.notePath` — M1 in the editor-polish sweep
 * (`docs/decisions/app-and-console.md`).
 *
 * **The problem, and the option this rejects.** `notePath` is written once, at
 * finalize, and nothing updates it when the note is later moved: moving is
 * `move_note`'s job, and teaching it to patch meeting state would couple two
 * features that do not otherwise know about each other, and would need
 * updating again for every future mover — rename, archive, whatever comes
 * next. So the pointer is resolved on *read* instead of kept correct on
 * *write*, against the one thing a move cannot change: the note's own
 * `meeting-id` frontmatter (`packages/meetings/src/note.js`), stamped in at
 * finalize and never rewritten by anything.
 *
 * **The common case costs one op and no search at all.** A direct read at the
 * stored path is tried first, and answers for every meeting nobody has moved
 * — which is nearly all of them. The search below runs only on a miss.
 *
 * **The query cannot be the meeting id itself.** `extractFields` in
 * `search/indexer.js` indexes a note's title, headings, `tags:` and body —
 * never arbitrary frontmatter — so `meeting-id: mtg_…` is never a searchable
 * term no matter how long the index has had to catch up. What *is* indexed is
 * the note's own `# title` heading, which `renderMeetingNote` always writes,
 * so the query is built from the session's title instead. That is a weaker
 * anchor than the id would be — two meetings can share a title, and a session
 * nobody named reads back as the generic default title — which is exactly why
 * the next paragraph exists rather than trusting the top hit.
 *
 * **A hit is never trusted from the ranking alone.** Up to
 * `MEETING_RESOLVE_CANDIDATES` ranked results are read and each one's own
 * frontmatter is compared against this session's *id* before anything is
 * returned — the one field a title search cannot forge. `isVisible` here is
 * exactly `canSee` at this caller's own tier, because a search is a locator
 * and never a permission: what this function may hand back must never be
 * wider than an ordinary `read_note` at the same path would allow, whatever
 * the index itself holds regardless of who is asking.
 *
 * Falls back to the stored (and now known-stale) path on every kind of
 * "cannot tell": no index, a privacy manifest that will not parse, no title to
 * search with, a search budget of nothing left, no hit among the candidates
 * read, every candidate turning out to be some other note. None of those is
 * treated as "the note is gone" — only as "this could not be resolved this
 * time", the same honesty the search index itself practises everywhere else
 * in this file.
 */
export async function resolveMeetingNotePath(store, session, tier) {
  const notePath = session.notePath;
  if (!notePath) return null;
  if (await getWithLegacyFallback(store, notePath)) return notePath;

  const title = typeof session.title === "string" ? session.title.trim() : "";
  if (!title) return notePath;

  const privacy = await loadPrivacyState(store);
  if (privacy.error) return notePath;
  const { rules, overrides } = privacy;

  let found;
  try {
    found = await searchIndexedNotes(store, {
      isVisible: (key) => canSee(key, tier, rules, overrides),
      isIndexable: (key) => key.endsWith(".md") && !isPlumbing(key),
      query: title,
      limit: MEETING_RESOLVE_CANDIDATES,
      budget: createSearchBudget(MEETING_RESOLVE_SEARCH_BUDGET),
      refreshOnMiss: false,
    });
  } catch {
    return notePath;
  }
  if (!found.indexed || !found.hits) return notePath;

  for (const hit of found.hits) {
    const stored = await getWithLegacyFallback(store, hit.key);
    if (!stored) continue;
    const parsed = parseMeetingNote(await stored.text());
    if ((parsed.frontmatter || {})["meeting-id"] === session.id) return hit.key;
  }
  return notePath;
}

export async function publishMeetingNote(store, scope, { path, markdown, segmentCount }) {
  const notePath = normalizePath(path);
  if (!notePath || !notePath.endsWith(".md")) {
    throw new MeetingRefusal(400, "invalid", "that is not a note path");
  }
  if (isPlumbing(notePath)) throw new MeetingRefusal(400, "invalid", "that path is reserved");

  const privacy = await loadPrivacyState(store);
  if (privacy.error) {
    // Failing closed, and saying so as a retryable failure: the note is not
    // written, the client keeps its log, and nothing is filed at a visibility
    // this gateway could not work out.
    throw new MeetingRefusal(
      503,
      "unavailable",
      "this context's privacy manifest could not be read, so nothing was written"
    );
  }
  const { rules, overrides } = privacy;
  const visibility = scope === "private" ? "private" : "team";
  if (scope === "team") {
    // `!== "team"` on the override, not `=== "private"`. This is the same
    // escalation `toolWriteNote`'s own guard describes, reached through the
    // meetings surface instead: `notePath` is client-supplied, so a team-tier
    // grant could name a note the owner had held back to a group, pass this
    // check because the value was neither `"private"` nor the folder default,
    // overwrite the body, and have `persistExactVisibility` below delete the
    // group rule and publish the path. `undefined` is spelled out so "no
    // override at all" still falls through to the folder check beside it.
    const noteOverride = overrideFor(overrides, notePath);
    if (
      visibilityOf(notePath, rules) !== "team" ||
      (noteOverride !== undefined && noteOverride !== "team")
    ) {
      throw new MeetingRefusal(
        403,
        "forbidden",
        "this connection cannot write a meeting note to that destination"
      );
    }
  }

  // A meeting note regenerated over one somebody encrypted stays encrypted. A
  // note we cannot open is left exactly as it is, and the refusal says so
  // rather than replacing an envelope with plaintext.
  const previousText = await storedTextAt(store, notePath);
  const collaborationBase = await generatedCollaborationBase(store, notePath, previousText);
  const canonicalPreviousText = collaborationBase?.text ?? previousText;
  const body = await generatedNoteFor(store, markdown, canonicalPreviousText);
  if (body === null) {
    throw new MeetingRefusal(
      409,
      "note_encrypted",
      "that meeting note is encrypted and this request cannot open it; nothing was written",
    );
  }
  if (visibility === "private") await persistExactVisibility(store, notePath, "private", rules);
  const put = await writeGeneratedNote(store, notePath, body, collaborationBase);
  if (visibility === "team") await persistExactVisibility(store, notePath, "team", rules);
  await recordChange(store, "meeting_note", scope, [notePath], {
    etag: put.etag,
    visibility,
    team_visible: visibility === "team",
    segments: segmentCount,
  });
  return { path: notePath, etag: put.etag, visibility };
}
