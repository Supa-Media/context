/**
 * The tree's change log (`nodeLog`, phase 6 of
 * `docs/decisions/app-and-console/convex-tree.md`): what the desktop and phone
 * apps catch up from instead of walking the whole tree.
 *
 * Rows, and the rules for telling a reader about them. Nothing here touches
 * Convex: the appends are made by `convexTable.ts` as `observe.ts` changes a
 * row, and the reads by `functions/nodesFeed.ts`. Every decision about who may
 * hear of a row is made here, the way `filesFns/treeChanges.ts` makes it for
 * the D1 table's `tree_log`:
 *
 *  - **A path that is there** is an entry exactly when `canSee` over the rules
 *    says so, with `describeFile`'s fields, as `syncManifest` would draw it.
 *  - **A path that left** is told only to a reader among the audiences its
 *    row recorded, which were judged by the rules as they stood when it left.
 *    Today's rules cannot be asked: a delete forgets the exception that held a
 *    note back, so they would answer with the folder's default and name a
 *    deleted private note to the team.
 *  - **The rules changed**: the reader passes the rules version its copy was
 *    judged by (`feedToken`), and any other answers `full`: walk again.
 *
 * **Where a reader resumes says nothing they could not see.** `seq` starts
 * from the clock, and a cursor handed back is either the clock (a little
 * behind it, `NODE_LOG_OVERLAP_MS`) or the `seq` of a row this reader was
 * told about. It is never the `seq` of a row they were not, which would say
 * when somebody else's private note changed.
 */

import { audiencesOf, treeAudiences } from "../treeAudiences";
import type { Clearance } from "../clearance";
import { canSee, isPlumbing, visibilityOf, type PrivacyRule, type Visibility } from "../privacy";
import { describeFile, folderVisibleAtScope } from "../fileOps/listing";
import type { ManifestEntry, ManifestFolder } from "../fileOps";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import { mirrorFile } from "./privacyMirror";
import type { PrivacyMirror } from "./table";

/** How long a log row is kept. A device away longer walks the tree again. */
export const NODE_LOG_RETAIN_MS = 30 * 24 * 60 * 60_000;
/**
 * How far behind the clock a caught-up reader resumes. An append takes its
 * `seq` from the clock when its mutation starts and commits a moment later,
 * so resuming a minute behind reads any such row next time. Every row is an
 * upsert or a removal, so reading one twice changes nothing.
 */
export const NODE_LOG_OVERLAP_MS = 60_000;
/** Log rows one catch-up page reads. */
export const NODE_LOG_PAGE = 2_000;
/** Newest rows the live head looks through for one this reader may hear of. */
export const NODE_HEAD_SCAN = 100;
/** Expired rows one append removes as it passes. */
export const NODE_LOG_PRUNE = 25;
/** What every rules version handed out by the Convex tree starts with, so a `tree_log` cursor is never read as one. */
export const FEED_PREFIX = "nodes:";

/** `seq` ticks this many times per millisecond of the clock. */
const PER_MS = 1_000;

/** One row of the log, as stored. */
export interface LogRow {
  seq: number;
  path: string;
  gone: boolean;
  audiences?: string[];
}

/** The `seq` after `last`: never below the clock, always above the last row. */
export function nextSeq(last: number | undefined, now: number): number {
  return Math.max((last ?? 0) + 1, Math.floor(now) * PER_MS);
}

/** The `seq` a mutation that starts at `now` can no longer write below. */
export function seqAt(now: number): number {
  return Math.floor(now) * PER_MS;
}

/** Rows below this `seq` may be pruned. */
export function expiredBefore(now: number): number {
  return seqAt(now - NODE_LOG_RETAIN_MS);
}

/**
 * Whether the log still holds everything after `since`. A day's margin, so a
 * row pruned a moment after this answer is never one the reader needed.
 */
export function logReachesBack(since: number, now: number): boolean {
  return Number.isFinite(since) && since >= seqAt(now - NODE_LOG_RETAIN_MS + 24 * 60 * 60_000);
}

/**
 * The rules version a copy judged by these rules is told, or `null` when no
 * catch-up may be built on them: a `privacy.md` that does not parse fails
 * closed, and only a walk answers that.
 */
export function feedToken(mirror: PrivacyMirror | null): string | null {
  if (mirror?.invalid === true) return null;
  return `${FEED_PREFIX}${mirror?.etag ?? ""}`;
}

/** Whether a rules version was handed out by the Convex tree. */
export function isFeedToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(FEED_PREFIX);
}

/** The rules as every privacy decision reads them. */
export interface Rules {
  rules: readonly PrivacyRule[];
  overrides: ReadonlyMap<string, Visibility>;
}

/**
 * The rules a mirror holds, read the way every listing reads them: rendered
 * to `privacy.md` and parsed back by the one reader every privacy decision
 * uses, so the log never judges by a second parse of its own.
 */
export async function mirrorRules(mirror: PrivacyMirror | null): Promise<Rules> {
  const state = await loadPrivacyState({ get: async () => mirrorFile(mirror) } as unknown as FileStore);
  return { rules: state.rules, overrides: state.overrides };
}

/** The audiences that can see `path` now: what a row that leaves records. */
export function audiencesNow(path: string, rules: Rules): string[] {
  return treeAudiences([path], rules.rules, rules.overrides);
}

