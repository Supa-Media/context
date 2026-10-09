/**
 * Joining a workspace through an email domain when its link is opened (Dev2,
 * 2026-10-09, board s4). Who may join is the server's
 * (`apps/convex/functions/workspaceDomains.ts`); this only decides, from the
 * address being opened, whether to ask it.
 */

export interface JoinableWorkspace {
  slug: string;
  name: string;
  domain: string;
}

/** The workspace slug a console address names: `/console/@pw/settings` → `pw`. */
export function slugInPath(pathname: string): string | null {
  const match = /^\/console\/@([^/?#]+)/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]).toLowerCase();
}

/**
 * The workspace to join before drawing `pathname`: the one it names, when this
 * person may join it by domain and is not in it yet. Unknown is never a join.
 */
export function domainJoinFor(
  pathname: string,
  joinable: readonly JoinableWorkspace[] | undefined,
): JoinableWorkspace | null {
  const slug = slugInPath(pathname);
  if (slug === null || joinable === undefined) return null;
  return joinable.find((row) => row.slug.toLowerCase() === slug) ?? null;
}
