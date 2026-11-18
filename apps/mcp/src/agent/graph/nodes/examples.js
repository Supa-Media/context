/**
 * The examples node: the Training moments nearest to a text, for the front door's preamble (`packages/shared/src/texExamples.cjs`).
 * It embeds the text with the same model as meaning search (`search/meaning/embed.js`), reads the nearest moments from the
 * Tex-owned index bound as `TEX_EXAMPLES`, and drops every moment of the scored conversation (`candidates`). A wire from the
 * front door (`fd -> examples`, `uses`) is what turns it on; with no index bound, or any failure, it answers
 * `fallback` and the front door keeps its fixed examples. It never throws.
 *
 * Input `{ question, recent }`: the text and its recent history as plain lines. Output `{ when: ["found"], ids, text, ms }`
 * or `{ when: ["fallback"], why, ms }`.
 */
import { bindingEmbedder } from "../../../search/meaning/embed.js";
import { TRAINING } from "../../texConfig.js";
import { EXAMPLES_K, candidates, exampleId, nearText, pickNearest, queryEmbedText } from "../../../../../../packages/shared/src/texExamples.cjs";

/** The index's own cap on how many matches it returns; the candidates left after self-exclusion are what the front door reads. */
const EXTRA_MATCHES = 20;
const MAX_TOP_K = 50;

export async function examplesNode(input, io) {
  const started = Date.now();
  const ms = () => Date.now() - started;
  // The turn's graph hands nodes the turn (`turnGraph.js`: ctx.turn, its env on it); a node run alone may carry env itself.
  const env = io?.ctx?.turn?.env ?? io?.ctx?.env ?? io?.env ?? null;
  const index = env?.TEX_EXAMPLES ?? null;
  if (!index || typeof index.query !== "function") return { when: ["fallback"], why: "no index", ms: ms() };
  try {
    // An index that brings its own embedder (the bench's in-memory index, `bench/texExamplesIndex.mjs`) is asked directly;
    // a Vectorize binding has none, so production reads the model through the binding as it always has.
    const embed = typeof index.embed === "function" ? (texts) => index.embed(texts) : bindingEmbedder(env.AI);
    if (embed === null) return { when: ["fallback"], why: "no model", ms: ms() };
    const [vector] = await embed([queryEmbedText(input?.question, input?.recent)]);
    const res = await index.query(vector, { topK: Math.min(EXAMPLES_K + EXTRA_MATCHES, MAX_TOP_K), returnValues: false, returnMetadata: "none" });
    const moments = pickNearest(res?.matches ?? [], candidates(TRAINING, globalThis.process?.env), EXAMPLES_K);
    if (moments.length === 0) return { when: ["fallback"], why: "none", ms: ms() };
    return { when: ["found"], ids: moments.map(exampleId), text: nearText(moments), ms: ms() };
  } catch (error) {
    // The failure's name only: a model or index error can quote the text it was given, which is the person's.
    return { when: ["fallback"], why: `error:${typeof error?.name === "string" ? error.name : "error"}`, ms: ms() };
  }
}
