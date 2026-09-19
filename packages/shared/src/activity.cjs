/**
 * `activity.md` — what changed in a context, as a file rather than as a table.
 *
 * ## The feed is a note
 *
 * The console draws activity as a list of rows, and the thing underneath that
 * list is an ordinary Markdown note at the root of the customer's bucket,
 * beside `index.md` and `privacy.md`. Open it in Obsidian and it reads as a
 * dated list. Export the bucket and the history comes with it. Delete Context
 * and it is still a file somebody owns. That is non-negotiable #3 applied to a
 * feature that every other product would have put in a database: the rendering
 * is disposable, the file is not.
 *
 * The rows a reader sees are therefore a **viewing layer** over this file, and
 * the file is the format. Both writers — the gateway, for what an AI client
 * does, and the control plane, for what a person does in the console — build
 * their entries here so the two can never disagree about what an entry is.
 *
 * ## An entry carries its own machine copy
 *
 * Each line is prose for a person, with the fields it was rendered from in a
 * trailing HTML comment:
 *
 *     - **17:26** @sayo added 3 notes in `1-projects/…` <!--ctx {"at":…}-->
 *
 * Comments rather than a fenced data block for the reason the privacy markers
 * are comments (`<!-- BEGIN BRAIN PRIVACY RULES -->`): a reading view hides
 * them, so the file stays a document. The prose is **generated, never parsed**
 * — edit it by hand and the next write rewrites it. The comment is what is
 * read back, and `--` inside it is escaped so a path or a summary can never
 * close the comment early.
 *
 * ## The file is private, and that is load-bearing
 *
 * Entries name paths, and a path is a fact about somebody's work. A single
 * file cannot be both "the owner's complete history" and "what a member may
 * read", so this one is the former: the gateway stores it `private`, every
 * entry records the visibility of what it describes, and a caller below owner
 * tier is served a filtered *rendering* rather than the file. `visibleEntries`
 * is that filter, and it fails closed twice over — the flag recorded when the
 * change happened, and `canSee` re-derived through the live manifest now.
 *
 * ## Substance is decided here, once
 *
 * "Only decent and substantial changes" is the whole product requirement for
 * this file, and it is a *filter with a bias*: the cost of dropping a real
 * change is that somebody misses it, and the cost of keeping a trivial one is
 * that the list stops being read at all. The second cost is larger, so the
 * rules below drop aggressively and say so — see `SUBSTANCE` for the list and
 * `entryFor` for the arithmetic.
 */

/** Where the file lives. Root, beside `index.md` — it is a note, not plumbing. */
const ACTIVITY_PATH = "activity.md";

const BEGIN_MARKER = "<!-- BEGIN CONTEXT ACTIVITY -->";
const END_MARKER = "<!-- END CONTEXT ACTIVITY -->";

/**
 * How many entries the file keeps.
 *
 * A bound rather than forever, because every write rewrites the whole file:
 * 400 entries is about 60 KB, which is a rewrite a note save can afford, and
 * about three months of a busy shared context. What falls off the end is not
 * lost — `.context/audit/` keeps every change record, and this file is
 * rebuildable from it.
 */
const MAX_ENTRIES = 400;

/**
 * How much a revision has to change to be worth a line.
 *
 * Measured on the stored bytes, in either direction, because a deletion is a
 * change. 80 bytes is about a sentence: it drops a fixed typo, a frontmatter
 * `updated:` bump and the whitespace churn an editor makes on open, and keeps
 * anything anybody would describe as an edit.
 *
 * It is deliberately not "did the text change at all". That test passes for
 * every autosave, and a feed with one line per autosave is the log the meeting
 * already rejected as unreadable.
 */
const MIN_REVISION_BYTES = 80;

/** Two changes by one hand inside this window are one line. */
const GROUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Sessions group over a working day rather than half an hour.
 *
 * A saved session is one line per client per stretch of work, because the
 * inbox of an active context collects dozens of them and every one of them is
 * the same sentence.
 */
const SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How stale a merged entry's timestamp is allowed to get before the file is
 * rewritten again.
 *
 * This is what makes the console's 2-second autosave affordable. The first
 * save of an editing session writes a line; the next hundred find that line
 * already there, inside the window, less than five minutes old, and write
 * nothing at all. The cost is that "revised" can read five minutes behind the
 * last keystroke, which nobody can perceive in a list whose finest grain is a
 * minute.
 */
