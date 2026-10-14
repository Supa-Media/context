/**
 * The icon picker's suggestion by meaning: fingerprint the name, take the
 * emoji whose fingerprint is closest. One embedding call and one vector
 * search, where Clef took two questions (`functions/emojiMeaning.ts` holds
 * the fingerprints).
 *
 * Fingerprints come from the inference Worker's `/embed` route, over the same
 * secret Clef is reached with, so no credential is opened here (a public
 * action must not reach one: `__tests__/structure`). Only the name's words
 * are sent, as `iconSuggest.ts` sends them to Clef.
 */

import { emojiMeaningSet, nameMeaningText } from "@context/shared/src/emojiMeaning";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import {
  CALLER_HEADER,
  TRANSCRIBE_WORKER_SECRET_ENV_VAR,
  TRANSCRIBE_WORKER_URL_ENV_VAR,
  callerHash,
  isTranscribeWorkerUrlUsable,
} from "../meetings/transcribe";

export type Embed = (texts: string[]) => Promise<number[][]>;

/** The fingerprint size. Must match the Worker's `EMBED_DIMENSIONS`. */
const DIMENSIONS = 1024;

function configured(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Fingerprints through the inference Worker, or `null` on a deployment with
 * none. The returned function throws on any failure or any answer of the
 * wrong shape, never with the texts in the error.
 */
export async function emojiEmbedder(callerKey: string): Promise<Embed | null> {
  const url = configured(TRANSCRIBE_WORKER_URL_ENV_VAR);
  const secret = configured(TRANSCRIBE_WORKER_SECRET_ENV_VAR);
  if (!url || !secret || !isTranscribeWorkerUrlUsable(url)) return null;
  const endpoint = `${url.replace(/\/+$/, "")}/embed`;
  const caller = await callerHash(callerKey, secret);
  return async (texts) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", [CALLER_HEADER]: caller },
      body: JSON.stringify({ texts }),
    });
    if (!response.ok) throw new Error(`embedding refused (${response.status})`);
    const body = (await response.json()) as { vectors?: unknown };
    const vectors = body?.vectors;
    if (
      !Array.isArray(vectors) ||
      vectors.length !== texts.length ||
      !vectors.every((vector) => Array.isArray(vector) && vector.length === DIMENSIONS && vector.every(Number.isFinite))
    ) {
      throw new Error("embedding answer of the wrong shape");
    }
    return vectors as number[][];
  };
}

/**
 * The closest emoji to `path`'s name, or `"unready"` when there is no
 * inference Worker, no ready build to search (the first fill is started here), or
 * the model did not answer: the caller asks Clef instead, so a suggestion is never lost to this.
 */
export async function suggestByMeaning(ctx: ActionCtx, workspaceId: string, path: string): Promise<string | "unready"> {
  const embed = await emojiEmbedder(`emoji:${workspaceId}`);
  if (embed === null) return "unready";
  const set = emojiMeaningSet();
  const state = await ctx.runQuery(internal.functions.emojiMeaning.setState, { set });
  if (state !== "ready") {
    if (await ctx.runMutation(internal.functions.emojiMeaning.claimFill, { set })) {
      await ctx.scheduler.runAfter(0, internal.functions.emojiMeaning.fill, { set });
    }
    return "unready";
  }
  let vector: number[] | undefined;
  try {
    [vector] = await embed([nameMeaningText(path)]);
  } catch {
    // The error never carries the name; Clef answers this one instead.
    return "unready";
  }
  if (vector === undefined) return "unready";
  const [best] = await ctx.vectorSearch("emojiMeanings", "by_vector", {
    vector,
    limit: 1,
    filter: (q) => q.eq("set", set),
  });
  if (best === undefined) return "unready";
  return (await ctx.runQuery(internal.functions.emojiMeaning.charOf, { id: best._id })) ?? "unready";
}
