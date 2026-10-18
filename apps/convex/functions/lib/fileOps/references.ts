/**
 * Rewriting the links that point at a path that moved.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { indexByName, rewriteLinks } from "@context/shared/src/links";
import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
  supported as collaborationSupported,
} from "@context/collaboration";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import type { PrivacyState } from "./privacyState";
import type { TreeNames } from "./treeChecks";
import { namesListing } from "./walk";
import { bareNameOf } from "../../../../mcp/src/tree/links.js";

/**
 * How many notes a move will read looking for references to what moved.
 *
 * The gateway's `LINK_SCAN_CAP` and the same argument: a move is rare and
 * deliberate, so a full walk is the right trade, and "full" needs a number
 * because the bucket is a customer's. Past this the move still happens and the
 * rewrite is reported as **not done**, which is the honest failure — a partial
 * rewrite announcing success would leave somebody believing their links were
 * fixed.
 *
 * Where the tree's link facts are whole the count is of the notes that can
 * hold a link to what moved (`linkCandidates`), not of the workspace, so a
 * workspace of any size is rewritten; only where the facts cannot answer is
 * every visible note read, and counted, as before.
 */
const LINK_SCAN_CAP = 4000;

export interface ReferenceRewrite {
  /** Notes whose bodies were changed. */
  notes: number;
  /** Link targets moved across those notes. */
  links: number;
  /** The context was too large to walk, so nothing was rewritten. */
  capped: boolean;
}

/**
 * Point every link at where its note went.
 *
 * The control plane's half of the rule the gateway states in full at
 * `apps/mcp/src/links.js`: a reference follows what it points at, by default,
 * because a workspace whose links rot the first time somebody tidies a folder is a
 * workspace people stop tidying. A rename made in the console and the same rename
 * made through an MCP client have to do the same thing, and
 * `linkParity.test.ts` is what keeps the two engines honest about that.
 *
 * Three things here are decisions rather than mechanics, and each is the
 * gateway's:
 *
 *   - **Only what this caller can see.** `keysUnder` already withholds what
 *     `canSee` refuses and the manifest bookkeeping is built on that; a rewrite
 *     that reached further would be the one operation in this file that acts
 *     outside the caller's surface, and its *count* would be an inference
 *     channel about notes they cannot list.
 *   - **The moved notes are rewritten too.** A note carried by a folder move
 *     keeps every relative link it had, and each one now needs a different
 *     number of `../`.
 *   - **Names resolve as they were before the move**, because a bare
 *     `[[overview]]` was written against the bucket as it was.
 *
 * It runs after `remapPrivacy`, so the visibility of every destination is
 * already settled and `canSee` below is asking about the bucket as it now is.
 * A failure to walk is reported, never thrown: the move has landed and must not
 * be undone because its bookkeeping could not finish.
 */
export async function rewriteReferences(
  store: FileStore,
  options: {
    clearance: Clearance;
    state: PrivacyState;
    renames: ReadonlyMap<string, string>;
    /** Told the new etag of every note this rewrites. See `movePath`'s `etag`. */
    onRewritten?: (key: string, etag: string) => void;
  },
): Promise<ReferenceRewrite> {
  if (options.renames.size === 0) return { notes: 0, links: 0, capped: false };

  let keys: string[] | null;
  try {
    keys = await visibleNoteKeys(store, options.clearance, options.state, options.renames);
  } catch {
    return { notes: 0, links: 0, capped: true };
  }
  if (keys === null) return { notes: 0, links: 0, capped: true };
  const wasAt = new Map<string, string>();
  for (const [source, destination] of options.renames) wasAt.set(destination, source);
  // Every visible note names what a bare link resolves against; only the ones that can hold a link to what
  // moved are read (`linkCandidates`), so the cap is on those, not on the workspace.
  const byName = indexByName(keys.map((key) => wasAt.get(key) ?? key));
  const candidates = await linkCandidates(store, options.renames);
  if (candidates !== null) keys = keys.filter((key) => candidates.has(key));
  if (keys.length > LINK_SCAN_CAP) return { notes: 0, links: 0, capped: true };

  let notes = 0;
  let links = 0;
  // Read a few notes ahead while the one before is judged and written: the
  // reads were one round trip each, in a row, and on a few hundred notes that
  // was most of a rename's time. Writes stay one at a time, in order.
  const texts = readAhead(store, keys, REFERENCE_READ_AHEAD);
  for (const key of keys) {
    const ahead = await texts.next(key);
    if (ahead === null) continue;
    const linksOf = (text: string) =>
      rewriteLinks(text, { fromPath: wasAt.get(key) ?? key, toPath: key, renames: options.renames, byName });
    if (linksOf(ahead) === null) continue;
    // A note read ahead may have been edited since. Read it again before
    // writing, so a repair is never built on a version older than it was.
    const object = await store.get(key);
    if (object === null) continue;
    const text = await object.text();
    const rewritten = linksOf(text);
    if (rewritten === null) continue;
    notes += 1;
    links += rewritten.changed;
    /*
      A migrated note's Markdown is a materialization of its collaboration
      head. Route that rewrite through the same retained-base operation so a
      backlink repair cannot be discarded by the next collaborative read.
      Unmigrated or ineligible objects retain the ordinary raw write path.
    */
    let etag: string | undefined;
    if (collaborationSupported(store) && collaborationEligible(key, text) && !isEncryptedNote(text)) {
      try {
        const current = await readCollaborationDocument(store, key);
        const replaced = await replaceCollaborationText(store, key, {
          documentId: current.documentId,
          expectedEtag: current.etag,
          text: rewritten.text,
        });
        etag = replaced.etag;
      } catch {
        // A migrated note must never fall back to a raw PUT. A move may have
        // changed its path between the listing and this repair; leaving the
        // repair pending is safer than overwriting a head at an old revision.
        continue;
      }
    } else {
      const put = await store.put(key, rewritten.text);
      etag = put?.etag;
    }
    if (etag) options.onRewritten?.(key, etag);
  }
  return { notes, links, capped: false };
}

