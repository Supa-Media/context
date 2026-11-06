/** What a benchmark turn's trace says (`src/agent/turnLog.js`): its model rounds and a failed round's status (`world.mjs`). */

/** How many model rounds each model ran, from the turn log's trace (`turn.js` records it per round). */
export const roundsOf = (trace) => {
  const rounds = {};
  for (const entry of trace ?? []) if (entry.kind === "model" && entry.ok !== false && typeof entry.model === "string") rounds[entry.model] = (rounds[entry.model] ?? 0) + 1;
  return rounds;
};
/** The status the failed round got, from the turn log's trace; null when none. */
export const failedStatus = (trace) => {
  const failed = (trace ?? []).find((entry) => entry.kind === "model" && entry.ok === false);
  return typeof failed?.status === "number" ? failed.status : null;
};

