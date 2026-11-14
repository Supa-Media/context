/**
 * The card check step (`texConfig.json`, node `card`): a small model looks at one picture before it may go to the
 * person (`agent/cardCheck.js`). The check is the turn's, handed in as `ctx.cardCheck` by `prepareTheAnswer`.
 */

/**
 * @param {{ tool: string, template: string, picture: { data: string, mediaType: string }, unpinned: number[] }} input
 * @returns {Promise<{ send: boolean, critique: string }>} a check that could not run reads as send, as the maker reads a null verdict
 */
export default async function card(input, io) {
  if (typeof io.ctx.cardCheck !== "function") throw new Error("card: no card check in this turn");
  const verdict = await io.ctx.cardCheck(input);
  return verdict === null || verdict === undefined ? { send: true, critique: "" } : { send: verdict.send === true, critique: typeof verdict.critique === "string" ? verdict.critique : "" };
}
