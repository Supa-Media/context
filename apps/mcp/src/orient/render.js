/**
 * The pieces `orient` and the connect-time sketch render: limits, recent
 * captures, the structure listing, the save procedure read off the front
 * page, sibling contexts and reduced-recall notices. Moved verbatim out of
 * `src/index.js`; the survey that reads through the privacy engine stays
 * beside it.
 */

import { classifyCaptureKind } from "../communications/paths.js";
import { createSearchBudget } from "../search/maintain.js";
import { INSTRUCTIONS_NAME_CHAR_CAP } from "../mcp/instructions.js";
import { loadIndexManifest, shedNotePathsOf } from "../search/shards.js";

/**
 * `orient` is called at the top of a session, before the agent knows whether
 * this context is even relevant, so it is budgeted rather than exhaustive.
 * Five pages is 5000 notes in one folder; past that the survey reports a floor
 * ("48+ notes") instead of guessing, for the same reason the console's note
 * census does. A number that looks precise and is not is worse than a floor.
 */
export const ORIENT_FOLDER_PAGE_CAP = 5;
export const ORIENT_RECENT_LIMIT = 8;
const ORIENT_CHILDREN_LIMIT = 12;
const ORIENT_ROOT_NOTE_LIMIT = 20;
/** The front page is the customer's own prose; long ones are cut, never dropped. */
export const ORIENT_INDEX_CHAR_CAP = 6_000;

/**
 * As many names as fit in `charCap`, each capped, and a count of the rest.
 *
 * Every list in the connect-time sketch goes through this, so the sketch has a
 * length bound that does not depend on anybody's bucket or membership — see
 * `INSTRUCTIONS_SKETCH_BUDGET`.
 */
export function namedWithRest(names, charCap, restLabel) {
  const shown = [];
  let spent = 0;
  for (const name of names) {
    const capped =
      name.length > INSTRUCTIONS_NAME_CHAR_CAP ? `${name.slice(0, INSTRUCTIONS_NAME_CHAR_CAP)}…` : name;
    // `, ` between names is part of what the line spends.
    const cost = capped.length + 2;
    if (spent + cost > charCap) break;
    shown.push(capped);
    spent += cost;
  }
  const rest = names.length - shown.length;
  return rest > 0 ? [...shown, `(+${rest} ${restLabel})`] : shown;
}

/**
 * At most one summary per automated-capture kind present in `notes`, each
 * carrying the total count of that kind this connection can see and its
 * single newest note.
 *
 * **Never one line per note.** A connected mailbox writes a channel-day note
 * every active day, forever; a run of daily meetings does the same. Without
 * this, `orient`'s recency list is nothing else within days of either being
 * turned on — the exact failure docs/decisions/communications.md, "A firehose
 * is not attention", names. So every note of a kind collapses to one line,
 * built from the same visibility-filtered list `recent` and the folder map
 * are, which is what keeps a team caller's count from ever including a
 * mailbox they cannot see (`canSee` already ran, in `surveyContext`, before
 * `notes` reaches here).
 *
 * Ordered `channel-day`, `calendar-day`, `meeting`, `session` — a fixed order
 * rather than by recency, so the section's shape does not reflow between
 * calls when two kinds are close in time.
 */
export function summarizeCaptured(notes) {
  const groups = new Map();
  for (const note of notes) {
    const kind = classifyCaptureKind(note.key);
    if (!kind) continue;
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(note);
  }
  const order = ["channel-day", "calendar-day", "meeting", "session"];
  const summaries = [];
  for (const kind of order) {
    const group = groups.get(kind);
    if (!group || !group.length) continue;
    summaries.push({
      kind,
      count: group.length,
      label: capturedKindLabel(kind, group),
      // The one pointer a "what came in?" question needs. `mostRecent` already
      // handles "no note here has a usable timestamp" by returning nothing.
      newest: mostRecent(group, 1)[0] || null,
    });
  }
  return summaries;
}

/**
 * "30 mail days", "2 meetings", "1 saved session" — the label on a collapsed
 * line. Cosmetic only: the count and the pointer beside it are what an agent
 * acts on, and getting this wrong changes nothing else.
 *
 * `channel-day` is named after the channel when a group is entirely one
 * channel — the common case, one mailbox or one chat account — and falls back
 * to a generic name for a mixed group rather than picking one channel to
 * feature over another.
 */
