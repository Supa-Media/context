/**
 * Search by meaning's catch-up pass, over a store the control plane opened.
 *
 * The gateway's `meaningPass` (`apps/mcp/src/search/meaning/catchup.js`),
 * imported rather than copied, riding the same R2 index pass and census as
 * fast search's projection (`projection.ts`). The tier a note is embedded at is
 * this runtime's `effectiveVisibility`, injected exactly as fast search injects
 * it, and proven identical to the gateway's by `privacyEngine.test.ts`.
 *
 * Like every scheduled search pass it reads every note, private ones included,
 * and answers nothing about them: counts only.
 */

import { effectiveVisibility } from "../privacy";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
import { meaningPass } from "../../../../mcp/src/search/meaning/catchup.js";
import { passCensus } from "./projection";
import { loadPrivacyState } from "./privacyState";
import type { FileStore } from "./store";

/** Store ops for the R2 index pass this rides on; the embedding is bounded by its note cap. */
const MEANING_PASS_BUDGET = 1_200;
const MEANING_RESERVE_SHARE = 4;

export interface MeaningPassClient {
  upsert(vectors: unknown[]): Promise<number>;
  deleteByIds(ids: string[]): Promise<number>;
}

export interface MeaningPassResult {
  embedded: number;
  deleted: number;
  notesIndexed: number;
  notesPending: number;
  ready: boolean;
  moved: boolean;
  /** One of our closed codes, never a provider's words. */
  failure: string | null;
  /** Which call failed, from our closed set (`http_400`, `timeout`, `internal`…). */
  failureCause: string | null;
}

export async function projectMeaningIndex(
  store: FileStore,
  meaning: {
    client: MeaningPassClient;
    embed: (texts: string[]) => Promise<number[][]>;
    generation: string;
  },
  options: { budget?: number; noteCap?: number } = {},
): Promise<MeaningPassResult> {
  const budget = createSearchBudget(options.budget ?? MEANING_PASS_BUDGET);
  const reserve = Math.floor(budget.remaining / MEANING_RESERVE_SHARE);
  const { census, indexPending, synced } = await passCensus(store, budget, reserve);
  if (census === null) {
    // A bucket whose R2 index this pass has only started building: nothing
    // to walk yet, and `moved` says whether the index got anywhere.
    return {
      embedded: 0,
      deleted: 0,
      notesIndexed: 0,
      notesPending: 0,
      ready: false,
      moved: Boolean(synced?.committed),
      failure: null,
      failureCause: null,
    };
  }
  const state = await loadPrivacyState(store);
  const pass = await meaningPass(store as unknown as Parameters<typeof meaningPass>[0], {
    client: meaning.client,
    embed: meaning.embed,
    census,
    visibilityOf: (path: string) => effectiveVisibility(path, state.rules, state.overrides),
    generation: meaning.generation,
    indexPending,
    ...(options.noteCap === undefined ? {} : { noteCap: options.noteCap }),
  } as unknown as Parameters<typeof meaningPass>[1]);
  return { ...pass, moved: pass.moved || Boolean(synced?.committed) };
}
