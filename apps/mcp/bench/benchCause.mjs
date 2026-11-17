// What the bench tells a group turn about why it runs, as production does (Dev2, 2026-11-17).
/**
 * Why a group turn runs, as the texting Worker names it for a text (`apps/agent/src/groupCause.ts` `turnCause`, with
 * `groupWords.ts` `namesTex`): a text that names Tex or Context is a tag, any other reached Tex through the judge. A
 * turn the Worker queues itself is told its own (`byCode.mjs`).
 */
const NAMES_TEX = /(?<![\w-])@?(?:tex|context)(?![\w-])/i;
export function benchCause(texts) {
  return texts.some((text) => NAMES_TEX.test(String(text ?? ""))) ? "tagged" : "judged";
}
