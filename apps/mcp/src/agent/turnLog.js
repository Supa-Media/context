/**
 * What the turn log (`apps/convex/functions/agentTurns.ts`) keeps of a turn's
 * trace, from `route.js`.
 */

/** The router's confidence as the turn log takes it: 0 to 1, or nothing. A number Clef got wrong never costs the turn its log. */
function confidenceOf(entry) {
  const value = entry.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { confidence: Math.min(1, Math.max(0, value)) };
}

/**
 * A trace entry as the turn log takes it (`apps/convex/functions/agentTurns.ts`):
 * kinds, names, numbers and flags, never a word the router or a provider
 * wrote. The router's own word (`pick`) and a fallback's `from` stay in this
 * worker's log line; the status a provider answered is a number and goes, as
 * does the router's confidence in a think pick (a number from 0 to 1).
 */
export function wireTraceEntry(entry) {
  const base = { kind: entry.kind, ok: entry.ok !== false, ms: entry.ms ?? 0 };
  if (entry.kind === "tool") return { ...base, tool: entry.tool, ...(entry.held ? { held: true } : {}) };
  if (entry.kind === "router") return { ...base, tier: entry.tier, model: entry.model, ...confidenceOf(entry) };
  if (entry.kind === "fallback") return { ...base, model: entry.model, ...(typeof entry.status === "number" ? { status: entry.status } : {}) };
  return {
    ...base,
    ...(entry.retried ? { retried: true } : {}),
    ...(entry.cut ? { cut: true } : {}),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
  };
}