const REFRESH_MS = 5 * 60 * 1000;

/** At most this many paths are kept on a grouped entry; the count is exact. */
const MAX_ENTRY_PATHS = 5;

/** A summary longer than this is a paragraph, and this is a list. */
const MAX_SUMMARY_LENGTH = 140;

/**
 * The kinds, and what each one is for.
 *
 * A closed set, because the viewing layer draws a mark per kind and an unknown
 * kind would draw nothing. Both writers map their own vocabulary onto this —
 * the gateway's `create_note` and the console's `file.create` are one kind.
 */
const KINDS = Object.freeze([
  "added",
  "revised",
  "moved",
  "archived",
  "published",
  "meeting",
  "session",
]);

/**
 * What each writer's action becomes, and what is deliberately dropped.
 *
 * `null` means "never a line". Read the nulls as the specification they are:
 *
 *  - **Reads** are not here at all, from either writer. Opening a note is not
 *    a change, and a feed that reported them would be surveillance.
 *  - **Plumbing** — `materialize_move`'s second half, the storage-layout
 *    migration, search projection, form response files — describes the
 *    product working, not somebody working.
 *  - **Arrivals on a timer** — mail, chat, calendar — are a sync job's output.
 *    They arrive by the hundred and nobody chose them.
 *  - **Proposals** are not here because they are already somewhere better: a
 *    proposal is a queue with a decision attached, and `list_proposals` is
 *    where its reviewer looks. An approved one lands as `added`.
 *  - **Key rotation and export** stay in the audit trail. They are the
 *    owner's security events, and the owner reads them where security events
 *    live rather than between two notes about a project.
 *  - **Making something private** is never a line, in either direction: the
 *    line would be the disclosure. Widening to team is, because that is an
 *    invitation to read.
 */
const SUBSTANCE = Object.freeze({
  // The gateway's vocabulary — `recordChange` in apps/mcp/src/index.js.
  create_note: "added",
  update_note: "revised",
  archive_note: "archived",
  move_note: "moved",
  move_notes: "moved",
  move_folder: "moved",
  set_visibility: "published",
  set_folder_visibility: "published",
  save_context: "session",
  meeting_note: "meeting",
  approve_proposal: "added",
  propose_note: null,
  reject_proposal: null,
  materialize_move: null,
  inbox_capture: null,
  inbox_update: null,
  calendar_sync: null,
  encrypt_note: null,
  decrypt_note: null,
  rotate_encryption_keys: null,
  export_encryption_keys: null,

  // The console's vocabulary — `recordEvent` in apps/convex/functions.
  "file.create": "added",
  "file.write": "revised",
  "file.move": "moved",
  "file.archive": "archived",
  "file.copy": "added",
  "file.duplicate": "added",
  "visibility.note": "published",
  "visibility.folder": "published",
  "visibility.folder.named": "published",
  "folder.create": null,
  "file.delete": null,
  "file.decrypt": null,
  "vault.import": null,
  "vault.replace.clear": null,
});

/**
 * Paths that never produce a line, whatever the action says.
 *
 * The dot-segment rule is `isPlumbing`'s, restated here because this module
 * cannot import either privacy engine and must not need to: a key with a dot
 * segment is Context's own storage and is not a note in any tool.
 *
 * `activity.md` itself is the one that would otherwise be a loop — a file
 * whose every write records that it was written.
 */
