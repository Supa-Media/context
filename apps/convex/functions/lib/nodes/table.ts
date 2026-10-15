/**
 * The workspace tree in Convex (`lib/schema/nodes.ts`): the shapes every
 * piece of it shares, and the two seams that keep its logic testable.
 *
 * - **`NodeTable`** is the rows of one workspace. The rules for changing
 *   them (`observe.ts`) are written once against it and run two ways: inside
 *   a Convex mutation (`convexNodeTable`) and over a plain Map in tests
 *   (`__tests__/nodeTable.helpers.ts`), so a sweep or a re-check can be
 *   tested end to end without a deployment.
 * - **`NodeSink`** is what the bucket-side work (`sweep.ts`, `touch.ts`) asks
 *   of the tree: begin a sweep, record what a listing saw, finish. In
 *   production each call is one internal mutation (`functions/nodes.ts`);
 *   in tests it is the same functions over a `NodeTable` in memory.
 *
 * Phase 1 of the migration (`docs/decisions/app-and-console/convex-tree.md`)
 * is a shadow: these rows are filled and checked, and nothing answers a
 * person from them yet.
 */

import { isIdKey } from "../../../../mcp/src/privacy/engine.js";

/** A key the bucket holds, as a listing describes it. */
export interface NodeRow {
  /** The bucket key, e.g. `1-projects/a.md`. Never a top-level dot folder. */
  path: string;
  etag?: string;
  size?: number;
  /** Epoch ms. */
  uploaded?: number;
}

/** One stored node, as `NodeTable` hands it back. */
export interface StoredNode {
  id: string;
  path: string;
  /** `undefined` at the root. */
  parentId?: string;
  name: string;
  kind: "file" | "folder";
  etag?: string;
  size?: number;
  uploaded?: number;
  observedAt: number;
  goneAt?: number;
}

/**
 * What one look at the bucket saw, at `at` (epoch ms, taken before the look).
 *
 * - `rows`: keys it saw, with their versions.
 * - `gone`: exact keys it saw were not there.
 * - `vanishedUnder`: folder prefixes (each ending in `/`) it listed
 *   **completely**: any live file under one that is not in `rows` and was
 *   last observed before `at` is gone.
 */
export interface Observation {
  at: number;
  rows: NodeRow[];
  gone: string[];
  vanishedUnder: string[];
  /**
   * Who could see a key before the change that took it away, as its writer
   * judged it. A move clears the source's exception before the tree hears of
   * it, so a `gone` row narrows to this (`convexTable.ts`, `logChange`).
   */
  left?: LeftAudiences[];
}

/** A key a change took away and the audiences that could see it before. */
export interface LeftAudiences {
  path: string;
  audiences: string[];
}

/**
 * The rows of ONE workspace. Every method is scoped to it; nothing here can
 * name another workspace's row.
 */
export interface NodeTable {
  byPath(path: string): Promise<StoredNode | null>;
  insert(node: Omit<StoredNode, "id">): Promise<string>;
  patch(id: string, fields: Partial<Omit<StoredNode, "id" | "path" | "kind">>): Promise<void>;
  remove(id: string): Promise<void>;
  /** Rows whose path starts with `prefix`, in the table's path order, from just after `after`. At most `limit`. */
  underPrefix(prefix: string, options: { after?: string; limit: number }): Promise<StoredNode[]>;
  /** Rows with `observedAt < before`, oldest first. At most `limit`. */
  observedBefore(before: number, limit: number): Promise<StoredNode[]>;
  /** Whether the folder `parentId` holds any row that is not gone (a file, a marker, or a live folder). */
  hasLiveChild(parentId: string): Promise<boolean>;
  /**
   * Records that the file row at `path` appeared or changed version
   * (`gone: false`), or left (`gone: true`), in the tree's change log
   * (`log.ts`). Called by `observe.ts` for every such change and nothing else,
   * so a sweep that only re-sees a file writes nothing. Optional so a table
   * with no log (a read-only view) need not pretend to have one.
   */
  logChange?(path: string, gone: boolean): Promise<void>;
}

/** The sweep's bookkeeping for one workspace (`nodeTrees`). */
export interface NodeTreeState {
  status: "empty" | "filling" | "ready" | "unsupported";
  cursor?: string;
  startedAt?: number;
  leaseAt?: number;
  sweptAt?: number;
  dirty: boolean;
  files: number;
  error?: string;
}

/** Parsed `privacy.md` rules, as `nodePrivacy` keeps them. */
export interface PrivacyMirror {
  etag?: string;
  invalid: boolean;
  folders: { prefix: string; visibility: string }[];
  notes: { path: string; visibility: string }[];
}

/** What the bucket-side work asks of the tree. One call, one mutation, in production. */
export interface NodeSink {
  state(): Promise<NodeTreeState | null>;
  /**
   * Start (or join) a sweep at `at`. Takes the lease, clears `dirty`, and on
   * a fresh start sets `cursor: ""` and `startedAt` (kept at the EARLIEST
   * start two racing passes recorded). Returns where to list from and the
   * start the finish will prune by.
   */
  begin(at: number): Promise<{ cursor: string; startedAt: number }>;
  observe(observation: Observation): Promise<void>;
  /** The sweep listed through `cursor`; renews the lease. */
  progress(cursor: string, at: number): Promise<void>;
  /**
   * Remove what nobody observed since `startedAt`: live files and folders
   * last observed before it, and tombstones that went before it. Bounded;
   * `more` means call again.
   */
  prune(startedAt: number): Promise<{ more: boolean }>;
  /** The sweep finished at `at`: ready, cursor and start cleared, error cleared, live files counted. */
  finish(at: number): Promise<void>;
  /** The store cannot be resumed in key order (Dropbox): never served, never swept again. */
  unsupported(): Promise<void>;
  /** A change too big to re-check: the next due check starts a sweep. */
  dirty(): Promise<void>;
  /** A pass failed; `label` is fixed and path-free. */
  fail(label: string): Promise<void>;
  privacy(): Promise<PrivacyMirror | null>;
  savePrivacy(mirror: PrivacyMirror, at: number): Promise<void>;
}

