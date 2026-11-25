/**
 * One run of one "Fetch from a URL" source, as the sync object runs it every hour
 * (`docs/decisions/data-and-metrics.md`, "The sync object").
 *
 * Every run asks again, at run time, everything it was told when the source was armed, and trusts none of it:
 *
 * 1. **Whose standing it runs on.** The person who armed it must still be a live member of the workspace who may
 *    edit (owner or editor), by the workspace object's own members. Otherwise the source stops.
 * 2. **That the source still is one.** Its `about.md` is found by its note id, so a renamed or moved source folder
 *    is followed; it must still be readable by that person, sit in a source folder directly under the folder doing
 *    the Data job (found by its job, never its name), and still say `source: url`. Otherwise the source stops.
 * 3. **The address.** `fetchDataset` holds it to the fetch lock on every run, so an address edited to a private one
 *    after arming is refused then (`data/fetch/url.js`).
 *
 * A run that fails anywhere writes nothing to the sheet. A run that writes, writes only the dataset sheet inside the
 * source's own folder, over the version it read (a conditional put), records the sheet's new version in the
 * workspace object as any save does, and leaves an audit entry naming the data sync and the person it ran for.
 *
 * Answers `{outcome: "ok", rows, added, changed, path}`, `{outcome: "failed", said}` (tried again next hour) or
 * `{outcome: "stopped", said}` (never run again until an editor arms it). `said` is a plain sentence for the
 * source's page; it never repeats what the address answered.
 */

import { fetchDataset, dohResolver } from "../fetch/url.js";
import { mergeSynced } from "./keep.js";
import { datasetPathOf, shapeFetched, urlSourceOf } from "./about.js";
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

const stopped = (said) => ({ outcome: "stopped", said });
const failed = (said) => ({ outcome: "failed", said });
/** Its about.md is gone, or out of its person's reach: the object forgets the source, since no page can ask about it. */
const gone = () => ({ outcome: "stopped", said: "Stopped: its about.md is gone.", gone: true });

/** The folder a source's `about.md` sits in, when that is a source folder directly in the Data folder; else null. */
export function sourceFolderOf(aboutPath, dataFolder) {
  if (typeof dataFolder !== "string" || dataFolder === "" || typeof aboutPath !== "string") return null;
  if (!aboutPath.startsWith(`${dataFolder}/`)) return null;
  const rest = aboutPath.slice(dataFolder.length + 1).split("/");
  if (rest.length !== 2 || rest[0] === "" || rest[1].toLowerCase() !== "about.md" || rest[0].toLowerCase() === "metrics") return null;
  return `${dataFolder}/${rest[0]}`;
}

async function bodyText(object) {
  if (object === null || object === undefined) return null;
  if (typeof object.text === "function") return await object.text();
  return new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
}

/**
 * Run one source. `deps`: `{env, client, workspaceId, source: {noteId, armedBy}, now?, fetcher?, resolve?,
 * openStore?, controlPlane?}`. `client` is the workspace's object client (`workspaceClient`); `openStore` builds the
 * bucket store from an opened binding (`storeForOpenedBinding` by default).
 */