function capturedKindLabel(kind, notes) {
  const count = notes.length;
  const plural = count === 1 ? "" : "s";
  if (kind === "meeting") return `${count} meeting${plural}`;
  if (kind === "session") return `${count} saved session${plural}`;
  if (kind === "calendar-day") return `${count} calendar day${plural}`;
  const allEmail = notes.every((note) => note.key.startsWith("0-inbox/email/"));
  if (allEmail) return `${count} mail day${plural}`;
  const allChat = notes.every(
    (note) => note.key.startsWith("0-inbox/google-chat/") || note.key.startsWith("0-inbox/imessage/")
  );
  if (allChat) return `${count} chat day${plural}`;
  return `${count} channel-day note${plural}`;
}

/** The one rendered line for a collapsed capture kind. */
export function formatCapturedLine(summary, now) {
  const pointer = summary.newest
    ? `; newest \`${summary.newest.key}\` (${relativeAge(summary.newest.uploaded, now)})`
    : "";
  return `- ${summary.label} arrived${pointer}`;
}

/**
 * Newest first, ties broken by key so the answer is stable across calls.
 * A store that reports no timestamps contributes nothing rather than an
 * arbitrary eight notes wearing the label "recently updated".
 */
export function mostRecent(notes, limit) {
  return notes
    .filter((note) => note.uploaded instanceof Date && !Number.isNaN(note.uploaded.getTime()))
    .sort((a, b) => b.uploaded - a.uploaded || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** "3h ago" reads as a reason to look; a raw ISO timestamp reads as metadata. */
export function relativeAge(date, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}

/**
 * The user's own end-of-session procedure, read out of `index.md`.
 *
 * A shutdown routine is not something we can write for somebody. One person
 * wants a transcript filed; another wants three bullets of decisions appended
 * to the project note and the transcript thrown away; a third wants nothing
 * saved unless they say so. Hardcoding any of those makes `save_context` a tool
 * that does the wrong thing reliably.
 *
 * So the procedure is a section in the front page — a file they already own,
 * already edit, and that every agent already reads — and the gateway parses
 * exactly one machine-readable line out of it:
 *
 *     ## Save context
 *     destination: 2-areas/sessions
 *
 *     Summarise what we decided in three bullets and append them to the
 *     project note. Only keep the full transcript if I asked for it.
 *
 * Everything other than `destination:` is prose, passed to the agent untouched.
 * That asymmetry is the point: the one thing the *gateway* must act on is a
 * path, and a path is the one thing it can validate. Inventing a config
 * language for the rest would be asking somebody to learn a schema in order to
 * describe what they want in English to something that reads English.
 *
 * Absent, `save_context` still works and says what it assumed.
 *
 * Note whose file this is: on a context whose `index.md` is team-writable, a
 * member can change where everybody's sessions land. That is the same authority
 * they already have over every other note they can write, and the destination
 * still passes through the ordinary write surface — a redirect into a
 * private-default folder is refused for a team connection exactly as
 * `write_note` refuses it. An owner who wants the procedure to be theirs alone
 * makes `index.md` private, which is one `set_visibility` call.
 */
export const SAVE_SECTION_HEADING = /^(#{1,6})\s*(?:save[ -]context|shutdown|end[ -]of[ -]session)\b/i;
export const SAVE_DESTINATION_LINE = /^\s*(?:[-*]\s*)?destination\s*:\s*(\S.*?)\s*$/i;
/** Prose handed to an agent, not a place to paste a document. */
export const SAVE_PROCEDURE_CHAR_CAP = 2_000;

export const NO_FRONT_PAGE =
  "This context has no `index.md` yet. That file is its front page: what the " +
  "user is working on, who matters, and where things belong. Once you have " +
  "looked around, offer to write one with write_note at path `index.md` — " +
  "every agent that connects reads it first.";

export function renderStructure(survey) {
  const lines = [];
  for (const note of survey.rootNotes.slice(0, ORIENT_ROOT_NOTE_LIMIT)) {
    lines.push(`- ${note.key}`);
  }
  if (survey.rootNotes.length > ORIENT_ROOT_NOTE_LIMIT) {
    lines.push(`- (+${survey.rootNotes.length - ORIENT_ROOT_NOTE_LIMIT} more notes at the root)`);
  }
  for (const folder of survey.folders) {
    // The floor travels down as well as up: a child count drawn from a walk
    // that stopped early is no more a total than its parent's is.
    const floor = folder.truncated ? "+" : "";
    const noun = folder.count === 1 && !folder.truncated ? "note" : "notes";
    lines.push(
      folder.count === 0
        ? `- ${folder.prefix}`
        : `- ${folder.prefix} — ${folder.count}${floor} ${noun}`
    );
    for (const child of folder.children.slice(0, ORIENT_CHILDREN_LIMIT)) {
      // No count means the walk stopped before reaching this subfolder. It is
      // named without a number rather than given a zero: "0 notes" about a
      // folder nothing counted is the one reading that is certainly wrong.
      lines.push(child.count === null ? `  - ${child.prefix}` : `  - ${child.prefix} — ${child.count}${floor}`);
    }
    if (folder.children.length > ORIENT_CHILDREN_LIMIT) {
      lines.push(`  - (+${folder.children.length - ORIENT_CHILDREN_LIMIT} more folders)`);
    }
  }
  // A folder the storage adapter refuses to list — a backslash or a "." segment
  // in a name somebody chose in Obsidian — is named rather than dropped. It is
  // the caller's own data, and silently omitting it would make this map claim
  // completeness it does not have.
  for (const prefix of survey.unwalkable) {
    lines.push(`- ${prefix} — could not be listed (unsupported characters in the folder name)`);
  }
  return lines.length ? lines.join("\n") : "- (nothing visible to this connection yet)";
}

/**
 * The other contexts this connection reaches — and each one's front page.
 *
 * Naming them was not enough. An agent given a list of names has been told a
 * fact it cannot act on: it does not know whether `@lk` is a colleague's design
 * notes or a dormant workspace from last year, so it never looks, which is the
 * same failure as not being told at all. The front page is the one file that
 * answers "what is this place", it is the one the whole orientation contract is
 * built on, and it is small.
 *
 * Four properties, and each is a rule rather than a tuning:
 *
 *  - **Every page is read at that context's own clearance.** `openContext`
 *    hands back a session clamped to the caller's role there, and the privacy
 *    manifest is that context's own — so a `private` connection reading a
 *    context it is a `member` of gets `team`, and an `index.md` marked private
 *    there is absent here exactly as it is everywhere else.
 *  - **It is bounded, and a short list says so.** Each context costs a control
 *    plane round trip and two reads, against a Worker with a subrequest
 *    ceiling; an unbounded fan-out is how orientation starts failing outright
 *    for the people who have the most of it. Past the cap the rest are still
 *    *named*, because a name is free — and the sentence says the list is short
 *    rather than letting it read as complete.
 *  - **One context that will not open cannot take the others down.** A revoked
 *    binding, a bucket that is down, a `privacy.md` somebody broke in Obsidian:
 *    each is reported on its own line and the rest of the answer stands. This
 *    is the survey's own fail-soft rule, one level out.
 *  - **It reads nothing when there is no opener.** An `orient` already
 *    addressed into another context is handed a store that cannot route again,
 *    so it names the rest and reads none of them — one tool call opens one
 *    context beyond its own, and never a chain.
 */
export const ORIENT_SIBLING_LIMIT = 6;
export const ORIENT_SIBLING_INDEX_CHAR_CAP = 1_200;

/**
 * The caller's own share of the search index's shed notes, for `orient`.
 *
 * One extra GET — the manifest `search_notes` already reads on every query —
 * so an agent that never searches still learns this rather than discovering
 * it as a silent miss later. Filtered through `isVisible` exactly as
 * `searchIndexedNotes` filters it, because these paths are gathered from
 * every doc in a shard, private ones included, and are safe to say out loud
 * only after that check runs (`docs/decisions/search.md`, sizing section).
 *
 * `[]` for every way this can fail to answer — no index yet, an unreadable
 * manifest, no budget — because to `orient` those all mean the same thing:
 * nothing to report, and `search_notes` is where a real miss gets explained.
 */
export async function reducedRecallNotesFor(store, isVisible) {
  try {
    const manifest = await loadIndexManifest(store, createSearchBudget(2), 0);
    if (!manifest) return [];
    return [...new Set(shedNotePathsOf(manifest).filter(isVisible))].sort();
  } catch {
    return [];
  }
}
