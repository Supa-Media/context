/**
 * WHAT THE APP HAD OPEN, ON A TEST MESSAGE (Dev2, 2026-11-27: "1:1 group and in app tests").
 *
 * An in-app conversation (`packages/tex/src/texSets.cjs`, kind "app") and an in-app Lab test chat carry, on a person's
 * message, what the Context app had open as it went: `{ note?: { workspace, path }, tabs?: [{ workspace, path }],
 * selection? }`, the shape the app's own send has (`packages/tex/gateway/agent/screen.js` `validSeen`). This checks
 * that a screen is one the app could send. It lives in the Lab, beside the edits and test chats that use it.
 */
"use strict";

/** What a message's `screen` may hold, as the app's send does (`screen.js`): at most 8 tabs and 2,000 characters selected. */
const SCREEN_TABS = 8;
const SCREEN_SELECTION = 2000;
const SCREEN_PATH = /^(?!\/|@)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,509}\.(?:md|csv)$/i;

/** One note on screen: `{ workspace, path }`, a workspace name and a relative `.md` or `.csv` path. */
const screenNoteOk = (n) =>
  n !== null && typeof n === "object" && !Array.isArray(n) && typeof n.workspace === "string" && /^@?[a-z0-9][a-z0-9-]{0,63}$/i.test(n.workspace) && typeof n.path === "string" && SCREEN_PATH.test(n.path);

/** What is wrong with a message's `screen`, as sentences; empty when the app could have sent it. */
function screenProblems(screen) {
  if (screen === null || typeof screen !== "object" || Array.isArray(screen)) return ["screen is { note?, tabs?, selection? }"];
  const out = [];
  for (const k of Object.keys(screen)) if (!["note", "tabs", "selection"].includes(k)) out.push(`screen has no "${k}": it is note, tabs and selection`);
  if (screen.note !== undefined && !screenNoteOk(screen.note)) out.push('screen.note is { workspace: "@name", path } with a .md or .csv path');
  if (screen.tabs !== undefined && (!Array.isArray(screen.tabs) || screen.tabs.length === 0 || screen.tabs.length > SCREEN_TABS || !screen.tabs.every(screenNoteOk))) out.push(`screen.tabs is 1 to ${SCREEN_TABS} notes, each { workspace, path }`);
  if (screen.selection !== undefined && (typeof screen.selection !== "string" || !screen.selection.trim() || screen.selection.length > SCREEN_SELECTION)) out.push(`screen.selection is 1 to ${SCREEN_SELECTION} characters`);
  if (screen.selection !== undefined && screen.note === undefined) out.push("screen.selection is text selected in the open note, so it needs a note");
  if (screen.note === undefined && screen.tabs === undefined) out.push("screen names a note or tabs");
  return out;
}

module.exports = { SCREEN_TABS, SCREEN_SELECTION, screenProblems };
