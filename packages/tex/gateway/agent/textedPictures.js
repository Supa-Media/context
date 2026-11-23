/**
 * A PICTURE THEY TEXTED, KEPT IN A NOTE OF ITS OWN SO A LATER TEXT CAN SEE IT
 * AGAIN.
 *
 * Until 2026-11-02 a texted picture was stored by the day's transcript note
 * (`tex/transcripts/`), the only note that embedded it, and `read_image`
 * reached it through that note. The transcripts are no longer written: the
 * chat's ledger is its one record (decided by the owner, 2026-11-02;
 * `docs/decisions/texting-assistant/chat-ledger.md`). A picture is a file,
 * not a line of the chat, so it gets a plain note to live in:
 * `tex/pictures/YYYY-MM.md`, one a month in their zone, each picture embedded
 * under the time it came. The image store stays reachable only through a note
 * that names the image (`tools/readImage.js`), and this note is theirs, in
 * their personal workspace, exported like any other.
 *
 * A group chat's pictures are kept the same way in its home (`chatHome.js`), under `<home>/pictures/`, when its
 * front door reads the week's history (`weekHistory.js`), which shows them again for 7 days.
 *
 * Written through the dispatcher, so the tree, the privacy engine and the
 * note's history see it like any other write. Best effort: a picture that
 * could not be kept is named as seen only on that turn.
 */

import { IMAGE_TYPES } from "./attachments.js";
import { appendLogEntry, clock, longDate, readWithEtag } from "./jobLog.js";
import { wallClock } from "../../../shared/src/routines.cjs";
import { MAX_UPLOADED_BYTES_PER_WRITE, embeddedUploadLeaf, prepareNoteImages } from "../../../../apps/mcp/src/notes/uploadedImages.js";

export const PICTURES_FOLDER = "tex/pictures";
/** One write takes at most this many pictures (`write_note`'s `images`). */
const MAX_PICTURES = 10;

const pad = (n) => String(n).padStart(2, "0");
const plainName = (name) => String(name ?? "").replace(/[\[\]|`\r\n]+/g, " ").trim() || "picture";

/** The month's note: `tex/pictures/2026-11.md`, in their zone; a group's in its home's own `pictures/` folder. */
export function picturesPath(now, timeZone, folder = PICTURES_FOLDER) {
  const w = wallClock(now, timeZone);
  return `${folder}/${w.year}-${pad(w.month)}.md`;
}

/**
 * Keep the pictures among what they texted. Answers `[{ index, leaf, note }]`
 * for each one kept, by its place in `attachments` (`attachments.js`
 * `attachmentsLine`), or `[]` when there were none or the note could not be
 * written.
 */
export async function keepTextedPictures(dispatch, { now, timeZone, attachments, folder = PICTURES_FOLDER, group = false }) {
  const list = Array.isArray(attachments) ? attachments : [];
  const found = [];
  let bytes = 0;
  for (const [index, attachment] of list.entries()) {
    if (attachment?.carried || typeof attachment?.data !== "string" || !IMAGE_TYPES.has(attachment.mediaType)) continue;
    if (found.length >= MAX_PICTURES) break;
    const data = `data:${attachment.mediaType};base64,${attachment.data}`;
    const prepared = await prepareNoteImages("", [{ name: "picture", data }]).catch(() => null);
    const image = prepared?.images?.[0];
    if (!image?.leaf || bytes + image.bytes.byteLength > MAX_UPLOADED_BYTES_PER_WRITE) continue;
    bytes += image.bytes.byteLength;
    found.push({ index, leaf: image.leaf, name: plainName(attachment.name), data });
  }
  if (found.length === 0) return [];
  const note = picturesPath(now, timeZone, folder);
  const images = [...new Map(found.map((picture) => [picture.leaf, { name: picture.leaf, data: picture.data }])).values()];
  // A month's note holds many days: each picture under its day and time (a UI/UX audit, 2026-11-02).
  const entry = `## ${longDate(now, timeZone).replace(/, \d{4}$/, "")}, ${clock(now, timeZone)}\n\n${found.map((picture) => `![[${picture.leaf}|${picture.name}]]`).join("\n")}\n`;
  const w = wallClock(now, timeZone);
  const month = longDate(Date.UTC(w.year, w.month - 1, 15), "UTC").replace(/ \d+,/, "");
  const heading = group
    ? `# Pictures sent in this chat in ${month}\n\nKept so Tex can look at them again. The chat's to keep, move or delete.\n`
    : `# Pictures you texted Tex in ${month}\n\nKept so Tex can look at them again. Yours to keep, move or delete.\n`;
  const kept = await appendLogEntry(dispatch, note, entry, heading, { images }).catch(() => false);
  if (!kept) return [];
  // The store keeps a compressed copy under its own name (`upload-<hash>.webp` for a `.jpg`, #2575), and the note
  // embeds that one: the name read back from the note is the one every later look asks for (2026-11-23).
  const written = await readWithEtag(dispatch, note);
  return found.map(({ index, leaf }) => ({ index, leaf: (written?.body && embeddedUploadLeaf(written.body, leaf)) || leaf, note }));
}
