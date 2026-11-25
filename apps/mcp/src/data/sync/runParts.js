/**
 * The steps every sync run takes, whatever it keeps: a "Fetch from a URL" source (`run.js`) or a "right now"
 * metric's hourly reading (`snap.js`). Each step answers what it found, or the run's outcome when it stops there
 * (`{result}`), so a run reads as a list of checks (`docs/decisions/data-and-metrics.md`, "The sync object").
 *
 * - **Whose standing**: the person who armed it must still be a live owner or editor, by the workspace object's own
 *   members, every run.
 * - **The note it is about**, found by its note id (a rename or move is followed) and read as that person reads it,
 *   with the folder doing the Data job found by its job, never its name.
 * - **The bucket**, opened from the workspace object for that same person, judged a live member there again.
 * - **The write**: over the version read (a conditional put), the sheet's new version recorded in the workspace
 *   object as any save is, and an audit entry naming the data sync and the person it ran for.
 */

import { parseSheet } from "../../sheets/csv.js";
import { isEncryptedNote } from "../../encryption/format.js";
import { openedFromObject } from "../../store/objectBinding.js";
import { storeForOpenedBinding } from "../../sessionStore.js";
import { recordChange } from "../../activity/record.js";
import { createControlPlane } from "../../controlPlane.js";

/** The data sync's own client id on its audit entries: not a person, not an AI client. */
export const DATA_SYNC_CLIENT_ID = "context_data_sync";
/** The audit action a sync's write is recorded under. */
export const DATA_SYNC_ACTION = "data_sync";
const EDITORS = new Set(["owner", "editor"]);
const FILE_KEY = /^files\/[0-9a-f-]{36}\.csv$/;

export const stopped = (said) => ({ outcome: "stopped", said });
export const failed = (said) => ({ outcome: "failed", said });
/** Its note is gone, or out of its person's reach: the object forgets it, since no page can ask about it. */
export const gone = (what = "its about.md") => ({ outcome: "stopped", said: `Stopped: ${what} is gone.`, gone: true });
const LATER = "it will try again within the hour";

/** The reader a run reads as: the armer, judged by the object from its own member row. Or `{result}`. */
export async function armerReader(client, armedBy) {
  let member;
  try {
    member = (await client.members.get(armedBy))?.member ?? null;
  } catch {
    return { result: failed(`Context couldn't check this workspace's members just now; ${LATER}.`) };
  }
  if (member === null || !EDITORS.has(member.role)) {
    return { result: stopped("Stopped: the person who started this sync can no longer edit this workspace. An editor can start it again here.") };
  }
  // The object judges the reader from its own member row (`members.js` `judgedReader`): an editor reads as `team`.
  return { reader: { scope: "private", groups: [], audience: "member", userId: armedBy } };
}

/** The note's path now (by its id) and the Data folder, as `reader` sees them. Or `{result}`; `what` names the note. */
export async function noteAndDataFolder(client, reader, noteId, what) {
  try {
    const [resolved, jobs] = await Promise.all([client.rows.resolve({ noteIds: [noteId], ...reader }), client.facts({ ask: "jobs", ...reader })]);
    const row = resolved?.rows?.[0];
    if (resolved?.behind === true || jobs?.behind === true) return { result: failed(`This workspace was mid-change; the sync will try again within the hour.`) };
    if (!row || row.found !== true) return { result: gone(what) };
    if (jobs?.served !== true) return { result: failed(`Context couldn't find this workspace's Data folder just now; ${LATER}.`) };
    return { path: row.path, dataFolder: jobs.jobs?.data ?? null };
  } catch {
    return { result: failed(`Context couldn't reach this workspace just now; ${LATER}.`) };
  }
}

/** One note's Markdown as `reader` reads it. Or `{result}`. */
export async function noteText(client, reader, path, what) {
  try {
    const row = (await client.rows.lookup({ paths: [path], withBody: true, ...reader }))?.rows?.[0];
    if (!row || row.found !== true) return { result: gone(what) };
    const text = row.body?.text ?? null;
    return typeof text === "string" ? { text } : { result: failed(`Context couldn't read ${what} just now; ${LATER}.`) };
  } catch {
    return { result: failed(`Context couldn't read ${what} just now; ${LATER}.`) };
  }
}

