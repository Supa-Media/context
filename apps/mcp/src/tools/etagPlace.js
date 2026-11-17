/**
 * A NOTE'S VERSION NAMES WHERE THE NOTE IS.
 *
 * An etag used to be the bare version of a stored object, so it said nothing
 * about which workspace, or which note, it came from. On 2026-11-17 a Tex job
 * read `@crystal-care/projects/…`, then wrote the bare path with that etag,
 * which addressed the caller's own `@seyi`. The write was told "conflict" four
 * times, re-read nothing useful, and left a second copy in the wrong place.
 *
 * So every etag a routed call hands out carries its place:
 *
 *     @<workspace>/<noteId>:<version>     (noteId where the read knew it)
 *     @<workspace>:<version>
 *
 * and every etag a routed call is given is checked against the place the call
 * goes to (`tools/session.js` `routeToolCall`, the one place routing is
 * decided). An etag from another workspace is refused with both places
 * named; one from another note matches no version, and the tool answers it as
 * it answers any stale one. It is never used to reroute the call: the caller
 * said where the write goes, and quietly sending it somewhere else is the
 * wrong-workspace mistake in the other direction.
 *
 * A bare version (an etag from before this, or from the gateway's own code,
 * which calls tools unrouted) is still accepted as it always was: the tools
 * below only ever see the bare version.
 */

/** The arguments that hand a note's version back, at the top of a call and inside a batch's items. */
const ETAG_FIELDS = ["expected_etag", "expected_source_etag", "expected_privacy_etag"];
const ITEM_LISTS = ["moves", "notes"];

/** Before a version that names another note, so it matches no note's version and the tool answers it as stale. */
const NO_VERSION = "other-note.";

const PLACED = /^(@[a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_-]+))?:(.+)$/s;

/** `{ workspace: "@name", noteId, version }` for a placed etag, or null for a bare one. */
export function parsePlacedEtag(etag) {
  if (typeof etag !== "string") return null;
  const match = PLACED.exec(etag.trim());
  if (!match) return null;
  return { workspace: match[1], noteId: match[2] ?? null, version: match[3] };
}

/** The bare version an etag names, placed or not. */
export function bareEtag(etag) {
  return parsePlacedEtag(etag)?.version ?? etag;
}

/** `raw` stamped with its workspace (`@name`) and, where known, its note's id. */
export function placeEtag(raw, workspace, noteId = null) {
  if (typeof raw !== "string" || raw === "" || parsePlacedEtag(raw)) return raw;
  if (typeof workspace !== "string" || !PLACED.test(`${workspace}:x`)) return raw;
  const note = typeof noteId === "string" && /^[A-Za-z0-9_-]+$/.test(noteId) ? `/${noteId}` : "";
  return `${workspace}${note}:${raw}`;
}

/** Every bare etag in a tool answer's header (each part's text before its first blank line) placed in `workspace`. */
export function placeAnswerEtags(result, workspace) {
  if (!result || !Array.isArray(result.content) || typeof workspace !== "string") return result;
  const ids = noteIdsOf(result);
  result.content = result.content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    const cut = part.text.indexOf("\n\n");
    const header = cut === -1 ? part.text : part.text.slice(0, cut);
    const path = /^path: (.+)$/m.exec(header)?.[1]?.trim();
    const noteId = path ? ids.get(path) ?? null : null;
    // `etag: X` lines, `(etag X)` and `current etag X`: the header only, so a note whose own text talks about etags is untouched.
    const placed = header.replace(/(^etag: |^new_etag: |\(etag |current etag )([^\s),]+)/gm, (whole, lead, raw) => lead + placeEtag(raw, workspace, noteId));
    return placed === header ? part : { ...part, text: placed + (cut === -1 ? "" : part.text.slice(cut)) };
  });
  return result;
}

/** `path → noteId` for the notes a read reported opening (`notes/read.js` `opened`, `notesOpened`). */
function noteIdsOf(result) {
  const ids = new Map();
  const opened = [result.opened, ...(Array.isArray(result.notesOpened) ? result.notesOpened : [])];
  for (const note of opened) {
    if (note && typeof note.path === "string" && typeof note.noteId === "string") ids.set(note.path, note.noteId);
  }
  return ids;
}

