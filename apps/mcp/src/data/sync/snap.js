/**
 * One hourly reading of a "right now" metric, as the sync object takes it (`docs/decisions/data-and-metrics.md`,
 * "Right-now metrics are kept hourly"). A right-now metric reads sheets with no dates (open incidents, seats on a
 * plan), so a past period can't be worked out again later: each hour its value is worked out and kept as one row
 * (`hour`, `value`) in its own sheet beside its note, `<data>/metrics/<slug>.csv`.
 *
 * Every run asks again, and trusts nothing it was told when it was armed:
 *
 * 1. **Whose standing**: the person who armed it is still a live owner or editor (`runParts.js`).
 * 2. **That the metric still is one**: its note, found by id, sits directly in the Data folder's `metrics/` and has a
 *    formula that parses, reads only sheets with no dates, and is worked out as that person reads its sheets.
 * 3. **That nobody reads the value who can't read what it is made from.** The kept sheet's visibility, by the
 *    workspace's own rules, must reach no one an input's does not: the kept sheet `private` (owners), or the input
 *    as visible as the kept sheet is (`team` and `team`, or the very same setting). Anything else (an input held for
 *    a group or named people under a team kept sheet, a sealed folder) keeps nothing and says which sheet, so a
 *    computed value is never written where a wider audience reads it.
 *
 * A run that fails anywhere writes nothing. Answers as `run.js` does.
 */

import { formulaInputs, parseFormula } from "../formula/index.js";
import { evaluateNow, KEPT_HOUR, KEPT_VALUE } from "../formula/evaluate.js";
import { effectiveVisibility, sealedCovers } from "../../privacy/engine.js";
import { parsedRules } from "../../workspaceStore/serve.js";
import { isNotePath, withoutTextExtension } from "../../../../../packages/shared/src/fileKinds.cjs";
import { mergeSynced } from "./keep.js";
import { frontMatterFields, runHour } from "./about.js";
import { armerReader, failed, noteAndDataFolder, noteText, openStoreFor, readSheet, sheetRowAt, stopped, writeOver } from "./runParts.js";

const WHAT = "the metric's note";
const LATER = "it will try again within the hour";
/** The kept sheet's columns, as the app makes it. */
export const KEPT_COLUMNS = Object.freeze([
  { name: KEPT_HOUR, type: "date" },
  { name: KEPT_VALUE, type: "number" },
]);

/** `<data>/metrics/<slug>.md` → its kept sheet `<data>/metrics/<slug>.csv`; null for a note anywhere else. */
export function keptSheetOf(notePath, dataFolder) {
  if (typeof dataFolder !== "string" || dataFolder === "" || typeof notePath !== "string") return null;
  const metrics = `${dataFolder}/metrics/`;
  if (!notePath.toLowerCase().startsWith(metrics.toLowerCase())) return null;
  const name = notePath.slice(metrics.length);
  if (name.includes("/") || !isNotePath(name)) return null;
  const slug = withoutTextExtension(name);
  return slug === "" ? null : `${notePath.slice(0, metrics.length)}${slug}.csv`;
}

/** An input's sheet, as the app reads one: `<data>/<source>/<dataset>.csv`. */
export function inputSheetOf(dataFolder, { source, dataset }) {
  return `${dataFolder}/${source}/${dataset}.csv`;
}

/**
 * Whether every reader `kept`'s visibility lets in is let in by `input`'s too, by one audience's rendered rules:
 * owners only under the kept sheet (`private`, which owners see whatever an input's setting); `team` under `team`;
 * or one setting under the very same one. A sealed path on either side is never compared: nothing is kept.
 */
export function reachesNoWider(parsed, keptPath, inputPath) {
  if (sealedCovers(keptPath, parsed.rules) || sealedCovers(inputPath, parsed.rules)) return false;
  const kept = effectiveVisibility(keptPath, parsed.rules, parsed.overrides);
  const input = effectiveVisibility(inputPath, parsed.rules, parsed.overrides);
  if (kept === "private") return true;
  return kept === input;
}

/** The first input whose readers are fewer than the kept sheet's, by every audience the workspace has rules for; or null. */
async function widerThanInputs(client, keptPath, inputPaths) {
  const audiences = await Promise.all(["member", "guest"].map((audience) => client.rules.get(audience)));
  const member = audiences[0]?.rules ?? null;
  // No member rules held: the object would show nobody anything, so nothing is compared or kept.
  if (member === null) return { unknown: true };
  for (const held of [member, audiences[1]?.rules ?? null]) {
    if (held === null) continue;
    const parsed = parsedRules(held);
    const narrower = inputPaths.find((path) => !reachesNoWider(parsed, keptPath, path));
    if (narrower !== undefined) return { narrower };
  }
  return null;
}