/** Whether a reader at `clearance` may hear of this row. */
export function toldOf(row: LogRow, clearance: Clearance, rules: Rules, reader: ReadonlySet<string>): boolean {
  if (isPlumbing(row.path)) return false;
  if (clearance.scope === "private") return true;
  if (row.gone) return (row.audiences ?? []).some((audience) => reader.has(audience));
  return canSee(row.path, clearance.scope, rules.rules, rules.overrides, clearance.names);
}

/** The audiences a reader at `clearance` belongs to. */
export function readerAudiences(clearance: Clearance): Set<string> {
  return new Set(audiencesOf(clearance.scope, [...clearance.names].map((name) => name.replace(/^@/, ""))));
}

/** A file's current version, as its node row holds it, or `null` when the row is gone. */
export interface CurrentFile {
  etag?: string;
  size?: number;
  uploaded?: number;
}

/** One page of judged changes, before the folders of what left are settled. */
export interface JudgedPage {
  entries: ManifestEntry[];
  gone: string[];
  folders: Map<string, ManifestFolder>;
  /** Folders of paths this reader was told left, not yet named: still there, or gone with them. */
  unsettled: string[];
  /** Where the next catch-up resumes, or `null` when it cannot and the reader walks. */
  since: number | null;
  more: boolean;
}

/**
 * Judges one page of log rows (oldest first) for a reader.
 *
 * `current` is each present row's file as the tree holds it now; a row whose
 * file has gone since is skipped, because the row that took it away is later
 * in the log. `reachedHead` says the page read every row there was.
 */
export function judgeRows(input: {
  rows: readonly LogRow[];
  current: ReadonlyMap<string, CurrentFile | null>;
  clearance: Clearance;
  rules: Rules;
  since: number;
  now: number;
  reachedHead: boolean;
}): JudgedPage {
  const { rows, current, clearance, rules } = input;
  const reader = readerAudiences(clearance);
  const entries: ManifestEntry[] = [];
  const gone: string[] = [];
  const folders = new Map<string, ManifestFolder>();
  const asked = new Set<string>([""]);
  const nameFolders = (key: string) => {
    let at = key.endsWith("/") ? key.replace(/\/+$/, "") : parentOf(key);
    while (at !== "" && !asked.has(at)) {
      asked.add(at);
      if (folderVisibleAtScope(at, clearance, rules.rules, rules.overrides)) {
        folders.set(at, { path: at, visibility: visibilityOf(at, rules.rules) });
      }
      at = parentOf(at);
    }
  };

  let told: number | undefined;
  for (const row of rows) {
    if (isPlumbing(row.path)) continue;
    if (row.gone) {
      if (!toldOf(row, clearance, rules, reader)) continue;
      gone.push(row.path);
      told = row.seq;
      continue;
    }
    const file = current.get(row.path);
    if (file === undefined || file === null) continue;
    // A folder is named by its own rule (`folderVisibleAtScope`), as a walk names it.
    nameFolders(row.path);
    if (!toldOf(row, clearance, rules, reader)) continue;
    told = row.seq;
    const described = describeFile(row.path, rules.rules, rules.overrides);
    entries.push({
      path: row.path,
      ...(file.etag === undefined ? {} : { etag: file.etag }),
      ...(file.size === undefined ? {} : { size: file.size }),
      ...(file.uploaded === undefined ? {} : { updatedAt: file.uploaded }),
      visibility: described.visibility,
      inherited: described.inherited,
      exception: described.exception,
      readOnly: described.readOnly,
    });
  }

  const touched = new Set<string>();
  for (const path of gone) {
    let at = path.endsWith("/") ? path.replace(/\/+$/, "") : parentOf(path);
    while (at !== "" && !touched.has(at)) {
      touched.add(at);
      at = parentOf(at);
    }
  }
  const unsettled = [...touched].filter((folder) => !folders.has(folder));

  const last = rows[rows.length - 1];
  let since: number | null;
  if (input.reachedHead) {
    // Every row there was is read: resume a little behind the clock, which
    // names nothing, or after the last row told, whichever is later.
    since = Math.max(input.since, told ?? input.since, seqAt(input.now - NODE_LOG_OVERLAP_MS));
  } else if (clearance.scope === "private") {
    since = last === undefined ? input.since : last.seq;
  } else {
    // A full page: resume after the last row this reader was told about.
    // None at all means a page of other people's changes, and a walk.
    since = told !== undefined && told > input.since ? told : null;
  }
  return { entries, gone, folders, unsettled, since, more: !input.reachedHead };
}

/**
 * Names the folders of what left: still live (and visible) folders are
 * named, the rest are reported gone. `live` answers from the tree.
 */
export function settleFolders(
  page: JudgedPage,
  live: ReadonlySet<string>,
  clearance: Clearance,
  rules: Rules,
): { folders: ManifestFolder[]; goneFolders: string[] } {
  const folders = new Map(page.folders);
  const goneFolders: string[] = [];
  for (const folder of page.unsettled) {
    if (!live.has(folder)) goneFolders.push(folder);
    else if (folderVisibleAtScope(folder, clearance, rules.rules, rules.overrides)) {
      folders.set(folder, { path: folder, visibility: visibilityOf(folder, rules.rules) });
    }
  }
  return { folders: [...folders.values()], goneFolders };
}

/**
 * The newest row this reader may hear of, among `newest` (newest first), or
 * `null` when none of them: what the live head says, so a change somebody
 * cannot see never moves what they are sent.
 */
export function newestTold(newest: readonly LogRow[], clearance: Clearance, rules: Rules): number | null {
  const reader = readerAudiences(clearance);
  for (const row of newest) if (toldOf(row, clearance, rules, reader)) return row.seq;
  return null;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
