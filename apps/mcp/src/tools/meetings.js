/** `list_meetings` and `read_meeting`. */

import { canSee, effectiveVisibility, isPlumbing } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { isMeetingNotePath } from "../../../../packages/meetings/src/paths.js";
import { loadPrivacyState } from "../privacy/state.js";
import { searchSettingsOf } from "../search/settings.js";
import { listAllKeys, probeWithLegacyFallback } from "../notes/storage.js";
import { servedListingStore } from "../tree/served.js";
import { factProps } from "../tree/facts.js";
import { meetingFileName } from "./communicationsSupport.js";
import { normalizePath } from "../notes/paths.js";
import { splitTranscript } from "../../../../packages/meetings/src/note.js";
import { toolError, toolText } from "./results.js";

/** Notes whose props one listing asks the tree for, at most: a few requests' worth. */
export const MEETING_SCAN_NOTES = 1_500;

/** `YYYY-MM-DD` anywhere in a file name: `2026-10-20-sync-ab12.md`, `untitled-2026-10-20.md`. */
const DATED_NAME = /(\d{4}-\d{2}-\d{2})/;
/** A folder whose name says it holds meetings: `meetings/`, `2-areas/meetings/1:1s/…`. */
const MEETINGS_FOLDER_NAME = /(^|\/)[^/]*meeting[^/]*\//i;

/**
 * The meetings this connection can see, newest first, wherever they were
 * filed, and in every workspace the person can reach (owner's report,
 * 2026-10-21).
 *
 * Tex was asked for the to-dos from "my last meeting with <a colleague>" and answered
 * from an August note, then an October 14 one, while yesterday's recorded
 * call sat in a one-to-one folder of its own (`…/meetings/1:1s/<them>/`): this
 * listed only `0-inbox/meetings/` of one workspace, and a search ranks by
 * words, not by date. So a meeting is now recognised where it lies, by what
 * the note says about itself rather than by its folder:
 *
 *  - its front matter says `type: meeting` (every recorder writes it,
 *    `packages/meetings/src/note.js`), read from the tree's props, never by
 *    opening the note (owner, 2026-10-13); or
 *  - it is a dated note in a folder named for meetings (`…/meetings/…`), the
 *    shape a meeting recorded into a new note gets (`untitled-2026-10-20.md`)
 *    once something rewrote it without its front matter; or
 *  - it sits in the default folder with the name the recorder gives it, as
 *    before (`isMeetingNotePath`).
 *
 * The objection `docs/decisions/meetings/namespacing-and-signing.md` raised to
 * scanning, that any dated note would be called a meeting, is why a date alone
 * is never enough: the date has to be in a meetings folder, or the note has
 * to say it is one. The scan is bounded (`MEETING_SCAN_NOTES`): past it, only
 * the notes whose path names a date or meetings are asked about.
 *
 * `canSee` filters before anything is asked, so a team connection cannot
 * learn that a private meeting exists by counting, and every other workspace
 * is opened the way `search_notes` everywhere opens it (`tools/search.js`):
 * under the person's role there, its own tree and its own rules — a
 * workspace that cannot be read right now left out, never guessed at.
 */
export async function toolListMeetings(store, scope, rules, overrides, limitArg) {
  const limit = Number.isInteger(limitArg) ? limitArg : 10;
  if (limit < 1 || limit > 25) return toolError("limit must be between 1 and 25");
  const names =
    searchSettingsOf(store).everywhere && typeof store.openContext === "function"
      ? (store.contexts ?? []).filter((entry) => !entry.current && typeof entry.name === "string").map((entry) => entry.name)
      : [];
  const [here, ...elsewhere] = await Promise.all([
    meetingsIn(store, scope, rules, overrides),
    ...names.map(async (name) => {
      try {
        const { session: target, store: targetStore } = await store.openContext(name);
        const privacy = await loadPrivacyState(targetStore);
        if (privacy.error) return [];
        /*
          Listed from that workspace's own tree, never its bucket. The
          dispatcher serves the caller's own store (`tools/dispatch.js`), but
          a store `openContext` builds is raw, and `tree/served.js` names this
          tool among the ones whose privacy is "decided twice, never once
          less": the control plane's clearance there, then `canSee` over its
          rules. Wrapped here as orient's cross-workspace survey wraps it
          (`orient/workspaces.js`); a tree that cannot answer throws
          `TreeUnavailable`, and the catch below leaves that workspace out
          rather than walking it.
        */
        const found = await meetingsIn(servedListingStore(targetStore), target.scope, privacy.rules, privacy.overrides);
        return found.map((meeting) => ({ ...meeting, key: `${name}/${meeting.key}` }));
      } catch {
        return [];
      }
    }),
  ]);
  const meetings = [...here, ...elsewhere.flat()]
    .sort((a, b) => b.when.localeCompare(a.when) || a.key.localeCompare(b.key))
    .slice(0, limit);
  if (!meetings.length) return toolText("(no meetings recorded yet)");

  const crossWorkspace = meetings.some(({ key }) => key.startsWith("@"));
  return toolText(
    `${meetings.map(rowFor).join("\n")}\n\n` +
      "Newest first, from every folder. Pass a path to read_meeting. Transcripts are held in the same note and omitted " +
      "unless you ask for them." +
      (crossWorkspace
        ? ' A path that starts with @name/ is in that workspace: pass context: "@name" with the rest of the path to read it.'
        : "")
  );
}

/** The meetings of one workspace this caller may see: `{ key, when, fact, front }`, unsorted. */
async function meetingsIn(store, scope, rules, overrides) {
  const visible = (await listAllKeys(store, ""))
    .map(({ key }) => key)
    .filter((key) => key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides));
  const named = (key) => isMeetingNotePath(key) || (MEETINGS_FOLDER_NAME.test(key) && DATED_NAME.test(meetingFileName(key)));
  const asked =
    visible.length <= MEETING_SCAN_NOTES
      ? visible
      : visible.filter((key) => named(key) || /meeting/i.test(key) || DATED_NAME.test(meetingFileName(key))).slice(0, MEETING_SCAN_NOTES);
  const facts = (await factProps(store, asked)) ?? new Map();

  const found = [];
  for (const key of asked) {
    const fact = facts.get(key);
    const front = fact?.props?.properties ?? {};
    const typed = String(front.type ?? "").trim().toLowerCase() === "meeting";
    if (!typed && !named(key)) continue;
    const filed = DATED_NAME.exec(meetingFileName(key))?.[1] ?? "";
    const started = String(front.started || "").trim();
    const when = started || filed;
    found.push({ key, when, fact, front });
  }
  return found;
}

/** One listing line: when, what, how long, who, then the path to read. */
function rowFor({ key, when, fact, front }) {
  const shown = when || "undated";
  if (!fact) return `${shown} · (details still loading)\n  ${key}`;
  if (fact.sealed) return `${shown} · (encrypted)\n  ${key}`;
  const attendees = Array.isArray(front.attendees) ? front.attendees.join(", ") : String(front.attendees || "");
  const parts = [shown, fact.props.heading || "(untitled meeting)"];
  if (front.duration) parts.push(String(front.duration));
  if (attendees) parts.push(attendees);
  return `${parts.join(" · ")}\n  ${key}`;
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
