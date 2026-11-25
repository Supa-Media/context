/**
 * What the Data page and a source's folder page say about a source and its
 * sheets, in the board's words (the data sources boards, 01, 07, 09 and 10).
 * Pure.
 */

import { dateMs } from "../../../../../mcp/src/sheets/csv.js";
import type { DataSource, SourceKind } from "./sources";
import { signsIn, textOf } from "./sources";
import type { Sheet } from "./workOut";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 20", in UTC as every date in a sheet is. */
export function monthDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "just now", "12 min ago", "1h ago", "3d ago", then the date. */
export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return monthDay(ms);
}

/** "1,284 rows", "1 row". */
export function rowsWords(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;
}

/** "1 dataset", "3 datasets". */
export function datasetsWords(count: number): string {
  return `${count} ${count === 1 ? "dataset" : "datasets"}`;
}

/** The sheet's columns as the folder page lists them: `repo, number, title`. */
export function columnsWords(sheet: Sheet | null): string {
  return sheet === null ? "" : sheet.columns.map((c) => c.name).join(", ");
}

/** When the latest row is from, by the sheet's first date column; null for a sheet with none. */
export function lastRowAt(sheet: Sheet | null): number | null {
  if (sheet === null) return null;
  const column = sheet.columns.find((c) => c.type === "date");
  if (column === undefined) return null;
  let latest: number | null = null;
  for (const row of sheet.rows) {
    const ms = dateMs(row[column.name] ?? "") as number;
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** "Last row 10:00" today, else "Last row Nov 23"; "" for no row with a date. */
export function lastRowWords(at: number | null, now: number): string {
  if (at === null) return "";
  const today = new Date(now).toISOString().slice(0, 10);
  const iso = new Date(at).toISOString();
  if (iso.slice(0, 10) === today && iso.slice(11, 16) !== "00:00") return `Last row ${iso.slice(11, 16)}`;
  return `Last row ${monthDay(at)}`;
}

/** What the sync object says of a source's last run; absent until a source syncs (stage E). */
export interface SyncState {
  readonly syncedAt?: number;
  readonly failedAt?: number;
}

export interface Status {
  readonly tone: "ok" | "bad" | "quiet";
  /** The card's line: "Synced 5 min ago", "Sync failed 25 min ago", "Built in · live". */
  readonly text: string;
  /** The phone's, after the dataset count: "5 min ago", "failed 25 min ago". */
  readonly short: string;
}

/** The latest row across a source's sheets. */
export function sourceLastRow(source: DataSource, sheets: ReadonlyMap<string, Sheet | null>): number | null {
  let latest: number | null = null;
  for (const dataset of source.datasets) {
    const at = lastRowAt(sheets.get(dataset.path) ?? null);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

export function sourceStatus(source: DataSource, sheets: ReadonlyMap<string, Sheet | null>, now: number, sync?: SyncState): Status {
  if (source.kind === "context") return { tone: "ok", text: "Built in · live", short: "Built in · live" };
  if (sync?.failedAt !== undefined && (sync.syncedAt === undefined || sync.failedAt > sync.syncedAt)) {
    const when = ago(sync.failedAt, now);
    return { tone: "bad", text: `Sync failed ${when}`, short: `failed ${when}` };
  }
  if (sync?.syncedAt !== undefined) {
    const when = ago(sync.syncedAt, now);
    return { tone: "ok", text: `Synced ${when}`, short: when };
  }
  const last = sourceLastRow(source, sheets);
  if (last === null) return { tone: "quiet", text: source.kind === "push" ? "No rows yet" : "Not synced yet", short: source.kind === "push" ? "no rows yet" : "not synced yet" };
  const when = ago(last, now);
  return { tone: "ok", text: `Last row ${when}`, short: `last row ${when}` };
}

/** "Send from your code" beside a push source's name on its card. */
export function kindLine(kind: SourceKind): string | null {
  if (kind === "push") return "Send from your code";
  if (kind === "fetch") return "Fetch from a URL";
  return null;
}

export interface Setting {
  readonly key: string;
  /** A list is drawn as code chips (`supa/app`); a single value as words. */
  readonly values: readonly string[];
  readonly code: boolean;
  /** The sign-in line: drawn with a lock, in muted words. */
  readonly signIn?: boolean;
}

/** Keys about.md keeps that are drawn elsewhere, or are the Context source's own (board 10's "What it counts"). */
const DRAWN_ELSEWHERE = new Set(["name", "notes-by-status", "time-to-answered", "description"]);

const KIND_WORDS: Readonly<Record<SourceKind, string>> = {
  github: "GitHub",
  cloudflare: "Cloudflare",
  stripe: "Stripe",
  context: "Context",
  push: "Send from your code",
  fetch: "Fetch from a URL",
  other: "Other",
};

/**
 * A source's settings, as its about.md has them, in its order: `source` in
 * words, a list as chips, and for a source that signs in somewhere the line
 * saying where that is kept (board 07). Never a credential: about.md holds
 * none, and nothing here reads anything else.
 */
export function settingsOf(source: DataSource): Setting[] {
  const out: Setting[] = [];
  for (const [key, value] of Object.entries(source.about?.properties ?? {})) {
    if (DRAWN_ELSEWHERE.has(key)) continue;
    if (key === "source") {
      out.push({ key, values: [KIND_WORDS[source.kind]], code: false });
      continue;
    }
    if (Array.isArray(value)) out.push({ key, values: value.map(String), code: true });
    else if (textOf(value) !== "") out.push({ key, values: [textOf(value)], code: false });
  }
  if (signsIn(source.kind)) out.push({ key: "sign-in", values: ["Kept in the workspace vault, never in this file"], code: false, signIn: true });
  return out;
}