/** Rows one `observe` mutation takes; a bigger observation is split by the caller. */
export const OBSERVE_BATCH = 250;
/** Rows one `prune` mutation removes before answering `more`. */
export const PRUNE_BATCH = 500;
/** Rows one `vanishedUnder` prefix may scan in one mutation before the caller is told to come back. */
export const VANISH_SCAN = 2_000;
/** List pages (of 1,000 keys) one sweep pass walks. */
export const NODE_SWEEP_PAGES = 10;
/** Passes one sweep chain may schedule: a bound on a loop, not on a workspace. */
export const NODE_SWEEP_CHAIN = 100;
/** A pass that ran this recently holds the sweep; another one waits. */
export const NODE_SWEEP_LEASE_MS = 5 * 60_000;
/** A tree last swept longer ago than this is swept again when somebody walks it. */
export const NODE_SWEEP_STALE_MS = 60 * 60_000;
/** Paths one change may re-check individually; more marks the tree dirty. */
export const NODE_TOUCH_PATHS = 50;
/** List pages one folder's re-check may walk; more marks the tree dirty. */
export const NODE_TOUCH_FOLDER_PAGES = 10;
/** How long a save's re-check waits, so a burst of typing pauses is one re-check. */
export const NODE_EDIT_SETTLE_MS = 3_000;
/** A gathered flush due longer ago than this was lost; the next save schedules another. */
export const NODE_EDIT_LOST_MS = 5 * 60_000;
/**
 * A tree proved equal to its bucket longer ago than this is checked again when
 * its next sweep finishes. Parity is what lets the tree serve, so a proof that
 * is never renewed is a guess about today from the day it was made.
 */
export const NODE_PARITY_STALE_MS = 24 * 60 * 60_000;
/** A check that found differences is run once more after this, before it raises the staff alarm. */
export const NODE_PARITY_CONFIRM_MS = 30_000;

/**
 * Whether a sweep finishing at `at` should check the tree against its bucket:
 * never checked, last check differed, or the last proof is a day old.
 */
export function nodeParityDue(
  parity: { checkedAt: number; mismatches: number; privacyMatches: boolean } | undefined,
  at: number,
): boolean {
  if (parity === undefined) return true;
  if (parity.mismatches > 0 || !parity.privacyMatches) return true;
  return at - parity.checkedAt >= NODE_PARITY_STALE_MS;
}

/** The bucket key of the privacy manifest. */
export const NODE_PRIVACY_KEY = "privacy.md";

/** How long a store found unlistable waits before a sweep tries it again. */
export const NODE_UNSUPPORTED_RETRY_MS = 24 * 60 * 60 * 1000;

/** Whether a walk of the tree in this state should start (or continue) a sweep. */
export function nodeSweepDue(state: NodeTreeState | null, now: number): boolean {
  if (state === null) return true;
  // Tried again a day after it was found unlistable; a tree marked so before
  // the sweep could page by token (no `leaseAt`) is tried at once.
  if (state.status === "unsupported") return state.leaseAt === undefined || now - state.leaseAt >= NODE_UNSUPPORTED_RETRY_MS;
  if (state.leaseAt !== undefined && now - state.leaseAt < NODE_SWEEP_LEASE_MS) return false;
  if (state.cursor !== undefined) return true;
  if (state.status !== "ready" || state.dirty) return true;
  return state.sweptAt === undefined || now - state.sweptAt >= NODE_SWEEP_STALE_MS;
}

/**
 * A key as the tree keeps it, or `null` for one it never keeps: empty,
 * absolute, under a top-level dot folder, or itself dot-prefixed at the root.
 * Trailing slashes (a folder marker key) are trimmed.
 */
export function nodePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.replace(/^\/+|\/+$/g, "");
  if (path === "" || path.startsWith(".")) return null;
  // An id-layout copy (`notes/<noteId>.md`) is not a note: never a row.
  if (isIdKey(path)) return null;
  return path;
}

/**
 * A listed key exactly as the tree keeps it, or `null`. Like `nodePath`, but
 * a folder marker key (`a/`, what an S3 console's "Create folder" writes)
 * keeps its trailing slash: it is its own row, a `file` named `""` under the
 * folder it marks, so it is observed, tombstoned and pruned like any key and
 * a tree drawn from the rows names that folder even while it holds nothing
 * else. A key the tree would spell differently (`/a`, `a//`) is `null`.
 */
export function nodeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = nodePath(value);
  if (path === null) return null;
  if (value === path) return path;
  return value === `${path}/` ? value : null;
}

/** `a/b/c.md` → `["a", "a/b"]`: the folders a key lives under, outermost first. */
export function folderChain(path: string): string[] {
  const parts = path.split("/");
  const chain: string[] = [];
  for (let index = 1; index < parts.length; index += 1) chain.push(parts.slice(0, index).join("/"));
  return chain;
}

/** The last segment of a path. */
export function nameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}
