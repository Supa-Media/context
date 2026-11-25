/**
 * WHAT THE PERSON HAS OPEN IN THE APP, AS TEX SEES IT (design D1, "Tex sees the open note").
 *
 * When they text Tex from the Context app's chat, the app sends what is on screen: the open note, up to eight other tabs
 * and a selection (`body.seen` on `/tex/app-chat`'s send). The route checks it here (`validSeen`) and saves it beside the
 * app chat's object (`texChat/appSeen.js`), where it is never in the chat's ledger, its rows or its words. A 1:1 turn
 * of the app reads it back within ten minutes and, when the front door's `ctx` lists `screen`, is told it in the turn's
 * note (`screenNote`). The open note's text is read through the turn's own dispatcher, so the person's own access
 * applies: a note they cannot see, or in a workspace they have no entry for, is left out.
 *
 * Quiet context: the words say it is there to use when it helps, never to say Tex was told. Nothing here logs a
 * path, a word of a note or a selection; the log is `{ event: "tex_screen", outcome }` only.
 */

import { texConfigOf, texStep } from "./texConfig.js";
import { objectByName } from "../../../../apps/mcp/src/objectPlace.js";

/** The module in the front door's `ctx` that turns this on (`screen` or `screen:<chars>`). */
export const SCREEN_MODULE = "screen";
/** How much of the open note's text the turn is told, when the ctx names no count. */
export const DEFAULT_CHARS = 6000;
/** The most of the open note's text a turn is told, whatever the ctx names. */
export const MAX_CHARS = 20000;
/** A screen saved longer ago than this is not read back. */
export const SCREEN_WINDOW_MS = 10 * 60 * 1000;
/** The most open tabs a screen keeps. */
export const MAX_TABS = 8;
/** The most of a selection a screen keeps: longer is dropped, not cut. */
export const MAX_SELECTION = 2000;
/** The most a path, an id or a workspace name keeps. */
const MAX_PATH = 512;
const MAX_ID = 128;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The ctx entry that turns the module on for this turn's config, or null (`screen` or `screen:<chars>`). */
function screenEntry(env) {
  try {
    const ctx = texStep("fd", texConfigOf(env))?.ctx;
    return Array.isArray(ctx) ? (ctx.find((entry) => typeof entry === "string" && (entry === SCREEN_MODULE || /^screen:\d+$/.test(entry))) ?? null) : null;
  } catch {
    return null;
  }
}

/** Whether this turn's config (a Lab draft's in a Lab test chat's turn) has the front door read the screen. */
export function screenOn(env) {
  return screenEntry(env) !== null;
}

/** How many characters of the open note this turn is told: `screen:<chars>` from the ctx, default 6000, at most 20000. */
export function screenChars(env) {
  const entry = screenEntry(env);
  const named = entry !== null && entry.includes(":") ? Number(entry.slice(entry.indexOf(":") + 1)) : NaN;
  if (!Number.isInteger(named) || named < 1) return DEFAULT_CHARS;
  return Math.min(named, MAX_CHARS);
}

/** A string, trimmed, that is not empty and at most `max` characters; null otherwise. */
function short(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= max && !trimmed.includes("\0") ? trimmed : null;
}

/** Whether a path is a sheet (`.csv`), which is filled by its rows rather than rewritten. */
const isSheet = (path) => /\.csv$/i.test(path);

/**
 * A plain note path: relative, `.md` or a sheet's `.csv`, no `..` step, at most 512 characters. A sheet counts: on
 * 2026-11-24 an empty sheet open in the editor was dropped here, and Tex made a new file instead of filling it.
 */
function notePath(value) {
  const path = short(value, MAX_PATH);
  if (path === null || !/\.(md|csv)$/i.test(path) || path.startsWith("/") || path.startsWith("@") || path.split("/").includes("..")) return null;
  return path;
}

/**
 * One note as the app names it: `{ workspace, path }` and, when the app has one, `noteId`; null when the workspace or
 * path is not valid. The console names notes by path (2026-11-21), so a missing id is fine; a malformed one drops the note.
 */
function noteOf(value) {
  if (!isPlainObject(value)) return null;
  const workspace = short(value.workspace, MAX_ID);
  const path = notePath(value.path);
  if (workspace === null || path === null) return null;
  if (value.noteId === undefined || value.noteId === "") return { workspace, path };
  const noteId = short(value.noteId, MAX_ID);
  return noteId === null ? null : { workspace, noteId, path };
}

/**
 * The screen the app sent, checked: what is valid is kept, what is not is dropped (a send is never refused for it).
 * Returns `{ note?, tabs?, selection? }` with only the parts that remain, or null when none does.
 */
export function validSeen(value) {
  if (!isPlainObject(value)) return null;
  const note = noteOf(value.note);
  const tabs = Array.isArray(value.tabs) ? value.tabs.map(noteOf).filter((tab) => tab !== null).slice(0, MAX_TABS) : [];
  const selection = short(value.selection, MAX_SELECTION);
  const seen = {
    ...(note !== null ? { note } : {}),
    ...(tabs.length > 0 ? { tabs } : {}),
    ...(selection !== null ? { selection } : {}),
  };
  return Object.keys(seen).length > 0 ? seen : null;
}