/**
 * Take one reading. `deps` as `runUrlSource`'s: `{env, client, workspaceId, source: {noteId, armedBy}, now?,
 * openStore?, controlPlane?}`, where `source.noteId` is the metric note's.
 */
export async function runMetricSnap(deps) {
  const { client, workspaceId, source } = deps;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();

  const armer = await armerReader(client, source.armedBy);
  if (armer.result) return armer.result;
  const { reader } = armer;

  const found = await noteAndDataFolder(client, reader, source.noteId, WHAT);
  if (found.result) return found.result;
  const { dataFolder } = found;
  const keptPath = keptSheetOf(found.path, dataFolder);
  if (keptPath === null) return stopped("Stopped: its note is no longer in the Data folder's metrics.");
  const note = await noteText(client, reader, found.path, WHAT);
  if (note.result) return note.result;
  const formula = frontMatterFields(note.text).formula ?? "";
  const parsed = parseFormula(formula);
  if (!parsed.ok) return failed(`Nothing was kept: its formula can't be read (${parsed.error.message}).`);
  const inputs = formulaInputs(parsed.ast).map((input) => ({ ...input, path: inputSheetOf(dataFolder, input) }));

  const kept = await sheetRowAt(client, reader, keptPath, "Open the metric and press Keep every hour to make it again.");
  if (kept.result) return kept.result;

  let rows;
  try {
    rows = (await client.rows.lookup({ paths: inputs.map((input) => input.path), ...reader }))?.rows ?? [];
  } catch {
    return failed(`Context couldn't reach this workspace just now; ${LATER}.`);
  }
  const rowOf = new Map(rows.filter((row) => row?.found === true && row.kind === "file" && typeof row.key === "string").map((row) => [row.path, row]));

  let wider;
  try {
    wider = await widerThanInputs(client, keptPath, inputs.map((input) => input.path).filter((path) => rowOf.has(path)));
  } catch {
    return failed(`Context couldn't check who can see this metric just now; ${LATER}.`);
  }
  if (wider?.unknown) return failed(`Context couldn't check who can see this metric just now; ${LATER}.`);
  if (wider?.narrower) {
    return failed(`Nothing was kept: ${wider.narrower} is seen by fewer people than ${keptPath}, so keeping its value there would show it to people who can't see the sheet. Give them the same setting.`);
  }

  const opened = await openStoreFor(deps, workspaceId, source.armedBy);
  if (opened.result) return opened.result;
  const { store } = opened;
  const sheets = new Map();
  for (const input of inputs) {
    const row = rowOf.get(input.path);
    if (row === undefined) continue;
    const read = await readSheet(store, row.key, input.path);
    if (read.result) return read.result;
    sheets.set(`${input.source}\u0000${input.dataset}`, read.sheet);
  }
  const reading = evaluateNow(parsed.ast, { rowsOf: (s, d) => sheets.get(`${s}\u0000${d}`) ?? null, now });
  if (reading.status === "error" && /never kept/.test(reading.note ?? "")) {
    return stopped("Stopped: its formula reads sheets with dates, so it is worked out from them whenever it is read and never kept.");
  }
  if (reading.status === "error") return failed(`Nothing was kept: ${reading.note}.`);

  const read = await readSheet(store, kept.row.key, keptPath);
  if (read.result) return read.result;
  const hour = runHour(now);
  const value = reading.status === "ok" ? String(reading.value) : "";
  const merged = mergeSynced({ path: keptPath, sheet: read.sheet.columns.length > 0 ? read.sheet : null, columns: KEPT_COLUMNS, incoming: [{ [KEPT_HOUR]: hour, [KEPT_VALUE]: value }], key: KEPT_HOUR, dateColumn: KEPT_HOUR, now });
  if (!merged.ok) return failed(`Nothing was written: ${merged.refused}.`);
  if (merged.text === read.text) return { outcome: "ok", rows: merged.rows, added: 0, changed: 0, path: keptPath };
  const wrote = await writeOver({ store, client, workspaceId, armedBy: source.armedBy, path: keptPath, key: kept.row.key, current: read.current, next: merged.text, now, details: { rows: merged.rows, added: merged.added, changed: merged.changed, kept: "metric" } });
  if (wrote !== null) return wrote.result;
  return { outcome: "ok", rows: merged.rows, added: merged.added, changed: merged.changed, path: keptPath };
}
