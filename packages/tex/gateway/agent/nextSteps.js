/**
 * EVERY ERROR SAYS WHAT TO DO NEXT (tool rule 4, Dev2 2026-11-20; `packages/tex/src/toolRules.cjs`), for the gateway's
 * refusals whose words other clients and the isolation tests depend on: Tex's model reads them with the next step
 * added, and every other client keeps the exact words. "not found" stays the same for a hidden note and a missing one
 * (it never says which), so the step added is the same for both.
 */

/** A note read's "not found", bare or with the workspace it was read in (`noteLinks.js`). */
const NOT_FOUND = /^(In @[a-z0-9-]+: )?not found$/;
const NOT_FOUND_NEXT = " Search for it by its words, or fetch its folder (the path up to its last /) to see what is there.";

/** A tool result with its next step added where the gateway's words have none; anything else as it was. */
export function withNextStep(result) {
  if (result?.isError !== true || !Array.isArray(result.content)) return result;
  const content = result.content.map((part) => (part?.type === "text" && typeof part.text === "string" && NOT_FOUND.test(part.text.trim()) ? { ...part, text: `${part.text.trim()}.${NOT_FOUND_NEXT}` } : part));
  return { ...result, content };
}
