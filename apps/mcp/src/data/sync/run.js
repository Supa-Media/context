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
import { armerReader, failed, noteAndDataFolder, noteText, openStoreFor, readSheet, sheetRowAt, stopped, writeOver } from "./runParts.js";

export { DATA_SYNC_ACTION, DATA_SYNC_CLIENT_ID } from "./runParts.js";

/** The folder a source's `about.md` sits in, when that is a source folder directly in the Data folder; else null. */
export function sourceFolderOf(aboutPath, dataFolder) {
  if (typeof dataFolder !== "string" || dataFolder === "" || typeof aboutPath !== "string") return null;
  if (!aboutPath.startsWith(`${dataFolder}/`)) return null;
  const rest = aboutPath.slice(dataFolder.length + 1).split("/");
  if (rest.length !== 2 || rest[0] === "" || rest[1].toLowerCase() !== "about.md" || rest[0].toLowerCase() === "metrics") return null;
  return `${dataFolder}/${rest[0]}`;
}

/**
 * Run one source. `deps`: `{env, client, workspaceId, source: {noteId, armedBy}, now?, fetcher?, resolve?,
 * openStore?, controlPlane?}`. `client` is the workspace's object client (`workspaceClient`); `openStore` builds the
 * bucket store from an opened binding (`storeForOpenedBinding` by default).
 */
export async function runUrlSource(deps) {
  const { client, workspaceId, source } = deps;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();

  // 1. Whose standing: a live member who may edit, by the object's own members.
  const armer = await armerReader(client, source.armedBy);
  if (armer.result) return armer.result;
  const { reader } = armer;

  // 2. That the source still is one: its about.md by note id, in a source folder of the Data folder, saying url.
  const found = await noteAndDataFolder(client, reader, source.noteId, "its about.md");
  if (found.result) return found.result;
  const folder = sourceFolderOf(found.path, found.dataFolder);
  if (folder === null) return stopped("Stopped: its about.md is no longer in a source folder of the Data folder.");
  const about = await noteText(client, reader, found.path, "its about.md");
  if (about.result) return about.result;
  const settings = urlSourceOf(about.text);
  if (!settings.ok) return settings.kind === "not_url" ? stopped(`Stopped: ${settings.said}.`) : failed(`Nothing was written: ${settings.said}.`);
  const sheetPath = datasetPathOf(folder, settings.dataset);
  const sheetRow = await sheetRowAt(client, reader, sheetPath, "Press Sync now on the source's page to make it again.");
  if (sheetRow.result) return sheetRow.result;

  // 3. The address, held to the lock on this run.
  const fetched = await fetchDataset(settings.url, {
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    resolve: deps.resolve ?? dohResolver(deps.fetcher ?? fetch),
  });
  if (!fetched.ok) return failed(`Nothing was written: ${fetched.refused}.`);

  // The bucket, opened from the workspace object for that same person, judged a live member there again.
  const opened = await openStoreFor(deps, workspaceId, source.armedBy);
  if (opened.result) return opened.result;
  const { store } = opened;
  const read = await readSheet(store, sheetRow.row.key, sheetPath);
  if (read.result) return read.result;
  const { current, text: currentText, sheet } = read;

  const shaped = shapeFetched({ fetched: fetched.sheet, settings, sheet: sheet.columns.length > 0 ? sheet : null, now });
  if (!shaped.ok) return failed(`Nothing was written: ${shaped.refused}.`);
  const merged = mergeSynced({ path: sheetPath, sheet: shaped.sheet, columns: shaped.columns, incoming: shaped.incoming, key: shaped.key, dateColumn: shaped.dateColumn, now });
  if (!merged.ok) return failed(`Nothing was written: ${merged.refused}.`);
  if (merged.text === currentText) return { outcome: "ok", rows: merged.rows, added: 0, changed: 0, path: sheetPath };

  const wrote = await writeOver({
    store,
    client,
    workspaceId,
    armedBy: source.armedBy,
    path: sheetPath,
    key: sheetRow.row.key,
    current,
    next: merged.text,
    now,
    details: { rows: merged.rows, added: merged.added, changed: merged.changed, from: new URL(settings.url).hostname },
  });
  if (wrote !== null) return wrote.result;
  return { outcome: "ok", rows: merged.rows, added: merged.added, changed: merged.changed, path: sheetPath };
}