/** A sheet's row, which must already be there (the app makes it) and be a keyed file. Or `{result}`. */
export async function sheetRowAt(client, reader, path, remedy) {
  let row;
  try {
    row = (await client.rows.lookup({ paths: [path], ...reader }))?.rows?.[0] ?? null;
  } catch {
    return { result: failed(`Context couldn't reach this workspace just now; ${LATER}.`) };
  }
  if (!row || row.found !== true || row.kind !== "file" || typeof row.key !== "string" || !FILE_KEY.test(row.key)) {
    return { result: failed(`Nothing was written: the sheet ${path} is missing. ${remedy}`) };
  }
  return { row };
}

/** The workspace's bucket, opened from its object for the armer. Or `{result}`. */
export async function openStoreFor(deps, workspaceId, armedBy) {
  try {
    const controlPlane = deps.controlPlane ?? { objectBehind: (id) => createControlPlane(deps.env).objectBehind(id) };
    const opened = await openedFromObject({ workspaceId, actorUserId: armedBy, scope: "team", grantedGroups: [] }, deps.env, controlPlane);
    if (opened.opened === null) return { result: failed(`Context couldn't open this workspace's storage just now; ${LATER}.`) };
    return { store: (deps.openStore ?? storeForOpenedBinding)(opened.opened, workspaceId, deps.env) };
  } catch {
    return { result: failed(`Context couldn't open this workspace's storage just now; ${LATER}.`) };
  }
}

async function bodyText(object) {
  if (object === null || object === undefined) return null;
  if (typeof object.text === "function") return await object.text();
  return new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
}

/** A sheet's stored text, parsed, with the object read (for its version). Or `{result}`. */
export async function readSheet(store, key, path) {
  let current;
  try {
    current = await store.get(key);
  } catch {
    return { result: failed(`Context couldn't read the sheet just now; ${LATER}.`) };
  }
  const text = (await bodyText(current)) ?? "";
  if (isEncryptedNote(text)) return { result: failed(`Nothing was written: ${path} is encrypted.`) };
  const sheet = parseSheet(text);
  if (sheet.tooLarge) return { result: failed(`Nothing was written: ${path} is already past what a sheet can hold.`) };
  if (sheet.errors.some((error) => error.lossy)) return { result: failed(`Nothing was written: ${path} has a header the sync can't rewrite without losing a column; fix it by hand.`) };
  return { current, text, sheet };
}

/**
 * Writes `next` over the version read, or nothing: a person's edit in between wins, and the next run merges over
 * it. Then records the new version and the audit entry (`details`). Answers `null` when written, else `{result}`.
 */
export async function writeOver({ store, client, workspaceId, armedBy, path, key, current, next, now, details }) {
  let written;
  try {
    const etag = current?.etag ?? current?.httpEtag ?? null;
    // No content type: a sheet is kept as every save keeps one, under the store's default.
    written = await store.put(key, next, { onlyIf: typeof etag === "string" && etag !== "" ? { etagMatches: etag } : { absent: true } });
  } catch {
    return { result: failed(`Context couldn't write the sheet just now; ${LATER}.`) };
  }
  if (!written) return { result: failed(`Nothing was written: ${path} changed while the sync ran; ${LATER}.`) };
  const size = new TextEncoder().encode(next).byteLength;
  try {
    await client.write.wrote({ path, key, etag: String(written.etag ?? ""), size, at: now, keyed: true });
  } catch {
    // The sheet has its new rows; its row's version catches up on the next save or the copy check.
  }
  store.actor = { workspaceId, userId: armedBy, clientId: DATA_SYNC_CLIENT_ID, client: "Data sync", name: null, grantId: null };
  try {
    await recordChange(store, DATA_SYNC_ACTION, "team", [path], { etag: String(written.etag ?? ""), ...details });
  } catch {
    // The rows landed; a missing audit entry is said by `recordChange`'s own log, never a failed run.
  }
  return null;
}
