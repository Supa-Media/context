/**
 * One run of one connected app's source (Stripe, Cloudflare, GitHub), as the sync object runs it every hour
 * (`docs/decisions/data-and-metrics.md`, "Apps connect with read-only keys").
 *
 * The same checks as a url source (`run.js`), asked again on every run, with two of its own:
 *
 * 1. **Whose standing:** the owner who connected it must still be an owner of the workspace. Owners connect apps,
 *    so an owner who became an editor, or left, stops the source.
 * 2. **That the source still is one:** its `about.md`, found by its note id, readable by that owner, in a source
 *    folder of the Data folder, still saying `source:` the app it was connected as. An about.md edited to name
 *    another app stops it: the key it was connected with is the only one it may use.
 * 3. **The key:** opened only here, from the sealed copy the object keeps for this workspace and this app
 *    (`connect/seal.js`). A key the app refuses stops the source until an owner connects again.
 *
 * It writes only the app's dataset sheets (one, or GitHub's three) inside the source's own folder, over the version it read, and never
 * says what the app answered beyond a count.
 */

import { APPS } from "../connect/apps.js";
import { ConnectionSealRefused, openConnection } from "../connect/seal.js";
import { dateMs } from "../../sheets/csv.js";
import { frontMatterFields, datasetPathOf } from "./about.js";
import { KEEP_DAYS, mergeSynced } from "./keep.js";
import { sourceFolderOf } from "./run.js";
import { failed, gone, noteAndDataFolder, noteText, openStoreFor, readSheet, sheetRowAt, stopped, writeOver } from "./runParts.js";

const LATER = "it will try again within the hour";

/** The owner who connected it, still an owner, by the object's own member row. Or `{result}`. */
export async function ownerReader(client, userId) {
  let member;
  try {
    member = (await client.members.get(userId))?.member ?? null;
  } catch {
    return { result: failed(`Context couldn't check this workspace's members just now; ${LATER}.`) };
  }
  if (member === null || member.role !== "owner") {
    return { result: stopped("Stopped: the owner who connected this is no longer an owner of this workspace. An owner can connect it again here.") };
  }
  return { reader: { scope: "private", groups: [], audience: "member", userId } };
}

/** The newest and oldest dates in a sheet's date column, in ms; NaN for an empty sheet. */
function spanOf(sheet, column) {
  let newestMs = Number.NaN;
  let oldestMs = Number.NaN;
  for (const row of sheet?.rows ?? []) {
    const at = dateMs(row?.[column]);
    if (!Number.isFinite(at)) continue;
    if (!(at <= newestMs)) newestMs = at;
    if (!(at >= oldestMs)) oldestMs = at;
  }
  return { newestMs, oldestMs };
}

/**
 * Run one app source. `deps`: `{env, client, workspaceId, source: {noteId, armedBy, app}, sealed, now?, fetcher?,
 * openStore?, controlPlane?}`, where `sealed` is the key the object keeps for this app, or null.
 */
export async function runAppSource(deps) {
  const { client, workspaceId, source } = deps;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const app = Object.hasOwn(APPS, source.app) ? APPS[source.app] : null;
  if (app === null) return stopped("Stopped: this source names an app Context doesn't connect.");

  // 1. Whose standing: an owner, still.
  const owner = await ownerReader(client, source.armedBy);
  if (owner.result) return owner.result;
  const { reader } = owner;

  // 2. That the source still is one, for this app.
  const found = await noteAndDataFolder(client, reader, source.noteId, "its about.md");
  if (found.result) return found.result;
  const folder = sourceFolderOf(found.path, found.dataFolder);
  if (folder === null) return stopped("Stopped: its about.md is no longer in a source folder of the Data folder.");
  const about = await noteText(client, reader, found.path, "its about.md");
  if (about.result) return about.result;
  const said = String(frontMatterFields(about.text).source ?? "").trim().toLowerCase();
  if (said !== app.app) return stopped(`Stopped: its about.md no longer says source: ${app.app}.`);
  // Every dataset the app keeps (GitHub keeps three) must already be a sheet in the source's folder.
  const sets = app.sets ?? [{ dataset: app.dataset, key: app.key, date: app.date, columns: app.columns }];
  const places = [];
  for (const set of sets) {
    const sheetPath = datasetPathOf(folder, set.dataset);
    const sheetRow = await sheetRowAt(client, reader, sheetPath, "An owner can connect it again to make it.");
    if (sheetRow.result) return sheetRow.result;
    places.push({ set, sheetPath, row: sheetRow.row });
  }

  // 3. The key, opened here only.
  if (typeof deps.sealed !== "string") return stopped(`Stopped: ${app.name} isn't connected. An owner can connect it again here.`);
  let kept;
  try {
    kept = await openConnection(deps.sealed, { secret: deps.env?.GATEWAY_SECRET, workspaceId, app: app.app });
  } catch (error) {
    if (error instanceof ConnectionSealRefused) return stopped(`Stopped: the ${app.name} key can't be opened any more. An owner can connect it again here.`);
    throw error;
  }

  const opened = await openStoreFor(deps, workspaceId, source.armedBy);
  if (opened.result) return opened.result;
  const { store } = opened;
  const spans = {};
  const sheets = {};
  for (const place of places) {
    const read = await readSheet(store, place.row.key, place.sheetPath);
    if (read.result) return read.result;
    Object.assign(place, read, { hasColumns: read.sheet.columns.length > 0 });
    spans[place.set.dataset] = place.hasColumns ? spanOf(read.sheet, place.set.date) : { newestMs: Number.NaN, oldestMs: Number.NaN };
    sheets[place.set.dataset] = place.hasColumns ? read.sheet.rows : [];
  }

  const single = app.sets === undefined;
  const got = await app.read({ kept, ...(single ? spans[app.dataset] : { spans, sheets }), now, keepDays: KEEP_DAYS, fetcher: deps.fetcher ?? fetch, env: deps.env });
  if (!got.ok) return got.refused ? stopped(`Stopped: ${got.said}. An owner can connect it again here.`) : failed(`Nothing was written: ${got.said}; ${LATER}.`);
  const incoming = single ? { [app.dataset]: { rows: got.rows, more: got.more } } : got.sets;

  // Each sheet merged first, so a refusal writes none of them.
  for (const place of places) {
    const { set, sheetPath, sheet, hasColumns } = place;
    place.merged = mergeSynced({ path: sheetPath, sheet: hasColumns ? sheet : null, columns: [...set.columns], incoming: incoming[set.dataset]?.rows ?? [], key: set.key, dateColumn: set.date, now, ...(set.keepDays ? { keepDays: set.keepDays } : {}) });
    if (!place.merged.ok) return failed(`Nothing was written: ${place.merged.refused}.`);
  }
  let rows = 0;
  let added = 0;
  let changed = 0;
  for (const { sheetPath, row, current, text: currentText, merged } of places) {
    rows += merged.rows;
    if (merged.text === currentText) continue;
    added += merged.added;
    changed += merged.changed;
    const wrote = await writeOver({
      store,
      client,
      workspaceId,
      armedBy: source.armedBy,
      path: sheetPath,
      key: row.key,
      current,
      next: merged.text,
      now,
      details: { rows: merged.rows, added: merged.added, changed: merged.changed, from: app.app },
    });
    if (wrote !== null) return wrote.result;
  }
  const more = Object.values(incoming).some((one) => one?.more === true);
  return {
    outcome: "ok",
    rows,
    added,
    changed,
    path: places[0].sheetPath,
    ...(more ? { said: "Still reading older history; the next runs carry it back further." } : {}),
  };
}
