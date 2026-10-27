/**
 * The workspace tree in Convex (`lib/schema/nodes.ts`): the shapes every
 * piece of it shares, and the two seams that keep its logic testable.
 *
 * - **`NodeTable`** is the rows of one workspace. The rules for changing
 *   them (`observe.ts`) are written once against it and run two ways: inside
 *   a Convex mutation (`convexNodeTable`) and over a plain Map in tests
 *   (`__tests__/nodeTable.helpers.ts`), so they can be tested without a deployment.
 * Rows are written only by the product's own seam (writes, moves, trash and
 * the keyed observations of `lib/noteIds/*`), never by listing the bucket:
 * names and existence come from these rows (`notes-by-id`).
 */

import { isIdKey } from "../../../../mcp/src/privacy/engine.js";
import type { FileStore } from "../fileOps/store";

/** A key the bucket holds, as a listing describes it. */
export interface NodeRow {
  /** The bucket key, e.g. `1-projects/a.md`. Never a top-level dot folder. */
  path: string;
  etag?: string;
  size?: number;
  /** Epoch ms. */
  uploaded?: number;
  /** The row's note id (`lib/nodes/noteIds.ts`), when it has one. Carried, never read to decide anything here. */
  noteId?: string;
  /**
   * Set on a seam observation's rows (`source: "seam"`): the note the key
   * now holds and the key its bytes live at. Bucket rows never carry it.
   */
  keyed?: KeyedAt;
}

/** A keyed row's identity: its note, and the one key its bytes live at. */
export interface KeyedAt {
  noteId: string;
  storageKey: string;
}

/** The id copy a row records (`convex/schema`'s `nodes.idCopy`). */
export interface IdCopyRecord {
  key: string;
  etag: string;
  copiedAt: number;
  keyEtag?: string;
}

/** The versions a flipped row had when it was keyed (`nodes.keyedFrom`). */
export interface KeyedFrom {
  pathEtag: string;
  keyEtag: string;
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
  /** The note's stable id (`lib/nodes/noteIds.ts`). */
  noteId?: string;
  /** Set on a keyed row: where its bytes live, and nowhere else (`keyed`). */
  storageKey?: string;
  /** The id-keyed copy of an unkeyed row's bytes. */
  idCopy?: IdCopyRecord;
  /** A flipped row's versions at the flip (`KeyedFrom`). */
  keyedFrom?: KeyedFrom;
  /** The row's own access, when a privacy rule names it (`nodes.access`). A row carrying it is never pruned. */
  access?: { base: "private" | "team" };
  /** A built-in folder's job (`nodes.role`, `folderJobs.ts`). A folder carrying one is never retired for being empty. */
  role?: string;
}

/**
 * What the product's seam saw written, at `at` (epoch ms, taken before the write).
 *
 * - `rows`: the keyed rows it wrote, each carrying `keyed` (its note and key).
 * - `gone`: exact keys it removed.
 */
export interface Observation {
  at: number;
  rows: NodeRow[];
  gone: string[];
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
  /** A new row. `noteId` is minted when absent; `storageKey` makes the row keyed. */
  insert(node: Omit<StoredNode, "id">): Promise<string>;
  patch(id: string, fields: Partial<Omit<StoredNode, "id" | "path" | "kind">>): Promise<void>;
  remove(id: string): Promise<void>;
  /** Whether the folder `parentId` holds any row that is not gone (a file, a marker, or a live folder). */
  hasLiveChild(parentId: string): Promise<boolean>;
  /** Whether a live row other than `exceptId` holds this note id. Optional: a table without it is treated as yes. */
  idHeldElsewhere?(noteId: string, exceptId: string): Promise<boolean>;
  /**
   * Records that the file row at `path` appeared or changed version
   * (`gone: false`), or left (`gone: true`), in the tree's change log
   * (`log.ts`). Called by `observe.ts` for every such change and nothing else,
   * so a sweep that only re-sees a file writes nothing. Optional so a table
   * with no log (a read-only view) need not pretend to have one.
   */
  logChange?(path: string, gone: boolean): Promise<void>;
}

/** Parsed `privacy.md` rules, as `nodePrivacy` keeps them. */
export interface PrivacyMirror {
  etag?: string;
  invalid: boolean;
  folders: { prefix: string; visibility: string }[];
  notes: { path: string; visibility: string }[];
  /**
   * Only on a reader's view in rows mode (`readerRules.readerMirror`), never stored: `folders` and `notes` are
   * the rows' judgement, which can carry row tokens the file parser refuses, so they are not rendered and parsed.
   */
  rows?: boolean;
}

/** Rows one seam batch takes; a bigger write is split by the caller. */
export const OBSERVE_BATCH = 250;

/** The bucket key of the privacy manifest. */
export const NODE_PRIVACY_KEY = "privacy.md";

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

/** A keyed row: its bytes live at `storageKey` and nowhere else (`lib/schema/nodes.ts`). */
export function isKeyed(node: { storageKey?: string }): boolean {
  return node.storageKey !== undefined;
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

/**
 * Bytes-order comparison of two keys. S3 lists in UTF-8 byte order, which is
 * not JavaScript's string order; the in-memory tree and the listing agree on it.
 */
const KEY_BYTES = new TextEncoder();
export function compareKeys(a: string, b: string): number {
  const x = KEY_BYTES.encode(a);
  const y = KEY_BYTES.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}

/** The store operations a listing reader uses (`listFolder`, the parity-free walks), and nothing else of the bucket. */
export type NodeListingStore = Pick<FileStore, "list" | "get">;