export async function runUrlSource(deps) {
  const { env, client, workspaceId, source } = deps;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();

  // 1. Whose standing: a live member who may edit, by the object's own members.
  let member;
  try {
    member = (await client.members.get(source.armedBy))?.member ?? null;
  } catch {
    return failed("Context couldn't check this workspace's members just now; it will try again within the hour.");
  }
  if (member === null || !EDITORS.has(member.role)) {
    return stopped("Stopped: the person who started this sync can no longer edit this workspace. An editor can start it again here.");
  }
  // The object judges the reader from its own member row (`members.js` `judgedReader`): an editor reads as `team`.
  const reader = { scope: "private", groups: [], audience: "member", userId: source.armedBy };

  // 2. That the source still is one: its about.md by note id, in a source folder of the Data folder, saying url.
  let aboutPath;
  let dataFolder;
  try {
    const [resolved, jobs] = await Promise.all([client.rows.resolve({ noteIds: [source.noteId], ...reader }), client.facts({ ask: "jobs", ...reader })]);
    const row = resolved?.rows?.[0];
    if (resolved?.behind === true || jobs?.behind === true) return failed("This workspace was mid-change; the sync will try again within the hour.");
    if (!row || row.found !== true) return gone();
    aboutPath = row.path;
    if (jobs?.served !== true) return failed("Context couldn't find this workspace's Data folder just now; it will try again within the hour.");
    dataFolder = jobs.jobs?.data ?? null;
  } catch {
    return failed("Context couldn't reach this workspace just now; it will try again within the hour.");
  }
  const folder = sourceFolderOf(aboutPath, dataFolder);
  if (folder === null) return stopped("Stopped: its about.md is no longer in a source folder of the Data folder.");
  let aboutText;
  try {
    const looked = await client.rows.lookup({ paths: [aboutPath], withBody: true, ...reader });
    const row = looked?.rows?.[0];
    if (!row || row.found !== true) return gone();
    aboutText = row.body?.text ?? null;
  } catch {
    return failed("Context couldn't read its about.md just now; it will try again within the hour.");
  }
  if (typeof aboutText !== "string") return failed("Context couldn't read its about.md just now; it will try again within the hour.");
  const settings = urlSourceOf(aboutText);
  if (!settings.ok) return settings.kind === "not_url" ? stopped(`Stopped: ${settings.said}.`) : failed(`Nothing was written: ${settings.said}.`);
  const sheetPath = datasetPathOf(folder, settings.dataset);

  // The sheet's row: it must already be there (the app makes it when the source is made) and be a keyed file.
  let sheetRow;
  try {
    sheetRow = (await client.rows.lookup({ paths: [sheetPath], ...reader }))?.rows?.[0] ?? null;
  } catch {
    return failed("Context couldn't reach this workspace just now; it will try again within the hour.");
  }
  if (!sheetRow || sheetRow.found !== true || sheetRow.kind !== "file" || typeof sheetRow.key !== "string" || !FILE_KEY.test(sheetRow.key)) {
    return failed(`Nothing was written: the sheet ${sheetPath} is missing. Press Sync now on the source's page to make it again.`);
  }

  // 3. The address, held to the lock on this run.
  const fetched = await fetchDataset(settings.url, {
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    resolve: deps.resolve ?? dohResolver(deps.fetcher ?? fetch),
  });
  if (!fetched.ok) return failed(`Nothing was written: ${fetched.refused}.`);

  // The bucket, opened from the workspace object for that same person, judged a live member there again.
  let store;
  try {
    const controlPlane = deps.controlPlane ?? { objectBehind: (id) => createControlPlane(env).objectBehind(id) };
    const opened = await openedFromObject({ workspaceId, actorUserId: source.armedBy, scope: "team", grantedGroups: [] }, env, controlPlane);
    if (opened.opened === null) return failed("Context couldn't open this workspace's storage just now; it will try again within the hour.");
    store = (deps.openStore ?? storeForOpenedBinding)(opened.opened, workspaceId, env);
  } catch {
    return failed("Context couldn't open this workspace's storage just now; it will try again within the hour.");
  }

  let current;
  try {
    current = await store.get(sheetRow.key);
  } catch {
    return failed("Context couldn't read the sheet just now; it will try again within the hour.");
  }
  const currentText = (await bodyText(current)) ?? "";
  if (isEncryptedNote(currentText)) return failed(`Nothing was written: ${sheetPath} is encrypted.`);
  const sheet = parseSheet(currentText);
  if (sheet.tooLarge) return failed(`Nothing was written: ${sheetPath} is already past what a sheet can hold.`);
  if (sheet.errors.some((error) => error.lossy)) return failed(`Nothing was written: ${sheetPath} has a header the sync can't rewrite without losing a column; fix it by hand.`);

  const shaped = shapeFetched({ fetched: fetched.sheet, settings, sheet: sheet.columns.length > 0 ? sheet : null, now });
  if (!shaped.ok) return failed(`Nothing was written: ${shaped.refused}.`);
  const merged = mergeSynced({ path: sheetPath, sheet: shaped.sheet, columns: shaped.columns, incoming: shaped.incoming, key: shaped.key, dateColumn: shaped.dateColumn, now });
  if (!merged.ok) return failed(`Nothing was written: ${merged.refused}.`);
  if (merged.text === currentText) return { outcome: "ok", rows: merged.rows, added: 0, changed: 0, path: sheetPath };

  // Over the version read, or nothing: a person's edit in between wins, and the next run merges over it.
  let written;
  try {
    const etag = current?.etag ?? current?.httpEtag ?? null;
    // No content type: a sheet is kept as every save keeps one, under the store's default.
    written = await store.put(sheetRow.key, merged.text, {
      onlyIf: typeof etag === "string" && etag !== "" ? { etagMatches: etag } : { absent: true },
    });
  } catch {
    return failed("Context couldn't write the sheet just now; it will try again within the hour.");
  }
  if (!written) return failed(`Nothing was written: ${sheetPath} changed while the sync ran; it will try again within the hour.`);
  const size = new TextEncoder().encode(merged.text).byteLength;
  try {
    await client.write.wrote({ path: sheetPath, key: sheetRow.key, etag: String(written.etag ?? ""), size, at: now, keyed: true });
  } catch {
    // The sheet has its new rows; its row's version catches up on the next save or the copy check.
  }
  store.actor = { workspaceId, userId: source.armedBy, clientId: DATA_SYNC_CLIENT_ID, client: "Data sync", name: null, grantId: null };
  try {
    await recordChange(store, DATA_SYNC_ACTION, "team", [sheetPath], { etag: String(written.etag ?? ""), rows: merged.rows, added: merged.added, changed: merged.changed, from: new URL(settings.url).hostname });
  } catch {
    // The rows landed; a missing audit entry is said by `recordChange`'s own log, never a failed run.
  }
  return { outcome: "ok", rows: merged.rows, added: merged.added, changed: merged.changed, path: sheetPath };
}