/** Saves the screen beside the app chat (`POST /app/seen` on its object). A failure is logged by outcome and never thrown. */
export async function saveSeen(env, chatId, seen, now) {
  try {
    const answer = await objectByName(env.TEX_CHAT, `chat:${chatId}`).fetch(
      new Request("https://chat/app/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inbox: chatId, ...seen, at: now() }),
      }),
    );
    console.log(JSON.stringify({ event: "tex_screen", outcome: answer.ok ? "saved" : "save_failed" }));
  } catch {
    console.log(JSON.stringify({ event: "tex_screen", outcome: "save_failed" }));
  }
}

/** The app's saved screen for this person, when it is under ten minutes old; null otherwise (or when none was saved). */
export async function readScreen(env, actorUserId, now) {
  try {
    const answer = await objectByName(env.TEX_CHAT, `chat:app:${actorUserId}`).fetch(new Request("https://chat/app/seen"));
    if (!answer.ok) return null;
    const kept = await answer.json();
    const at = isPlainObject(kept) ? kept.at : undefined;
    if (typeof at !== "number" || !Number.isFinite(at) || Math.abs(now - at) > SCREEN_WINDOW_MS) return null;
    return validSeen(kept);
  } catch {
    return null;
  }
}

/** The workspace a name is, among the contexts the person has: `{}` for the turn's own, `{ context: "@name" }` for another, or null. */
function reachOf(contexts, workspace, ownId = null) {
  // The console may name the person's own workspace by its id; any other is named "@slug", as `contextsFor` lists it.
  if (typeof ownId === "string" && workspace === ownId) return {};
  const want = workspace.replace(/^@/, "").toLowerCase();
  const entry = (Array.isArray(contexts) ? contexts : []).find((item) => typeof item?.name === "string" && item.name.replace(/^@/, "").toLowerCase() === want);
  if (entry === undefined) return null;
  return entry.current === true ? {} : { context: entry.name };
}

/** The body of a read, without its header lines; empty for an error or a read that gave none. */
function bodyOf(result) {
  if (!result || result.isError === true) return "";
  const text = String(result?.content?.[0]?.text ?? "");
  const cut = text.indexOf("\n\n");
  return (cut === -1 ? "" : text.slice(cut + 2)).trim();
}

/**
 * The screen as this person may see it: a note or tab in a workspace they have no entry for is left out (with its
 * selection, when the note is the one selected in). Reads the open note's text through `dispatch` (the turn's own
 * note read, so its access checks apply); a read that fails leaves the text out and keeps the path.
 */
export async function screenForTurn({ env, actorUserId, contexts, dispatch, ownId = null, now = Date.now() }) {
  const seen = await readScreen(env, actorUserId, now);
  if (seen === null) return null;
  const listed = (item) => reachOf(contexts, item.workspace, ownId);
  const note = seen.note !== undefined && listed(seen.note) !== null ? seen.note : undefined;
  const tabs = (seen.tabs ?? []).filter((tab) => listed(tab) !== null);
  if (note === undefined && tabs.length === 0) {
    console.log(JSON.stringify({ event: "tex_screen", outcome: "unreachable" }));
    return null;
  }
  let noteText = null;
  if (note !== undefined) {
    const reach = listed(note);
    try {
      noteText = bodyOf(await dispatch("read_note", { path: note.path, ...reach }));
    } catch {
      noteText = null;
    }
  }
  console.log(JSON.stringify({ event: "tex_screen", outcome: note === undefined ? "tabs" : noteText === null || noteText === "" ? "note_unread" : "note" }));
  return {
    seen: { ...(note !== undefined ? { note } : {}), ...(tabs.length > 0 ? { tabs } : {}), ...(note !== undefined && seen.selection !== undefined ? { selection: seen.selection } : {}) },
    noteText: noteText === "" ? null : noteText,
    chars: screenChars(env),
  };
}

/**
 * The turn note's words for the screen (`screenForTurn`'s result): empty when there is none. The note's first characters
 * are cut at `chars` and say so; a selection and the other tabs follow the note.
 */
export function screenNote({ seen = null, noteText = null, chars = DEFAULT_CHARS } = {}) {
  if (seen === null) return "";
  const lines = ["ON SCREEN IN THE APP (quiet context: use it when it helps answer, never say you were told it):"];
  if (seen.note !== undefined) {
    const sheet = isSheet(seen.note.path);
    const workspace = seen.note.workspace.startsWith("@") ? seen.note.workspace : `@${seen.note.workspace}`;
    lines.push(`${sheet ? "Open sheet" : "Open note"}: ${seen.note.path} (${workspace})`);
    if (typeof noteText === "string" && noteText !== "") lines.push(noteText.length > chars ? `${noteText.slice(0, chars)}…` : noteText);
    // A sheet is changed in place by its rows; "fill this" about it is never a new file.
    if (sheet) lines.push(`"this sheet" or "this spreadsheet" means this one: change it in place with write_note with rows (append, update), in ${workspace}, never a new file.`);
  }
  if (typeof seen.selection === "string" && seen.selection !== "") lines.push(`Selected: "${seen.selection}"`);
  const others = (seen.tabs ?? []).filter((tab) => tab.path !== seen.note?.path || tab.workspace !== seen.note?.workspace).map((tab) => tab.path);
  if (others.length > 0) lines.push(`Other open tabs: ${others.join(", ")}`);
  return lines.join("\n");
}
