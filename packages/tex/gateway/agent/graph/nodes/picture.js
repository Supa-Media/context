/**
 * The picture maker step (`texConfig.json`, node `picture`): draws or makes one picture for a texted answer
 * (`agent/pictureMaker.js`). Every picture is looked at by the card node first, through the wire `picture -> card`;
 * with no check in the turn, the maker runs with none, as it does today.
 */

/** @param {{ tool: string, args: object }} input */
export default async function picture({ tool, args }, io) {
  return { result: await io.ctx.maker.call(tool, args, io.ctx.callTool, { check: typeof io.ctx.cardCheck === "function" ? (a) => io.use.card(a) : null }) };
}
