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

/**
 * How many notes a move will read looking for references to what moved.
 *
 * The gateway's `LINK_SCAN_CAP` and the same argument: a move is rare and
 * deliberate, so a full walk is the right trade, and "full" needs a number
 * because the bucket is a customer's. Past this the move still happens and the
 * rewrite is reported as **not done**, which is the honest failure — a partial
 * rewrite announcing success would leave somebody believing their links were
 * fixed.
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
    keys = await visibleNoteKeys(store, options.clearance, options.state);
  } catch {
    return { notes: 0, links: 0, capped: true };
  }
  if (keys === null || keys.length > LINK_SCAN_CAP) return { notes: 0, links: 0, capped: true };

  const wasAt = new Map<string, string>();
  for (const [source, destination] of options.renames) wasAt.set(destination, source);
  const byName = indexByName(keys.map((key) => wasAt.get(key) ?? key));

  let notes = 0;
  let links = 0;
  for (const key of keys) {
    const object = await store.get(key);
    if (object === null) continue;
    const text = await object.text();
    const rewritten = rewriteLinks(text, {
      fromPath: wasAt.get(key) ?? key,
      toPath: key,
      renames: options.renames,
      byName,
    });
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

/**
 * Every note in the bucket this caller can see, or `null` if the walk ran out
 * of pages before reaching the end.
 *
 * `null` rather than a short list, for the reason `keysUnder` gives about its
 * own `complete` flag: a truncated walk reads exactly like a finished one, and
 * the caller here would then rewrite part of a bucket and report a total.
 */
async function visibleNoteKeys(
  store: FileStore,
  clearance: Clearance,
  state: PrivacyState,
): Promise<string[] | null> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: "", cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (isPlumbing(object.key)) continue;
      if (!object.key.endsWith(".md")) continue;
      if (!canSee(object.key, clearance.scope, state.rules, state.overrides, clearance.names)) continue;
      if (seen.has(object.key)) continue;
      seen.add(object.key);
      keys.push(object.key);
    }
    if (!listing.truncated) return keys;
    const next = listing.cursor;
    // A page that reports more and hands back no way to ask for it is the
    // shape `keysUnder` documents: ending the walk here would return a short
    // list that reads like a complete one.
    if (!next || next === cursor) return null;
    cursor = next;
  }
  return null;
}
