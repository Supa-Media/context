/**
 * The model ids the features metered here run on, as `aiModelUsage.model` and
 * the price table (`MODEL_USD_PER_MTOK` in `meter.ts`) name them.
 *
 * They live here, in `lib/jev/`, because only this directory may name the
 * models Jev reaches (see the scan in `__tests__/jev.test.ts`). Outside it,
 * import the constants.
 */

/** Jev's `decide`: the Cloudflare model that answers the yes/no questions. */
export const CLEF_MODEL = "@cf/cloudflare/clef";
/** The built-in texting model. */
export const GLM_MODEL = "@cf/zai-org/glm-4.7-flash";
/**
 * The second writing model What changed could ask for. Nothing calls it since
 * that feature was removed (the owner, 2026-10-17); kept so the AI costs
 * report still names and prices the usage rows it left behind.
 */
export const GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/**
 * Meeting summaries' model, as the gateway names it: the Anthropic model the
 * gateway calls for a summary. Priced in `MODEL_USD_PER_MTOK` (`meter.ts`).
 */
export const HAIKU_MODEL = "anthropic/claude-haiku-5-5";