/** Notes read ahead of the one being rewritten. */
const REFERENCE_READ_AHEAD = 8;

/** Renamed paths, or bare names, one facts read asks about: well inside the control plane's `MOVE_RENAMES_CAP`. */
const CANDIDATE_BATCH = 1_000;

/**
 * The notes a rewrite for `renames` must read, at their names after the move, from the tree's link facts
 * (`nodeLinks`), as the gateway narrows its own (`apps/mcp/src/tree/facts.js`): every note pointing at a
 * renamed path by path or at its bare name, every note changed since its links were read, and every renamed
 * note that holds links of its own (its relative links move with it). `null` where the facts cannot answer
 * (no tree attached, or not whole yet), and every visible note is read as before.
 */
async function linkCandidates(store: FileStore, renames: ReadonlyMap<string, string>): Promise<Set<string> | null> {
  const tree = (store as { treeListing?: TreeNames }).treeListing;
  if (typeof tree?.links !== "function" || typeof tree.linking !== "function") return null;
  const sources = [...renames.keys()];
  const names = [...new Set(sources.map((path) => bareNameOf(path) as string))];
  const found = new Set<string>();
  try {
    for (const [list, kind] of [[sources, "sources"], [names, "names"]] as const) {
      for (let at = 0; at < list.length; at += CANDIDATE_BATCH) {
        const batch = list.slice(at, at + CANDIDATE_BATCH);
        const answer = await tree.links(kind === "sources" ? { sources: batch, names: [] } : { sources: [], names: batch });
        if (answer === null) return null;
        for (const path of [...answer.pointing, ...answer.unparsed]) found.add(renames.get(path) ?? path);
      }
    }
    // A moved note's own links are kept under either name, as far as the facts have followed the move.
    const ends = [...new Set([...renames.keys(), ...renames.values()])];
    for (let at = 0; at < ends.length; at += CANDIDATE_BATCH) {
      for (const path of await tree.linking(ends.slice(at, at + CANDIDATE_BATCH))) found.add(renames.get(path) ?? path);
    }
  } catch {
    return null;
  }
  return found;
}

/**
 * Hands back each key's text in the order asked, keeping up to `depth` reads
 * in flight ahead of the caller. A key that is gone reads as `null`; a read
 * that fails throws when its key is asked for, as the plain read did.
 */
function readAhead(store: FileStore, keys: readonly string[], depth: number) {
  const pending = new Map<string, Promise<string | null>>();
  let started = 0;
  const read = async (key: string) => {
    const object = await store.get(key);
    return object === null ? null : await object.text();
  };
  const fill = () => {
    while (started < keys.length && pending.size < depth) {
      const key = keys[started];
      started += 1;
      const promise = read(key);
      // Asked for later; a failure is surfaced then, not as an unhandled rejection now.
      promise.catch(() => {});
      pending.set(key, promise);
    }
  };
  return {
    async next(key: string): Promise<string | null> {
      fill();
      const promise = pending.get(key) ?? read(key);
      pending.delete(key);
      fill();
      return await promise;
    },
  };
}

/**
 * Every note this caller can see, or `null` if the walk ran out of pages
 * before reaching the end.
 *
 * `null` rather than a short list, for the reason `keysUnder` gives about its
 * own `complete` flag: a truncated walk reads exactly like a finished one, and
 * the caller here would then rewrite part of a bucket and report a total.
 *
 * Listed from the Convex tree where it serves (`namesListing`), which may not
 * have heard of this move yet, so the renames are applied to what it lists:
 * an old name is dropped and its new one counted. Against a bucket that has
 * already moved, that changes nothing.
 */
async function visibleNoteKeys(
  store: FileStore,
  clearance: Clearance,
  state: PrivacyState,
  renames: ReadonlyMap<string, string>,
): Promise<string[] | null> {
  const found = new Set<string>();
  const names = namesListing(store);
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await names.list({ prefix: "", cursor, limit: 1000 });
    for (const object of listing.objects ?? []) found.add(object.key);
    if (!listing.truncated) {
      complete = true;
      break;
    }
    const next = listing.cursor;
    // A page that reports more and hands back no way to ask for it is the
    // shape `keysUnder` documents: ending the walk here would return a short
    // list that reads like a complete one.
    if (!next || next === cursor) return null;
    cursor = next;
  }
  if (!complete) return null;
  for (const [source, destination] of renames) {
    found.delete(source);
    found.add(destination);
  }
  const keys: string[] = [];
  for (const key of found) {
    if (isPlumbing(key) || !key.endsWith(".md")) continue;
    if (!canSee(key, clearance.scope, state.rules, state.overrides, clearance.names)) continue;
    keys.push(key);
  }
  return keys;
}