function isQuietPath(path) {
  if (typeof path !== "string" || path === "") return true;
  if (path === ACTIVITY_PATH) return true;
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Text that cannot become markup, in a file made of markup.
 *
 * A summary is written by an AI client, and a path can be written by anybody
 * who can create a note. Both are rendered into a Markdown line that also
 * carries an HTML comment, so both are stripped of the three characters that
 * would let them leave the sentence they are in: `<` and `>` (which open a
 * comment — and a forged `<!--ctx …-->` in the prose would be read back as a
 * *real entry*, which is a way to write history you did not make) and the
 * backtick (which closes the code span a path is drawn in).
 *
 * Stripping rather than escaping, because this is a list of one-line
 * sentences: nobody needs a literal angle bracket in one badly enough to
 * justify an escaping scheme that has to be exactly right forever.
 */
function stripMarkup(value) {
  return String(value).replace(/[<>`]/g, "");
}

function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const flat = stripMarkup(value).replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_SUMMARY_LENGTH
    ? `${flat.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : flat;
}

/** `1-projects/a/b.md` → `1-projects/a`; a root note → `""`. */
function folderOf(path) {
  const cut = String(path || "").lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** `1-projects/a/b.md` → `b.md`. */
function nameOf(path) {
  const cut = String(path || "").lastIndexOf("/");
  return cut === -1 ? String(path || "") : path.slice(cut + 1);
}

/**
 * Whether this change is worth opening the file for.
 *
 * The cheap half of `entryFor`: the action table and the path rule, both
 * answerable without reading anything. It exists because the expensive half of
 * recording a change is the read that comes before the decision, and the
 * decision is `null` for most changes — a read, a proposal, a sync job's
 * arrival, a write under `.context/`. Both writers call this first, so the
 * ordinary change pays nothing at all.
 *
 * It is deliberately *looser* than `entryFor`: the size test and the
 * visibility test need details this cannot see. A `true` here means "worth
 * looking", never "this will be a line".
 */
function mayBeReportable(action, paths) {
  const kind = Object.prototype.hasOwnProperty.call(SUBSTANCE, action)
    ? SUBSTANCE[action]
    : null;
  if (!kind) return false;
  const touched = (Array.isArray(paths) ? paths : []).filter(
    (path) => typeof path === "string" && path !== "",
  );
  if (!touched.length) return false;
  return !touched.some(isQuietPath);
}

/**
 * One change, as the entry it becomes — or `null`, which is the common answer.
 *
 * Takes the same three things both writers already have: what happened, which
 * paths it touched, and the details they recorded about it. `actor` is the
 * acting identity; a change with no actor (a meeting landing) keeps `by: null`
 * rather than inventing one.
 */
function entryFor(input) {
  const { action, paths, details, actor, at } = input || {};
  const kind = Object.prototype.hasOwnProperty.call(SUBSTANCE, action)
    ? SUBSTANCE[action]
    : null;
  if (!kind) return null;

  const touched = (Array.isArray(paths) ? paths : []).filter(
    (path) => typeof path === "string" && path !== "",
  );
  if (!touched.length) return null;
  // Every path, not the first: a move names two, and a move out of a private
  // folder is not reportable because its destination happens to be readable.
  if (touched.some(isQuietPath)) return null;

  const meta = details || {};

  if (kind === "revised" && !isSubstantialRevision(meta)) return null;
  // A form response is a submission, and submissions are read in the form's
  // own note. It is recorded as an ordinary note write, so the marker is the
  // only thing that tells them apart.
  if (meta.form_id) return null;
  if (kind === "published" && !widensToTeam(action, meta)) return null;

  const count = countFor(kind, action, meta, touched);
  // `move_notes` interleaves [from, to, from, to, …]; every other move names
  // one pair. Keeping the destinations is what makes "moved 6 notes into
  // backlog" say where they went.
  const keptPaths =
    action === "move_notes"
      ? touched.filter((_, index) => index % 2 === 1).slice(0, MAX_ENTRY_PATHS)
      : touched.slice(0, MAX_ENTRY_PATHS);

  return {
    at: typeof at === "string" ? at : new Date().toISOString(),
    kind,
    paths: keptPaths,
    n: count,
    vis: meta.team_visible === true ? "team" : "private",
    by: actor && typeof actor.name === "string" ? actor.name : null,
    via: actor && typeof actor.client === "string" ? actor.client : null,
    note: normalizeSummary(meta.summary),
  };
}

/**
 * Whether a revision changed enough to be worth saying.
 *
 * Unknown sizes count as substantial. Both writers can usually supply them,
 * and a writer that cannot must not be silently muted — the merge window is
 * what stops that case flooding the file, not this test.
 */
function isSubstantialRevision(details) {
  const now = Number(details.content_bytes);
  const before = Number(details.previous_bytes);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return true;
  return Math.abs(now - before) >= MIN_REVISION_BYTES;
}

/** Only a widening is reportable. See `SUBSTANCE`. */
function widensToTeam(action, details) {
  if (action === "set_visibility" || action === "visibility.note") {
    return details.to === "team";
  }
  if (action === "set_folder_visibility") {
    return details.to === "team" || details.requested === "team";
  }
  if (action === "visibility.folder" || action === "visibility.folder.named") {
    return details.to === "team" || details.visibility === "team";
  }
  return details.team_visible === true;
}

function countFor(kind, action, details, touched) {
  const recorded = Number(details.count);
  if (Number.isFinite(recorded) && recorded > 0) return Math.floor(recorded);
  if (action === "move_notes") return Math.max(1, Math.floor(touched.length / 2));
  if (kind === "published") {
    const widened = Number(details.newly_team_visible_notes);
    if (Number.isFinite(widened) && widened > 0) return Math.floor(widened);
  }
  return 1;
}

/**
 * Whether a new entry belongs to a line that is already there.
 *
 * One hand, one kind, one window — and then either the same note or the same
 * folder. Never across two people, never across one person's two clients, and
 * never across a kind: "moved 3 notes" and "revised 3 notes" are different
 * sentences about different work.
 */
function mergeable(existing, entry, windowMs) {
  if (!existing) return false;
  /*
    A note added and then edited is one event, and the first sentence is the
    true one. Without this, writing a note and typing into it ten seconds later
    reads as "@sayo added week-one.md" followed by "@sayo revised week-one.md",
    which is the feed reporting the mechanics of an editor rather than the work
    — and it is the single most common thing anybody does in the console.

    One direction only: a revision does not absorb a later *creation*, because
    that would be a different note.
  */
  const sameWork =
    existing.kind === entry.kind ||
    (existing.kind === "added" && entry.kind === "revised");
  if (!sameWork) return false;
  if ((existing.by || null) !== (entry.by || null)) return false;
  if ((existing.via || null) !== (entry.via || null)) return false;
  const gap = Date.parse(entry.at) - Date.parse(existing.at);
  if (!Number.isFinite(gap) || gap < 0 || gap > windowMs) return false;
  if (existing.paths.includes(entry.paths[0])) return true;
  // A folder groups writes; a move already says where it went, and two moves
  // into one folder from two different places are two facts.
  if (entry.kind !== "added" && entry.kind !== "revised" && entry.kind !== "session") {
    return false;
  }
  return folderOf(existing.paths[0]) === folderOf(entry.paths[0]);
}

function windowFor(kind) {
  return kind === "session" ? SESSION_WINDOW_MS : GROUP_WINDOW_MS;
}

/**
 * The entries a change produces, given the entries already on file.
 *
 * Returns `null` when nothing needs writing, which is the answer that makes
 * this affordable — see `REFRESH_MS`. Otherwise the merged list, newest first
 * and capped.
 *
 * Only the most recent few lines are considered for a merge. Scanning the
 * whole file would join a note revised this morning to the same note revised
 * this afternoon whenever nothing happened in between, which is a line that
 * says the wrong time about the wrong edit.
 */
const MERGE_LOOKBACK = 8;

function applyEntry(entries, entry) {
  const list = Array.isArray(entries) ? entries : [];
  const window = windowFor(entry.kind);
  const limit = Math.min(MERGE_LOOKBACK, list.length);
  for (let index = 0; index < limit; index += 1) {
    const candidate = list[index];
    if (!mergeable(candidate, entry, window)) continue;
    const age = Date.parse(entry.at) - Date.parse(candidate.at);
    const known = new Set(candidate.paths);
    const widens = entry.paths.some((path) => !known.has(path));
    // Already said, recently enough, about the same notes: the file on disk is
    // already correct and the cheapest correct write is none.
    if (!widens && age < REFRESH_MS) return null;
    const paths = candidate.paths
      .concat(entry.paths.filter((path) => !known.has(path)))
      .slice(0, MAX_ENTRY_PATHS);
    const merged = {
      // `...candidate` first, so an edit folded into a creation stays a
      // creation. See `mergeable`.
      ...candidate,
      at: entry.at,
      paths,
      // Counting distinct notes rather than writes: six saves of one note is
      // one note, and that is the number a reader wants.
      n: Math.max(
        candidate.n,
        new Set(candidate.paths.concat(entry.paths)).size,
        entry.n,
      ),
      // A merged group takes the wider tier only when every part had it.
      vis: candidate.vis === "team" && entry.vis === "team" ? "team" : "private",
      note: entry.note || candidate.note || null,
    };
    const next = list.slice();
    next.splice(index, 1);
    next.unshift(merged);
    return next;
  }
  return [entry].concat(list).slice(0, MAX_ENTRIES);
}

/* ------------------------------------------------------------------ *
 * Rendering and parsing
 * ------------------------------------------------------------------ */

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Dates are rendered in UTC, deliberately.
 *
 * A file two people and four clients write to has no single local time, and a
 * heading that moves depending on who saved last would make every diff a
 * reshuffle. The console renders its rows in the reader's zone from `at`,
 * which is the only place a zone is known.
 */
function dayHeading(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Undated";
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function clockOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function dayKey(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * Who a line is about, in the possessive form the meeting asked for.
 *
 * "@sayo's Claude" rather than a client id, because the distinction that
 * matters to a reader is a person's own hand versus the assistant they pointed
 * at the context — "oh, Shyoh's Claude did this".
 */
function actorLabel(entry) {
  const by = entry.by || null;
  const via = entry.via || null;
  if (by && via) return `${by}'s ${via}`;
  if (by) return by;
  if (via) return via;
  return "Someone";
}

function code(text) {
  return `\`${stripMarkup(text)}\``;
}

/** The sentence, built the same way for the file and for the console. */
function describeEntry(entry) {
  const who = actorLabel(entry);
  const first = entry.paths[0] || "";
  const many = entry.n > 1;
  const folder = folderOf(first);
  const where = folder ? code(folder) : "the root";
  switch (entry.kind) {
    case "added":
      return many
        ? `${who} added ${entry.n} notes in ${where}`
        : `${who} added ${code(first)}`;
    case "revised":
      return many
        ? `${who} revised ${entry.n} notes in ${where}`
        : `${who} revised ${code(first)}`;
    case "archived":
      return `${who} archived ${code(entry.paths[entry.paths.length - 1] || first)}`;
    case "moved":
      return many
        ? `${who} moved ${entry.n} notes into ${where}`
        : `${who} moved ${code(first)}`;
    case "published":
      return many
        ? `${who} gave the team ${entry.n} notes in ${where}`
        : `${who} gave the team ${code(first)}`;
    case "meeting":
      return `A meeting landed: ${code(first)}`;
    case "session":
      return `${who} saved a session`;
    default:
      return `${who} changed ${code(first)}`;
  }
}

/**
 * The machine copy, escaped so it cannot end the comment it lives in.
 *
 * Every hyphen that is followed by another hyphen is written as `-`,
 * which JSON reads back as a hyphen and an HTML parser cannot read as the end
 * of a comment. A path like `2026-09-19` keeps both of its hyphens visible;
 * only an adjacent pair is touched, and adjacent pairs are the only way to
 * build `-->`.
 */
function encodeEntry(entry) {
  return JSON.stringify(entry).replace(/-(?=-)/g, "\\u002d");
}

function decodeEntry(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    if (typeof value.at !== "string") return null;
    if (!KINDS.includes(value.kind)) return null;
    const paths = Array.isArray(value.paths)
      ? value.paths.filter((path) => typeof path === "string" && path !== "")
      : [];
    if (!paths.length) return null;
    return {
      at: value.at,
      kind: value.kind,
      paths: paths.slice(0, MAX_ENTRY_PATHS),
      n: Number.isFinite(value.n) && value.n > 0 ? Math.floor(value.n) : 1,
      vis: value.vis === "team" ? "team" : "private",
      by: typeof value.by === "string" ? value.by : null,
      via: typeof value.via === "string" ? value.via : null,
      note: typeof value.note === "string" ? value.note : null,
    };
  } catch {
    return null;
  }
}

const HEADER = `---
role: activity
---

# Activity

What has changed in this context, newest first. Context writes this file as
changes happen and the console reads it back, so editing the lines below by
hand is harmless and temporary. Every change is also recorded in
\`.context/audit/\`, which is what this file is built from and can be rebuilt
from.

Only substantial changes are listed. Repeat saves of one note by one hand
inside half an hour are one line, and reads are never recorded at all.
`;

function renderFile(entries) {
  const lines = [HEADER, BEGIN_MARKER, ""];
  let day = null;
  for (const entry of entries) {
    const key = dayKey(entry.at);
    if (key !== day) {
      if (day !== null) lines.push("");
      lines.push(`## ${dayHeading(entry.at)}`, "");
      day = key;
    }
    const summary = entry.note ? ` — ${entry.note}` : "";
    lines.push(
      `- **${clockOf(entry.at)}** ${describeEntry(entry)}${summary} <!--ctx ${encodeEntry(entry)}-->`,
    );
  }
  if (!entries.length) {
    lines.push("_Nothing yet. This fills in as people and their AI clients work._");
  }
  lines.push("", END_MARKER, "");
  return lines.join("\n");
}

/**
 * The entries in a file, newest first.
 *
 * Reads only the machine copies, and only between the markers: anything a
 * person typed into this file is left alone by every consumer, which is what
 * makes hand-editing it safe rather than destructive.
 */
function parseFile(text) {
  if (typeof text !== "string" || !text) return [];
  const begin = text.indexOf(BEGIN_MARKER);
  const body = begin === -1 ? text : text.slice(begin + BEGIN_MARKER.length);
  const end = body.indexOf(END_MARKER);
  const region = end === -1 ? body : body.slice(0, end);
  const entries = [];
  const pattern = /<!--ctx\s+([\s\S]*?)-->/g;
  let match = pattern.exec(region);
  while (match) {
    const entry = decodeEntry(match[1]);
    if (entry) entries.push(entry);
    match = pattern.exec(region);
  }
  return entries.slice(0, MAX_ENTRIES);
}

/**
 * The whole operation, as one pure function: current file in, next file out.
 *
 * `null` means "nothing to write", and both callers are expected to treat that
 * as success. It is the answer for a change that is not substantial, for a
 * path that is not a note, and — most often — for a repeat save inside the
 * window of a line that already says it.
 */
function nextFile(currentText, change) {
  const entry = entryFor(change);
  if (!entry) return null;
  const entries = applyEntry(parseFile(currentText), entry);
  if (!entries) return null;
  return { text: renderFile(entries), entries, entry };
}

/**
 * The entries a given reader may see.
 *
 * Two independent gates, and a change has to pass both:
 *
 *  1. **What was decided when it happened.** `vis` is the same immutable
 *     event-time flag `list_changes` reads, so a note that was private when it
 *     changed never becomes reportable later.
 *  2. **What the manifest says now.** `canSee` is re-derived per path at read
 *     time, so a note taken back into private disappears from the rendering
 *     for everyone who lost it, including from lines written while it was
 *     shared.
 *
 * `owner` skips both, because the file is the owner's own record and they can
 * read it as a note in any case.
 */
function visibleEntries(entries, options) {
  const { owner, canSee } = options || {};
  if (owner) return entries.slice();
  return entries.filter((entry) => {
    if (entry.vis !== "team") return false;
    if (typeof canSee !== "function") return false;
    return entry.paths.every((path) => canSee(path));
  });
}

/** How many of these are newer than the reader's last visit. */
function unseenCount(entries, seenAt) {
  const since = Number(seenAt);
  if (!Number.isFinite(since) || since <= 0) return entries.length;
  return entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at > since;
  }).length;
}

/**
 * The paths a reader has not caught up with, for the dots in the file tree.
 *
 * Notes only, and folders are the caller's job: the tree knows which of its
 * rows are collapsed and this does not.
 */
function unseenPaths(entries, seenAt) {
  const since = Number(seenAt);
  const paths = new Set();
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(since) && since > 0 && (!Number.isFinite(at) || at <= since)) {
      continue;
    }
    for (const path of entry.paths) paths.add(path);
  }
  return paths;
}

module.exports = {
  ACTIVITY_PATH,
  BEGIN_MARKER,
  END_MARKER,
  GROUP_WINDOW_MS,
  KINDS,
  MAX_ENTRIES,
  MAX_ENTRY_PATHS,
  MAX_SUMMARY_LENGTH,
  MERGE_LOOKBACK,
  MIN_REVISION_BYTES,
  REFRESH_MS,
  SESSION_WINDOW_MS,
  SUBSTANCE,
  actorLabel,
  applyEntry,
  describeEntry,
  entryFor,
  folderOf,
  isQuietPath,
  mayBeReportable,
  nameOf,
  nextFile,
  parseFile,
  renderFile,
  unseenCount,
  unseenPaths,
  visibleEntries,
};
