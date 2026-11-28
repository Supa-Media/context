/**
 * Note path normalization and the path-shaped predicates and names the note
 * tools share. Moved verbatim out of `src/index.js`.
 */

import { classifyCaptureKind } from "../communications/paths.js";

// Pure, and read by Tex too (`packages/shared/src/texContract/notePath.cjs`).
export { normalizePath } from "../../../../packages/shared/src/texContract/notePath.cjs";

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function isPersonalCommunicationsPath(path) {
  const kind = classifyCaptureKind(path);
  return kind === "channel-day" || kind === "calendar-day";
}

export { isChatHistoryPath } from "../../../../packages/shared/src/texContract/chatHistoryPath.cjs";

/* ------------------- the ChatGPT dialect: search and fetch ----------------- */

/**
 * `search` and `fetch` are the same capabilities as `search_notes` and
 * `read_note`, wearing the one tool contract ChatGPT's ordinary chats can use.
 *
 * Outside developer mode, ChatGPT invokes exactly two tools on a custom
 * connector — ones literally named `search` and `fetch`, speaking OpenAI's
 * deep-research shape: `search(query)` answers one text block of JSON
 * `{"results":[{id,title,text,url}]}`, and `fetch(id)` answers
 * `{id,title,text,url,metadata}`. Every other tool on the connector is
 * invisible to those chats, which is why a beautifully described `orient` was
 * never called unprompted there: the failure was never persuasion, the tools
 * could not be reached. Verified live before this existed — asked "who is my
 * sister?", ChatGPT ranked Gmail and Contacts and never considered this
 * connector until named.
 *
 * Both go through the same visibility filtering as everything else — the scan
 * is literally `scanVisibleNotes`, shared with `search_notes` — so this
 * dialect discloses nothing the ordinary one would not.
 *
 * A note has no public URL the gateway can name, so `url` is a
 * `context://note/...` URI: stable, unique per result as the contract wants,
 * resolving nowhere on purpose.
 *
 * An owner can now mint an unlisted link to one note from their console, so
 * "there is no public URL" — what this comment used to say — is no longer the
 * reason. The reason is stronger: that link is a 64-hex token the owner handed
 * to somebody deliberately, this connection is not told which notes have one,
 * and putting one here would republish it into every search result. An https
 * URL invented for a note that has no link would imply a page that does not
 * exist.
 */
export function noteUrl(path) {
  return `context://note/${encodeURI(path)}`;
}
