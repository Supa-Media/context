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
import { loadPrivacyState, persistExactVisibility } from "../privacy/state.js";
import { MEETING_RESOLVE_CANDIDATES, MEETING_RESOLVE_SEARCH_BUDGET } from "../tools/communicationsSupport.js";
import { MeetingRefusal } from "./state.js";
import { normalizePath } from "../notes/paths.js";
// The meeting core is imported by relative path rather than by package name:
// this worker has no npm dependencies and no bundler resolution to lean on, so
// the same specifier works under plain `node` in the suite and under wrangler
// in production.
import { recordChange } from "../activity/record.js";
import { factProps } from "../tree/facts.js";
import { takenInTree } from "../tree/names.js";
import { TreeUnavailable } from "../tree/served.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { searchIndexedNotes } from "../search/visible.js";
import { answerFromProjection } from "../search/d1/serve.js";
import { createD1Client } from "../search/d1/client.js";

/**
 * Where a completed session's note actually is, resolved fresh rather than
 * trusted from `session.notePath` — M1 in the editor-polish sweep
 * (`docs/decisions/app-and-console.md`).
 *
 * **The problem, and the option this rejects.** `notePath` is written once, at
 * finalize, and nothing updates it when the note is later moved: moving is
 * `move_note`'s job, and teaching it to patch meeting state would couple two
 * features that do not otherwise know about each other. So the pointer is
 * resolved on *read* instead of kept correct on *write*, against the one thing
 * a move cannot change: the note's own `meeting-id` front matter
 * (`packages/meetings/src/note.js`), stamped in at finalize and never rewritten
 * by anything.
 *
 * **Names, existence and front matter come from the Convex tree; no note is
 * opened here** (owner, 2026-10-14). The privacy manifest is still read, as
 * every privacy decision reads it. Each question is asked where
 * its answer is kept, in this order, and the first that answers wins:
 *
 * 1. The stored path is still a name in the tree. The common case: nearly every
 *    meeting is never moved, and this costs one tree question and no note.
 * 2. The forwarding trail (`forwarding.js`) says where the stored path went.
 *    It is the cheap, exact answer for a note this gateway moved, so it is
 *    tried before any search. The address it reaches is re-checked with this
 *    caller's own `canSee`, and its `meeting-id` is read from the tree's props.
 * 3. A title search over the index, with `readSnippets: false` so no hit is
 *    opened to cut a snippet. The query cannot be the meeting id:
 *    `extractFields` in `search/indexer.js` never indexes front matter, so the
 *    title is the anchor. It is weaker than the id, which is why every hit is
 *    compared by its own `meeting-id` before it is trusted. A hit whose props
 *    the tree has not read, or holds sealed, is skipped and never opened.
 *
 * `isVisible` here is exactly `canSee` at this caller's own tier, because a
 * search or a trail is a locator and never a permission: what this function may
 * hand back must never be wider than an ordinary `read_note` at the same path
 * would allow.
 *
 * Falls back to the stored (and now known-stale) path on every kind of
 * "cannot tell": the tree not serving, a privacy manifest that will not parse,
 * no title to search with, no index, a search budget of nothing left, no hit
 * the tree confirms. None of those is treated as "the note is gone".
 */
export async function resolveMeetingNotePath(store, session, tier) {
  const notePath = session.notePath;
  if (!notePath) return null;
  // `undefined` is "the tree cannot say": keep the stored path, as above.
  if ((await storedPathIsNamed(store, notePath)) !== false) return notePath;

  const privacy = await loadPrivacyState(store);
  if (privacy.error) return notePath;
  const { rules, overrides } = privacy;
  const isVisible = (key) => canSee(key, tier, rules, overrides);

  const forwarded = await forwardedMeetingNote(store, session, notePath, isVisible);
  if (forwarded) return forwarded;

  const title = typeof session.title === "string" ? session.title.trim() : "";
  if (!title) return notePath;

  let found;
  try {
    // A context with a search database keeps no index in its bucket, so the
    // title is asked of the database (2026-10-17).
    found = store.searchIndex
      ? await answerFromProjection(createD1Client(store.searchIndex), {
          query: title,
          tier,
          isVisible: (key) => isVisible(key) && key.endsWith(".md") && !isPlumbing(key),
          limit: MEETING_RESOLVE_CANDIDATES,
          budget: createSearchBudget(MEETING_RESOLVE_SEARCH_BUDGET),
          missIsAnswer: true,
        })
      : await searchIndexedNotes(store, {
          isVisible,
          isIndexable: (key) => key.endsWith(".md") && !isPlumbing(key),
          query: title,
          limit: MEETING_RESOLVE_CANDIDATES,
          budget: createSearchBudget(MEETING_RESOLVE_SEARCH_BUDGET),
          refreshOnMiss: false,
          readSnippets: false,
        });
  } catch {
    return notePath;
  }
  if (!found || (!store.searchIndex && !found.indexed) || !found.hits) return notePath;

  const candidates = found.hits.map((hit) => hit.key);
  const facts = await factProps(store, candidates);
  if (facts === null) return notePath;
  for (const key of candidates) {
    if (meetingIdOf(facts.get(key)) === session.id) return key;
  }
  return notePath;
}

/**
 * Whether the stored path is still a name in the tree: `true` or `false`, or
 * `undefined` when the tree cannot say.
 */
async function storedPathIsNamed(store, path) {
  try {
    const taken = await takenInTree(store, [path]);
    return taken.files.has(path);
  } catch (error) {
    if (error instanceof TreeUnavailable) return undefined;
    throw error;
  }
}

/**
 * The address the forwarding trail gives the stored path, when it is a note
 * this caller may see and the tree confirms it is this meeting's. `null`
 * otherwise, including when the trail leads nowhere or somewhere hidden.
 */
async function forwardedMeetingNote(store, session, notePath, isVisible) {
  const target = forwardPath(await readForwarding(store), notePath);
  if (typeof target !== "string" || target === notePath || !isVisible(target)) return null;
  const facts = await factProps(store, [target]);
  return facts !== null && meetingIdOf(facts.get(target)) === session.id ? target : null;
}

/** A note's `meeting-id` from the tree's props; `undefined` for a sealed, unread or front-matter-less note. */
function meetingIdOf(entry) {
  if (!entry || entry.sealed || !entry.props) return undefined;
  return entry.props.properties["meeting-id"];
}

/**
 * The path a meeting's note will occupy, avoiding one that is already taken.
 *
 * `meetingNotePath` already ends in a short form of the session id, so a
 * collision means either a retry of this same session (which reuses the path
 * out of the record and never reaches here) or a note somebody else's tooling
 * put there. Suffixing rather than overwriting mirrors `uniqueSessionPath` in
 * `index.js`: a gateway that overwrites an unrelated note to file a meeting has
 * destroyed something no version history of ours can give back.
 *
 * "Taken" is the tree's answer (`takenInTree`, the same question
 * `resolveMeetingNotePath` asks), never a GET of the candidate. A tree that
 * cannot answer throws `TreeUnavailable` before the session record is written,
 * so nothing is claimed and the finalize is retried (the `503` in
 * `handleMeetings`).
 */
export async function unclaimedNotePath(store, candidate) {
  if (!(await takenInTree(store, [candidate])).files.has(candidate)) return candidate;
  return candidate.replace(/\.md$/, `-${crypto.randomUUID().slice(0, 8)}.md`);
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
