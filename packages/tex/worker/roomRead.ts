/**
 * A group job's reads from a workspace someone in its chat can't open (`packages/tex/gateway/agent/roomCheck.js`;
 * Dev2, 2026-11-26), carried from its answer to its report.
 */
/** The workspaces a group job read that someone in its chat can't open, by slug, read strictly. */
export function roomReadOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)))].slice(0, 24);
}
