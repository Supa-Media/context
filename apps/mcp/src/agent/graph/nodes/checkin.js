/**
 * The check-in's start node: the gather half of `handleHeartbeat`
 * (`agent/heartbeat.js`), from reading the person's check-in settings to the
 * model's provider being opened. A graph runner follows its `to` wire.
 *
 * It takes plain input, which is safe to log: { timeZone, since, started }. Everything live (the dispatcher, the store, the session, the
 * control plane) comes in through `io.ctx.checkin`,
 * and so does what the rest of the check-in reads: `io.ctx.checkin.look`,
 * set only on the `look` branch. Note text, mail and functions never go in the
 * output, so the output can be logged and replayed as it is.
 *
 * Outputs:
 *   - { to: "done", status, body }: the check-in ends here with that HTTP answer.
 *   - { to: "look", counts, calendar }: the model's look goes ahead; the values are in `io.ctx.checkin.look`.
 *
 * It imports only from the agent's own modules, never from another node, and
 * never from `heartbeat.js`, which imports this file.
 */

import { readWithEtag, logSkipped, refusedRun } from "../../jobLog.js";
import { quietHoursEnd, readSettings } from "../../quietHours.js";
import { ATTENTION_SETTINGS_PATH, HEARTBEAT_SETTINGS_PATH } from "../../checkIns.js";
import { checkInMutes } from "../../checkInGuards.js";
import { lookChangedEntries } from "../../lookTree.js";
import { newMailSince } from "../../newMail.js";
import { WORTH_SAYING, readMailHealth } from "../../mailHealth.js";
import { newChatSince, newSlackSince, todaysCalendar } from "../../checkInSources.js";
import { readConversation } from "../../conversation.js";
import { RECENT_TEXTS_SHOWN } from "../../checkInTexts.js";
import { openProvider } from "../../turn.js";
import {
  BUSY_WORDS,
  FIRST_LOOK_MS,
  NOTHING_NEW_WORDS,
  TREE_UNAVAILABLE_WORDS,
  calendarLooked,
  changedSince,
  heading,
  heartbeatPath,
  midConversation,
  newsFirst,
} from "../../checkInGather.js";

export async function checkin(input, io) {
  const { dispatch, store, session, env, controlPlane } = io.ctx.checkin;
  const { timeZone, since, started } = input;

  const settingsNote = await readWithEtag(dispatch, HEARTBEAT_SETTINGS_PATH);
  const until = quietHoursEnd(settingsNote?.body, started, timeZone); // their quiet hours: when to come back, or null

  const sinceAt = since ?? started - FIRST_LOOK_MS;

  const settings = readSettings(settingsNote?.body ?? "");
  if (settings.paused) return { to: "done", status: 200, body: { outcome: "paused" } };
  if (until !== null) return { to: "done", status: 200, body: { outcome: "quiet_hours", until } }; // nothing looked at; what changed waits
  // What they muted, here or for their agents' pings: never texted, whatever the model says.
  const mutes = checkInMutes(settingsNote?.body ?? "", (await readWithEtag(dispatch, ATTENTION_SETTINGS_PATH))?.body ?? "");

  // A look that runs no model still leaves its line in the day's log.
  const skipped = (words) => {
    const now = Date.now();
    return logSkipped(dispatch, { path: heartbeatPath(now, timeZone), heading: heading(now, timeZone), now, timeZone, words });
  };
  const listed = await lookChangedEntries(store, sinceAt);
  if (!listed.entries) {
    // What changed can't be told while the tree cannot be read: tried again soon, from the same point.
    console.log(JSON.stringify({ event: "heartbeat_tree", workspace: session.workspaceId, reason: listed.code, tries: listed.tries }));
    await skipped(TREE_UNAVAILABLE_WORDS);
    return { to: "done", status: 503, body: { error: "tree_unavailable", reason: listed.code } };
  }
  const entries = listed.entries;
  const changed = newsFirst(changedSince(entries, sinceAt), Date.now());
  // New mail is asked of Gmail: nothing of a mailbox is copied into notes (2026-10-21).
  const mail = await newMailSince(store, sinceAt);
  // A mailbox that stopped syncing changes no note, so it is asked after on its own (`mailHealth.js`).
  const mailboxes = await readMailHealth(store);
  const owed = mailboxes.filter((mailbox) => mailbox.tell && WORTH_SAYING.has(mailbox.state));
  // Today's calendar, read live: copied day notes are gone (2026-10-21), so no changed note brings it.
  const calendar = await todaysCalendar(store, started, timeZone);
  const slack = await newSlackSince(store, sinceAt);
  const chat = await newChatSince(store, sinceAt);
  // A day with meetings gets one look for them alone; after that the calendar rides along with whatever changed.
  const calendarNew =
    calendar?.events === true &&
    changed.length === 0 &&
    mail.length === 0 &&
    !calendarLooked((await readWithEtag(dispatch, heartbeatPath(started, timeZone)))?.body);
  // Nothing changed since the last look, no new mail, Slack or Chat, no mailbox owed a word and no unseen day: no model turn spent.
  if (changed.length === 0 && mail.length === 0 && slack.length === 0 && chat.length === 0 && owed.length === 0 && !calendarNew) {
    await skipped(NOTHING_NEW_WORDS);
    return { to: "done", status: 200, body: { outcome: "nothing_new" } };
  }

  // A check-in never lands in the middle of a chat: the control plane asks again once it has gone quiet.
  // Only the last few: each exchange is a read, and a look's reads are counted (above).
  const conversation = await readConversation(store, "texts", { entries: RECENT_TEXTS_SHOWN });
  if (midConversation(conversation, Date.now())) {
    await skipped(BUSY_WORDS);
    return { to: "done", status: 200, body: { outcome: "busy" } };
  }

  try {
    await openProvider(controlPlane, session, undefined, env);
  } catch (error) {
    const refused = await refusedRun(error, skipped);
    return { to: "done", status: refused.status, body: refused.body };
  }

  io.ctx.checkin.look = { changed, mail, mailboxes, owed, calendar, slack, chat, conversation, settings, settingsNote, mutes, until };
  return {
    to: "look",
    counts: { changed: changed.length, mail: mail.length, slack: slack.length, chat: chat.length, owed: owed.length },
    calendar: calendar !== null,
  };
}
