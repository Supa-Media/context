/**
 * The check-in's gather helpers: the pure parts of looking at what changed
 * since the last look, shared by the check-in node (`graph/nodes/checkin.js`)
 * and by `heartbeat.js`, which re-exports them for its tests and for the rest
 * of the check-in. They live here, not in `heartbeat.js`, because the node
 * cannot import `heartbeat.js` without a cycle (`heartbeat.js` imports the node).
 */

import { CONTACTS_FOLDER, asInboxKey } from "../../../../packages/communications/src/protocol.js";
import { ATTENTION_FOLDER, ATTENTION_SETTINGS_PATH, HEARTBEAT_FOLDER, HEARTBEAT_SETTINGS_PATH } from "./checkIns.js";
import { DREAMS_FOLDER } from "./dream.js";
import { ABOUT_ME_PATH, OLD_ABOUT_ME_PATH } from "./aboutMe.js";
import { LEARNED_SKILLS_FOLDER } from "./learnedSkills.js";
import { CALENDAR_SHOWN } from "./checkInSources.js";
import { dayOf, longDate } from "./jobLog.js";
import { isPlumbing } from "../privacy/engine.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A first look (or one whose `since` is unknown) goes back this far. */
export const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;

/** Today's log: `tex/heartbeat/2026-10-17.md`, dated in their zone. */
export function heartbeatPath(now, timeZone) {
  return `${HEARTBEAT_FOLDER}/${dayOf(now, timeZone)}.md`;
}

/** The heading of a day's log (`jobLog.js` `appendLogEntryWhy`). */
export function heading(now, timeZone) {
  return (
    `# Tex checked in, ${longDate(now, timeZone)}\n\n` +
    "What Tex looked at when it checked your workspace on its own, and what it texted you. " +
    `Pause it with \`paused: true\` in \`${HEARTBEAT_SETTINGS_PATH}\`, or tell it there what you want to hear about.\n`
  );
}

/** Tex's own job output, which never counts as something that changed. */
const OWN_OUTPUT = [`${HEARTBEAT_FOLDER}/`, `${DREAMS_FOLDER}/`, "tex/housekeeping/", "tex/handbacks/", `${ATTENTION_FOLDER}/`, `${LEARNED_SKILLS_FOLDER}/`];
const OWN_NOTES = new Set([ABOUT_ME_PATH, OLD_ABOUT_ME_PATH, HEARTBEAT_SETTINGS_PATH, ATTENTION_SETTINGS_PATH]);

function isOwnOutput(key) {
  const lower = key.toLowerCase();
  return OWN_NOTES.has(lower) || OWN_OUTPUT.some((prefix) => lower.startsWith(prefix));
}

/**
 * The notes changed since `since` from a tree listing (`store.treeEntries`),
 * newest first: Markdown notes only, never plumbing and never Tex's own job
 * output.
 */
export function changedSince(entries, since) {
  const changed = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = entry?.key;
    const uploaded = entry?.uploaded;
    if (typeof key !== "string" || !key.toLowerCase().endsWith(".md")) continue;
    if (!(uploaded instanceof Date) || Number.isNaN(uploaded.getTime()) || uploaded.getTime() <= since) continue;
    if (isPlumbing(key) || isOwnOutput(key)) continue;
    changed.push({ key, at: uploaded.getTime() });
  }
  return changed.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** A dated note (`…/2026-10-19.md`) older than this is a rewrite of the past, not news. */
const RECENT_DAY_MS = 2 * DAY_MS;
const DATED = /(\d{4}-\d{2}-\d{2})[^/]*\.md$/i;

/**
 * The changed notes in the order a look should see them: news first, newest
 * first, then what a sync rewrote in bulk. A re-import that rewrites weeks of
 * chat days and a contact page per sender is newer than this morning's mail,
 * and the shown list is cut at `MAX_CHANGED_SHOWN`, so newest-first alone
 * buried Google's verification email below forty rewritten chat days
 * (production, 2026-10-19, the 12:11 look). A note dated more than two days
 * before `now`, and a contact page, go after everything else.
 */
export function newsFirst(changed, now) {
  const later = (key) => {
    if (asInboxKey(key).toLowerCase().startsWith(`${CONTACTS_FOLDER}/`)) return true;
    const dated = DATED.exec(key);
    if (dated === null) return false;
    const day = Date.parse(`${dated[1]}T00:00:00Z`);
    return Number.isFinite(day) && day < now - RECENT_DAY_MS;
  };
  return [...changed.filter((note) => !later(note.key)), ...changed.filter((note) => later(note.key))];
}

/** Whether a look in this day's log was shown today's calendar (`heartbeatEntry`'s "Looked at" line). */
export function calendarLooked(log) {
  return String(log ?? "").split("\n").some((line) => line.startsWith("_Looked at ") && line.includes(CALENDAR_SHOWN));
}

/** What a look with nothing changed leaves in the day's log (`jobLog.js` `logSkipped`). */
/** What a look that could not list the workspace leaves in the day's log. */
export const TREE_UNAVAILABLE_WORDS = "Couldn't list what changed, so it read nothing; it tries again in a few minutes.";
export const NOTHING_NEW_WORDS = "Nothing changed since the last look, so it read nothing and ran no model.";
export const BUSY_WORDS = "They were texting with you, so it read nothing; it looks again once the chat has been quiet for ten minutes.";

/** How long the chat must have been quiet before a check-in looks (the owner, 2026-10-19). */
export const QUIET_MS = 10 * 60 * 1000;

/**
 * Whether they are mid-conversation: a text of theirs kept less than
 * `QUIET_MS` ago. Tex's own texts (a check-in, a routine) never count, or a
 * check-in would hold back the next. Only the log (`events.js`) knows when an
 * exchange was; a check-in reading the old file goes ahead as before.
 */
export function midConversation(conversation, now) {
  return conversation.some((turn) => turn.theirs === true && Number.isFinite(turn.at) && now - turn.at < QUIET_MS);
}
