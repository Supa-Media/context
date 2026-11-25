/**
 * One hourly run of the Context usage source (`docs/decisions/data-and-metrics.md`, "The Context usage source"):
 * Context-wide activity, by person ids nobody can turn back into an account, written into the one workspace this
 * deployment's config names (`USAGE_WORKSPACE`, a slug; decided by the owner, 2026-11-25: "Only @supa, named in
 * gateway config"), in five sheets only its owners can open: four of activity, and one row per bug report people
 * sent, from the app or by texting Tex (decided by the owner, 2026-11-25: "user reported bugs going into a sheet").
 *
 * Every run asks again:
 * 1. **That this deployment still names a usage workspace.** Unset, the source stops. (Which workspace was checked
 *    when it was armed, by its slug; the sync object is pinned to that workspace's id from then on.)
 * 2. **That the person who armed it is still an owner**, by the workspace object's own members.
 * 3. **That the source still is one**: its `about.md` by note id, in a source folder of the Data folder, saying
 *    `source: usage`.
 * 4. **That its five sheets are owners only**, by both of the workspace's renderings (member and guest): each must
 *    be `private`, and none sealed. A sheet anyone else could open stops the source before anything is read, so
 *    loosening a sheet or its folder never publishes a row.
 *
 * Then it reads what happened since its last rows (`controlPlane.usageExport`), puts every account id through the
 * person MAC (`usage/person.js`), and merges each sheet by its key, as every sync does. No name, address, path or
 * word reaches a sheet: the export never carried one.
 */

import { effectiveVisibility, sealedCovers } from "../../privacy/engine.js";
import { parsedRules } from "../../workspaceStore/serve.js";
import { createControlPlane } from "../../controlPlane.js";
import { usagePersonId, usagePersonKeyOf } from "../../usage/person.js";
import { frontMatterFields } from "./about.js";
import { mergeSynced } from "./keep.js";
import { sourceFolderOf } from "./run.js";
import { ownerReader } from "./runApp.js";
import { failed, noteAndDataFolder, noteText, openStoreFor, readSheet, sheetRowAt, stopped, writeOver } from "./runParts.js";

const LATER = "it will try again within the hour";
const DAY_MS = 86_400_000;
/** A run reads back this far once its sheets have rows, and this far the first time (the export keeps 30 days of texts). */
const SINCE_MS = 2 * DAY_MS;
const FIRST_SINCE_MS = 30 * DAY_MS;
/** What "returning" looks back over: active today and on another day in the 7 before. */
const RETURNING_DAYS = 7;

/** The five sheets: their file, key, date column, columns and how long each keeps its rows. */
export const USAGE_SHEETS = Object.freeze({
  activity: {
    file: "activity.csv",
    key: "id",
    date: "day",
    keepDays: 90,
    columns: [
      { name: "id", type: "text" },
      { name: "day", type: "date" },
      { name: "person", type: "text" },
      { name: "texted", type: "number" },
      { name: "wrote", type: "number" },
      { name: "called", type: "number" },
      { name: "active", type: "number" },
      { name: "returning", type: "number" },
    ],
  },
  signups: {
    file: "sign-ups.csv",
    key: "person",
    date: "day",
    keepDays: 400,
    columns: [
      { name: "person", type: "text" },
      { name: "day", type: "date" },
      { name: "channel", type: "text" },
      { name: "day1_active", type: "number" },
    ],
  },
  replies: {
    file: "tex-replies.csv",
    key: "id",
    date: "at",
    keepDays: 30,
    columns: [
      { name: "id", type: "text" },
      { name: "at", type: "date" },
      { name: "kind", type: "text" },
      { name: "seconds", type: "number" },
      { name: "answered", type: "number" },
    ],
  },
  calls: {
    file: "calls.csv",
    key: "id",
    date: "at",
    keepDays: 14,
    columns: [
      { name: "id", type: "text" },
      { name: "at", type: "date" },
      { name: "tool", type: "text" },
      { name: "ms", type: "number" },
      { name: "ok", type: "number" },
      { name: "client", type: "text" },
      { name: "weight", type: "number" },
    ],
  },
  bugs: {
    file: "bug-reports.csv",
    key: "reference",
    date: "filed",
    keepDays: 400,
    // The team's own column: a new row says open, and a run never writes over what they set.
    hand: ["status"],
    columns: [
      { name: "reference", type: "text" },
      { name: "filed", type: "date" },
      { name: "person", type: "text" },
      { name: "channel", type: "text" },
      { name: "status", type: "text" },
    ],
  },
});

