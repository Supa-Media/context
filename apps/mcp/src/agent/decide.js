/**
 * Clef, Cloudflare's decision model, for the agent's computer.
 *
 * Clef never writes text: it answers yes/no (`noul`), picks one of the options
 * it was given (`choice`) or places text on a scale (`score`), in tens of
 * milliseconds. The agent uses it for the small choices that would otherwise
 * cost a whole round of the writing model; see `computer.js`. It reads,
 * stores and trains on nothing it is sent, the same seam as auto-organize
 * (`infra/transcribe-worker/src/decide.ts`, docs/decisions/storage-and-credentials/inference.md).
 *
 * Only a built-in turn uses it, because only a built-in turn is metered: what
 * it reads is reported as `decisionTokens` and priced at Clef's rate.
 */

export const DECISION_MODEL = "@cf/cloudflare/clef";
const DECISION_MODEL_SELECTOR = "clef";

/** The most of a turn's pages Clef reads at once, in characters. */
export const MAX_DECISION_STATE_CHARS = 24_000;

/**
 * `(state, questions) => answers | null` over a Workers AI binding, or null
 * when there is none. Never throws: a decision that fails is no decision.
 */
export function decisionEngine(ai) {
  if (typeof ai?.run !== "function") return null;
  return async (state, questions) => {
    try {
      const raw = await ai.run(DECISION_MODEL, {
        model: DECISION_MODEL_SELECTOR,
        state: state.slice(0, MAX_DECISION_STATE_CHARS),
        questions,
      });
      return raw && typeof raw === "object" && raw.answers && typeof raw.answers === "object" ? raw.answers : null;
    } catch {
      return null;
    }
  };
}

/** What a decision costs to read, in tokens: four characters a token. */
export function decisionTokens(state, questions) {
  return Math.ceil((Math.min(state.length, MAX_DECISION_STATE_CHARS) + JSON.stringify(questions).length) / 4);
}
