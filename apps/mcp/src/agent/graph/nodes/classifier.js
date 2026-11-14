/**
 * Classifier node "classifier" (`texConfig.json`): files the new text into the chat's conversation threads after the
 * reply, on Text them's `background` wire, so nobody waits for it (Dev2, 2026-11-12: "Never wait for it"). Its code is
 * `conversationThreads.js` `threadsSortAndWrite`, on the sort `threadedTurn.js` read for this turn.
 */
export async function classifierNode(_input, io) {
  const sorted = await io.ctx.turn.threadsSort();
  return { filed: Array.isArray(sorted) ? sorted.length : 0 };
}
