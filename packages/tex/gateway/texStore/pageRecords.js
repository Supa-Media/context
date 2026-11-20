/**
 * What Tex did in a chat, for the person's Tex page (`context.lc/tex/@handle`;
 * decided by the owner, 2026-11-02): each text the front door handled
 * (`thinking`), each ask of the advisor (`advisor`) and each email the mail
 * checker read (`mailcheck`).
 *
 * There is no store here. The chat's one log in its Tex object is the only
 * source (decided by the owner, 2026-11-02: one JSON log per chat, everything
 * else a view rebuilt from it), and these are views of it: the object answers
 * `page_list` from `objects.records` (`texStore/pageViews.js`), naming the
 * chat's log: `texts` for a person's own chat, the group key for a group's.
 * An object without a log answers an empty page, so the page shows nothing
 * rather than something wrong.
 */

import { callTexStore, texStoreStub } from "./wire.js";

/** The kinds a chat's page shows from its log. */
export const PAGE_KINDS = Object.freeze(["thinking", "advisor", "mailcheck"]);
const KINDS = new Set(PAGE_KINDS);
/** The most records one listing returns. */
export const MAX_PAGE_LIST = 50;

/** One page of a chat's records, or an empty page when the object cannot be reached. Never throws. */
export async function readPageRecords(env, owner, kind, { limit, cursor, since } = {}) {
  try {
    const stub = texStoreStub(env, owner);
    if (stub === null || !KINDS.has(kind)) return { items: [], count: 0 };
    const size = Math.max(1, Math.min(MAX_PAGE_LIST, Number.isSafeInteger(limit) ? limit : 20));
    const response = await callTexStore(stub, "page_list", { chat: owner?.chat ?? "texts", kind, limit: size, cursor: cursor ?? null, since: since ?? null });
    const page = await response.json();
    return Array.isArray(page?.items) ? page : { items: [], count: 0 };
  } catch {
    return { items: [], count: 0 };
  }
}