/** The ways a bug report comes in, as the control plane's receipts say them. */
const BUG_CHANNELS = new Set(["app", "tex", "tex-group", "agent"]);
/** A report's reference: the 32-hex event id the person was told. */
const REFERENCE = /^[0-9a-f]{32}$/;

/** This deployment's usage workspace slug, lower-case without `@`, or null when it names none. */
export function usageWorkspaceOf(env) {
  const raw = typeof env?.USAGE_WORKSPACE === "string" ? env.USAGE_WORKSPACE.trim().replace(/^@/, "").toLowerCase() : "";
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : null;
}

/** Whether the about.md says this is the usage source. */
export function isUsageAbout(text) {
  return String(frontMatterFields(text).source ?? "").trim().toLowerCase() === "usage";
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const instant = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const flag = (value) => (value === true || value === "1" || value === 1 ? "1" : "0");

/** Whether every path is owners only by both renderings: `private`, and under no sealed folder. Or `{unknown}`. */
export async function ownersOnly(client, paths) {
  const audiences = await Promise.all(["member", "guest"].map((audience) => client.rules.get(audience)));
  const held = audiences.map((answer) => answer?.rules ?? null);
  if (held.some((rules) => rules === null)) return { unknown: true };
  for (const rules of held) {
    const parsed = parsedRules(rules);
    const open = paths.find((path) => sealedCovers(path, parsed.rules) || effectiveVisibility(path, parsed.rules, parsed.overrides) !== "private");
    if (open !== undefined) return { open };
  }
  return { ok: true };
}

/**
 * The export, MAC'd and shaped into each sheet's rows, merged with what `held` (each sheet's parsed rows by key)
 * already says: a flag once set stays set, and a sign-up's day-1 mark is never taken back when its days age out.
 * Pure but for the MAC.
 */
export async function usageRows(exported, { key, held, now }) {
  const macs = new Map();
  const mac = async (userId) => {
    if (!macs.has(userId)) macs.set(userId, await usagePersonId(key, userId));
    return macs.get(userId);
  };

  // Activity: one row per person-day, flags OR'ed over what the sheet holds and what the export says.
  const days = new Map();
  for (const row of held.activity.values()) {
    if (typeof row.person !== "string" || row.person === "" || typeof row.day !== "string") continue;
    days.set(`${row.day}:${row.person}`, { id: `${row.day}:${row.person}`, day: row.day, person: row.person, texted: flag(row.texted), wrote: flag(row.wrote), called: flag(row.called) });
  }
  const touch = (day, person) => {
    const id = `${day}:${person}`;
    if (!days.has(id)) days.set(id, { id, day, person, texted: "0", wrote: "0", called: "0" });
    return days.get(id);
  };
  for (const row of exported.activity ?? []) {
    if (typeof row?.person !== "string" || !/^[0-9a-f]{16}$/.test(row.person) || typeof row.day !== "string") continue;
    const entry = touch(row.day, row.person);
    if (row.wrote === true) entry.wrote = "1";
    if (row.called === true) entry.called = "1";
  }
  const replies = [];
  for (const text of exported.texts ?? []) {
    const person = await mac(text?.userId);
    if (person === null || !Number.isFinite(text.at)) continue;
    touch(dayOf(text.at), person).texted = "1";
    // An answered text is in the replies' timings already; one that wasn't answered is only here.
    if (text.outcome !== "answered") replies.push({ id: `unanswered:${text.at}:${person}`, at: instant(text.at), kind: "one", seconds: "", answered: "0" });
  }
  const byPerson = new Map();
  for (const entry of days.values()) {
    entry.active = entry.texted === "1" || entry.wrote === "1" ? "1" : "0";
    const list = byPerson.get(entry.person) ?? [];
    list.push(Date.parse(`${entry.day}T00:00:00Z`));
    byPerson.set(entry.person, list);
  }
  for (const entry of days.values()) {
    const at = Date.parse(`${entry.day}T00:00:00Z`);
    entry.returning = byPerson.get(entry.person).some((other) => other < at && other >= at - RETURNING_DAYS * DAY_MS) ? "1" : "0";
  }

  // Sign-ups: one row per person, active on their sign-up day or the day after.
  const signups = [];
  for (const made of exported.signups ?? []) {
    const person = await mac(made?.userId);
    if (person === null || !Number.isFinite(made.at)) continue;
    const day = dayOf(made.at);
    const next = dayOf(made.at + DAY_MS);
    const activeThen = [day, next].some((d) => days.has(`${d}:${person}`));
    const old = held.signups.get(person);
    signups.push({ person, day, channel: typeof old?.channel === "string" ? old.channel : "", day1_active: activeThen || flag(old?.day1_active) === "1" ? "1" : "0" });
  }

  for (const reply of exported.replies ?? []) {
    if (!Number.isFinite(reply?.at) || !Number.isFinite(reply.seconds) || (reply.kind !== "one" && reply.kind !== "group")) continue;
    replies.push({ id: `${reply.at}:${reply.kind}:${reply.seconds}`, at: instant(reply.at), kind: reply.kind, seconds: String(reply.seconds), answered: "1" });
  }

  const calls = [];
  for (const call of exported.calls ?? []) {
    if (!Number.isFinite(call?.at) || typeof call.tool !== "string" || !Number.isFinite(call.ms)) continue;
    calls.push({ id: `${call.at}:${call.tool}:${call.ms}`, at: instant(call.at), tool: call.tool, ms: String(call.ms), ok: call.ok === true ? "1" : "0", client: typeof call.client === "string" ? call.client : "", weight: String(Number.isFinite(call.weight) ? call.weight : 1) });
  }

  // Bug reports: one row per report, by the reference the person was told, so the report itself is found by it
  // (a Tex bug note's `reference:`, the app's Sentry event). Never a word of the report.
  const bugs = [];
  for (const bug of exported.bugs ?? []) {
    if (!Number.isFinite(bug?.at) || typeof bug.reference !== "string" || !REFERENCE.test(bug.reference) || !BUG_CHANNELS.has(bug.channel)) continue;
    const person = await mac(bug.userId);
    if (person === null) continue;
    bugs.push({ reference: bug.reference, filed: instant(bug.at), person, channel: bug.channel, status: "open" });
  }

  return { activity: [...days.values()], signups, replies, calls, bugs };
}

/**
 * Run the source. `deps` as `runUrlSource`'s: `{env, client, workspaceId, source: {noteId, armedBy}, now?,
 * openStore?, controlPlane?, usageExport?, personKey?}`; the control plane's `usageExport(since)` is the read, and
 * `usageExport` and `personKey` stand in for it and the MAC key in the suite.
 */
export async function runUsageSource(deps) {
  const { client, workspaceId, source, env } = deps;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();

  // 1. This deployment still names a usage workspace.
  if (usageWorkspaceOf(env) === null) return stopped("Stopped: this deployment no longer names a workspace for Context usage.");

  // 2. Whose standing: a live owner.
  const owner = await ownerReader(client, source.armedBy);
  if (owner.result) return owner.result;
  const { reader } = owner;

  // 3. That the source still is one.
  const found = await noteAndDataFolder(client, reader, source.noteId, "its about.md");
  if (found.result) return found.result;
  const folder = sourceFolderOf(found.path, found.dataFolder);
  if (folder === null) return stopped("Stopped: its about.md is no longer in a source folder of the Data folder.");
  const about = await noteText(client, reader, found.path, "its about.md");
  if (about.result) return about.result;
  if (!isUsageAbout(about.text)) return stopped("Stopped: its about.md no longer says source: usage.");

  const names = Object.keys(USAGE_SHEETS);
  const pathOf = Object.fromEntries(names.map((name) => [name, `${folder}/${USAGE_SHEETS[name].file}`]));
  const rowOf = {};
  for (const name of names) {
    const row = await sheetRowAt(client, reader, pathOf[name], `Make it with the columns ${USAGE_SHEETS[name].columns.map((c) => c.name).join(", ")}, owners only.`);
    if (row.result) return row.result;
    rowOf[name] = row.row;
  }

  // 4. Owners only, every sheet, every run.
  let only;
  try {
    only = await ownersOnly(client, names.map((name) => pathOf[name]));
  } catch {
    return failed(`Context couldn't check who can see these sheets just now; ${LATER}.`);
  }
  if (only.unknown) return failed(`Context couldn't check who can see these sheets just now; ${LATER}.`);
  if (only.open) return stopped(`Stopped: ${only.open} can be opened by more than this workspace's owners. Make ${folder} owners only, then press Sync now.`);

  const key = deps.personKey !== undefined ? deps.personKey : await usagePersonKeyOf(env);
  if (!key) return failed("Nothing was written: this deployment has no key for person ids.");

  const opened = await openStoreFor(deps, workspaceId, source.armedBy);
  if (opened.result) return opened.result;
  const { store } = opened;
  const read = {};
  for (const name of names) {
    const sheet = await readSheet(store, rowOf[name].key, pathOf[name]);
    if (sheet.result) return sheet.result;
    read[name] = sheet;
  }
  const keyed = (name) => new Map(read[name].sheet.rows.map((row) => [String(row?.[USAGE_SHEETS[name].key] ?? ""), row]).filter(([id]) => id !== ""));
  const first = read.activity.sheet.rows.length === 0;
  const firstBugs = read.bugs.sheet.rows.length === 0;

  let exported;
  try {
    const since = now - (first ? FIRST_SINCE_MS : SINCE_MS);
    const bugsSince = now - (firstBugs ? FIRST_SINCE_MS : SINCE_MS);
    exported = typeof deps.usageExport === "function" ? await deps.usageExport(since, bugsSince) : await createControlPlane(env).usageExport(since, bugsSince);
  } catch {
    return failed(`Context couldn't read usage just now; ${LATER}.`);
  }
  if (!exported || typeof exported !== "object") return failed(`Context couldn't read usage just now; ${LATER}.`);

  const rows = await usageRows(exported, { key, held: { activity: keyed("activity"), signups: keyed("signups") }, now });
  let total = 0;
  for (const name of names) {
    const spec = USAGE_SHEETS[name];
    const { sheet, text, current } = read[name];
    const merged = mergeSynced({ path: pathOf[name], sheet: sheet.columns.length > 0 ? sheet : null, columns: spec.columns, incoming: rows[name], key: spec.key, dateColumn: spec.date, now, keepDays: spec.keepDays, handColumns: spec.hand ?? [] });
    if (!merged.ok) return failed(`Nothing more was written: ${merged.refused}.`);
    total += merged.rows;
    if (merged.text === text) continue;
    const wrote = await writeOver({ store, client, workspaceId, armedBy: source.armedBy, path: pathOf[name], key: rowOf[name].key, current, next: merged.text, now, details: { rows: merged.rows, added: merged.added, changed: merged.changed, from: "context usage" } });
    if (wrote !== null) return wrote.result;
  }
  if (exported.cut === true) return failed("Some rows were written, but there were more than one read holds; the next run reads the rest.");
  if (typeof exported.timingsError === "string" && exported.timingsError !== "") return { outcome: "ok", rows: total, path: folder, said: `Calls and Tex replies weren't read: ${exported.timingsError}.` };
  return { outcome: "ok", rows: total, path: folder };
}
