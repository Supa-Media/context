/** `list_meetings` and `read_meeting`. */

import { canSee, effectiveVisibility } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { isMeetingNotePath, MEETINGS_FOLDER } from "../../../../packages/meetings/src/paths.js";
import { listAllKeys, mapInBatches, probeWithLegacyFallback } from "../notes/storage.js";
import { meetingFileName } from "./communicationsSupport.js";
import { normalizePath } from "../notes/paths.js";
import { parseMeetingNote, splitTranscript } from "../../../../packages/meetings/src/note.js";
import { toolError, toolText } from "./results.js";

/**
 * The meetings this connection can see, newest first.
 *
 * Read off the **notes**, never off an index: the files are canonical and
 * `isMeetingNotePath` recognises one, so there is no second list to fall out of
 * step with what is actually in the bucket. A meeting whose note its owner
 * moved out of the folder stops being listed here and is still a note — which
 * is the correct behaviour for a product whose whole claim is that the files
 * are theirs.
 *
 * A meeting a person *filed* elsewhere at finalize time (`FinalizeBody.folder`)
 * is the same case reached a step earlier, and it is why no folder is passed
 * here. `isMeetingNotePath` answers about the folder it is given; there is no
 * meetings table recording where any given meeting went, by decision, and
 * scanning the whole bucket for `YYYY-MM-DD-*.md` would call somebody's
 * ordinary dated note a meeting. So this lists the default folder, and every
 * other tool reaches the rest.
 *
 * `canSee` filters before anything is read, so a team connection cannot learn
 * that a private meeting exists by counting.
 */
export async function toolListMeetings(store, scope, rules, overrides, limitArg) {
  const limit = Number.isInteger(limitArg) ? limitArg : 10;
  if (limit < 1 || limit > 25) return toolError("limit must be between 1 and 25");
  const visible = (await listAllKeys(store, `${MEETINGS_FOLDER}/`))
    .filter(({ key }) => isMeetingNotePath(key) && canSee(key, scope, rules, overrides))
    /*
      Newest first, off the FILENAME rather than the whole key, and costing no
      reads either way: every meeting note is named `YYYY-MM-DD-…` in UTC.

      The whole key used to be the sort, which was right while every meeting sat
      at the same depth. It stopped being right the day the date folders were
      dropped: a legacy `…/2026/03/2026-03-04-x.md` and a current
      `…/2026-03-04-x.md` differ at the character after the year, where `/`
      sorts above `-`, so reverse key order put every old meeting ahead of every
      new one whatever their dates said. The filename is the half that never
      moved.
    */
    .sort((a, b) => meetingFileName(b.key).localeCompare(meetingFileName(a.key)) || b.key.localeCompare(a.key))
    .slice(0, limit);
  if (!visible.length) return toolText("(no meetings recorded yet)");

  const rows = await mapInBatches(visible, 10, async ({ key }) => {
    const object = await getWithLegacyFallback(store, key);
    if (!object) return null;
    const note = parseMeetingNote(await object.text());
    const front = note.frontmatter || {};
    const attendees = Array.isArray(front.attendees)
      ? front.attendees.join(", ")
      : String(front.attendees || "");
    const parts = [
      String(front.started || "").slice(0, 10) || "undated",
      note.title || "(untitled meeting)",
    ];
    if (front.duration) parts.push(String(front.duration));
    if (attendees) parts.push(attendees);
    return `${parts.join(" · ")}\n  ${key}`;
  });

  return toolText(
    `${rows.filter(Boolean).join("\n")}\n\n` +
      "Pass a path to read_meeting. Transcripts are held in the same note and omitted " +
      "unless you ask for them."
  );
}

/**
 * One meeting note, with the transcript left behind unless it is asked for.
 *
 * One meeting is one file — the owner decided that, and the transcript is
 * appended to the end of the same note under `## Transcript` rather than living
 * in a sibling. The consequence is handled here rather than pushed onto the
 * caller: forty minutes of speech is about forty kilobytes, so returning the
 * whole file by default would spend a model's context on a verbatim record
 * nobody asked for. `splitTranscript` finds the boundary in one linear pass,
 * and the answer says how much was dropped and how to ask for it — a model that
 * is not told the transcript exists cannot decide it needs it.
 *
 * Every refusal is the same two words `read_note` uses, for the same reason: a
 * meeting nobody may see and a path that never existed are one answer.
 */
export async function toolReadMeeting(store, scope, rules, overrides, args) {
  const path = normalizePath(args.path);
  if (!path) return toolError("invalid path");
  // Both questions asked, then decided, so the refusal for a note being held
  // back costs what the refusal for an absent one costs; on metadata, so no
  // unreadable body is pulled in to refuse. `toolReadNote` argues it in full.
  const seen = canSee(path, scope, rules, overrides);
  const present = await probeWithLegacyFallback(store, path);
  if (!seen || !present) return toolError("not found");
  const object = await getWithLegacyFallback(store, path);
  if (!object) return toolError("not found");
  const text = await object.text();
  const header =
    `etag: ${object.etag}\npath: ${path}\n` +
    `visibility: ${effectiveVisibility(path, rules, overrides)}`;

  if (args.transcript === true) return toolText(`${header}\n\n${text}`);
  const { head, transcript } = splitTranscript(text);
  if (transcript === null) return toolText(`${header}\n\n${head.trimEnd()}`);
  return toolText(
    `${header}\n\n${head.trimEnd()}\n\n` +
      `[transcript omitted: ${transcript.length} characters of what was said. ` +
      "Call read_meeting again with transcript: true to include it.]"
  );
}
