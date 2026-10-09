/**
 * Search by meaning's catch-up pass, over a store the control plane opened.
 *
 * The gateway's `meaningPass` (`apps/mcp/src/search/meaning/catchup.js`),
 * imported rather than copied. The tier a note is embedded at is this
 * runtime's `effectiveVisibility`, injected exactly as fast search injects it,
 * and proven identical to the gateway's by `privacyEngine.test.ts`.
 *
 * ## Its census is a listing, never the bucket's search index
 *
 * It used to take its list of notes from the R2 shard index's docmap, and ran
 * a pass of that index first to get it. On a large workspace that index is
 * the thing that falls behind: @seyi's (9,000 notes, 2026-10-08) never
 * converged, so every catch-up pass spent itself on the shard index and the
 * meaning index stopped at its first forty notes. Search by meaning is what
 * replaces the bucket index, so it must not need it. A listing of the bucket
 * (the same walk the shard index lists with, which steps over `.context/`) is
 * a few dozen requests for ten thousand notes, and its versions are the same
 * listing tokens the docmap held, so a map written from either census reads
 * the same. A listing cut short deletes nothing outside what it reached, and
 * the pass is not ready until one finishes.
 *
 * Like every scheduled search pass it reads every note, private ones included,
 * and answers nothing about them: counts only.
 */

import { effectiveVisibility, isPlumbing } from "../privacy";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
import { meaningPass } from "../../../../mcp/src/search/meaning/catchup.js";
import { listNoteObjects } from "../../../../mcp/src/search/shards/listing.js";
import { loadPrivacyState } from "./privacyState";
import type { FileStore } from "./store";
import type { IndexingPriorities } from "../indexingPriorities";

/**
 * List pages one census may spend: a million objects at a thousand a page,
 * far past any bucket today. A walk that runs out is reported as unfinished,
 * never as complete.
 */
const MEANING_LISTING_BUDGET = 1_000;

export interface MeaningPassClient {
  upsert(vectors: unknown[]): Promise<number>;
  deleteByIds(ids: string[]): Promise<number>;
}

export interface MeaningPassResult {
  embedded: number;
  deleted: number;
  notesIndexed: number;
  notesPending: number;
  /** Per indexing priority; absent when the bucket could not be listed. */
  priorities?: IndexingPriorities;
  ready: boolean;
  moved: boolean;
  /** One of our closed codes, never a provider's words. */
  failure: string | null;
  /** Which call failed, from our closed set (`http_400`, `timeout`, `internal`…). */
  failureCause: string | null;
  /** Fixed Cloudflare operation name, never a URL or note path. */
  failureOperation?: string | null;
  /** Numeric Cloudflare error codes only, never provider messages. */
  providerCodes?: number[];
}

export async function projectMeaningIndex(
  store: FileStore,
  meaning: {
    client: MeaningPassClient;
    embed: (texts: string[]) => Promise<number[][]>;
    generation: string;
  },
  /** `budget` is list pages, for a test to cut a walk short. */
  options: { budget?: number; noteCap?: number } = {},
): Promise<MeaningPassResult> {
  const budget = createSearchBudget(options.budget ?? MEANING_LISTING_BUDGET);
  let listing: { entries: Map<string, { version: string }>; regionComplete: (path: string) => boolean; truncated: boolean };
  try {
    listing = await listNoteObjects(store, budget, 0, (key: string) => key.endsWith(".md") && !isPlumbing(key));
  } catch {
    // The bucket could not be listed: nothing is decided from a census nobody
    // has, and the pass says which call failed.
    return {
      embedded: 0,
      deleted: 0,
      notesIndexed: 0,
      notesPending: 0,
      ready: false,
      moved: false,
      failure: "STORE_FAILED",
      failureCause: "listing",
    };
  }
  const census = new Map<string, string>();
  for (const [path, entry] of listing.entries) census.set(path, entry.version);
  const state = await loadPrivacyState(store);
  const pass = await meaningPass(store as unknown as Parameters<typeof meaningPass>[0], {
    client: meaning.client,
    embed: meaning.embed,
    census,
    visibilityOf: (path: string) => effectiveVisibility(path, state.rules, state.overrides),
    generation: meaning.generation,
    indexPending: listing.truncated ? 1 : 0,
    regionComplete: listing.regionComplete,
    ...(options.noteCap === undefined ? {} : { noteCap: options.noteCap }),
  } as unknown as Parameters<typeof meaningPass>[1]);
  return pass;
}
