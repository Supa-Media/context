/**
 * Big-ask planner node "planner" (`texConfig.json`): the front door's plan call (`planBigAsk.js` `planCall`), through
 * its `uses` wire, which asks the advisor to split a big ask into jobs and writes their notes. Off in the config, so
 * live Tex's setup offers no plan call (`texConfig.js`: `plan_big_asks` only when this node is on).
 */
export async function plannerNode(_input, io) {
  const calls = io.ctx.turn.toolCalls;
  const result = await calls.planner(calls.plannerArgs, calls.plannerTools);
  calls.plannerResult = result;
  return { failed: result?.isError === true };
}
