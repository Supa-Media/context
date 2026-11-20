/**
 * Fallback node "fallback" (`texConfig.json`): the front door's model failed after its retry, and the turn goes on, once,
 * on the setup's fallback model (`builtin.js`; `readTheSetup.js` picks it, by the model that failed for a turn with a
 * picture). Its output is the model the rest of the turn runs on; `null` keeps the failure.
 */
export async function fallbackNode(input, io) {
  const spec = io.ctx.turn.toolCalls.fallback;
  const model = typeof spec === "function" ? spec(input.from) : spec;
  return { model: typeof model === "string" ? model : (model ?? null) };
}
