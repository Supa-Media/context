/**
 * A group job's reads from a workspace someone in its chat can't open (`packages/tex/gateway/agent/roomCheck.js`;
 * Dev2, 2026-11-26), carried from its answer to its report.
 */
/**
 * The workspaces a group job read that someone in its chat can't open, by slug, and the private notes it read, as
 * `private:<@slug/path or path>` (Dev2, 2026-11-28), read strictly.
 */
export function roomReadOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ok = (entry: unknown): entry is string => typeof entry === "string" && (/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry) || /^private:@?[A-Za-z0-9][^\s]{0,299}$/.test(entry));
  return [...new Set(value.filter(ok))].slice(0, 48);
}