/** Each etag argument of a call, as `{ holder, field, path }`: the object holding it and the note path it is about. */
function etagArguments(args) {
  const found = [];
  const pathOf = (holder) => holder.path ?? holder.source ?? null;
  for (const field of ETAG_FIELDS) {
    if (typeof args[field] === "string") found.push({ holder: args, field, path: field === "expected_privacy_etag" ? null : pathOf(args) });
  }
  for (const list of ITEM_LISTS) {
    if (!Array.isArray(args[list])) continue;
    for (const item of args[list]) {
      if (!item || typeof item !== "object") continue;
      for (const field of ETAG_FIELDS) if (typeof item[field] === "string") found.push({ holder: item, field, path: pathOf(item) });
    }
  }
  return found;
}

/**
 * Check every etag a call hands back against the place it goes, and leave the
 * bare version for the tool. Returns a refusal's words, or null.
 *
 * `workspace` is `@name` of the context the call was routed to, `store` that
 * context's store (asked for a note's id only when an etag names one).
 * `args` is changed in place: each placed etag becomes its bare version.
 */
export async function checkEtagPlaces(args, { workspace, store }) {
  if (!args || typeof args !== "object") return null;
  ownItems(args);
  for (const { holder, field, path } of etagArguments(args)) {
    const placed = parsePlacedEtag(holder[field]);
    if (!placed) continue;
    const here = typeof workspace === "string" ? workspace : null;
    if (here !== null && placed.workspace !== here) return wrongWorkspace(field, placed.workspace, here, path);
    if (placed.noteId && typeof path === "string" && typeof store?.noteIdAt === "function") {
      const there = await store.noteIdAt(path).catch(() => null);
      // Another note's version can never be this one's, even where the two notes' bytes are alike. Said as the tool
      // says any stale version, never in words of its own: this runs before the tool asks whether the caller may see
      // the note at `path`, so "a different note is there" would tell anybody holding any etag that one exists.
      if (typeof there === "string" && there !== placed.noteId) {
        holder[field] = `${NO_VERSION}${placed.version}`;
        continue;
      }
    }
    holder[field] = placed.version;
  }
  return null;
}

/** The refusal for an etag from `there` handed to a call that goes to `here`, naming both places. */
function wrongWorkspace(field, there, here, path) {
  const where = typeof path === "string" && path !== "" ? path.replace(/^\/+/, "") : null;
  return (
    `refused: that ${field} is the version of a note in ${there}, and this call goes to ${here}` +
    `${where ? ` (${here}/${where})` : ""}. Nothing was changed, and the call was not sent anywhere else. ` +
    (where
      ? `To change the note you read, address it where it is: path "${there}/${where}". `
      : `To change the note you read, address it in ${there}. `) +
    `To change a note in ${here}, read it there first and pass the etag that read gives you.`
  );
}

/** Every placed etag in `args` made bare, unchecked: for the gateway's own unrouted calls (`tools/dispatch.js`). */
export function bareEtagArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (!etagArguments(args).some(({ holder, field }) => parsePlacedEtag(holder[field]))) return args;
  const own = ownItems({ ...args });
  for (const { holder, field } of etagArguments(own)) holder[field] = bareEtag(holder[field]);
  return own;
}

/** `args` with its batch items copied, so making an etag bare never changes the caller's own objects. */
function ownItems(args) {
  for (const list of ITEM_LISTS) {
    if (Array.isArray(args[list])) args[list] = args[list].map((item) => (item && typeof item === "object" && !Array.isArray(item) ? { ...item } : item));
  }
  return args;
}

/**
 * The workspace half of `checkEtagPlaces`, from names alone, before anything is opened: for a Lab test chat's turn,
 * whose writes are answered by the test chat (`labSandbox/policy.js`) and never reach the routed check. `context`
 * is the place the call names (`@name`, from `addressByPath`), or null for the caller's own `own`.
 */
export function etagWorkspaceRefusal(args, { context, own }) {
  if (!args || typeof args !== "object") return null;
  const fold = (name) => {
    if (typeof name !== "string" || name.trim() === "") return null;
    const text = name.trim().toLowerCase();
    return text.startsWith("@") ? text : `@${text}`;
  };
  const here = fold(context) ?? fold(own);
  if (here === null) return null;
  for (const { holder, field, path } of etagArguments(ownItems({ ...args }))) {
    const placed = parsePlacedEtag(holder[field]);
    if (placed && placed.workspace !== here) return wrongWorkspace(field, placed.workspace, here, path);
  }
  return null;
}
