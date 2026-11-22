/**
 * A workspace's former names: the usernames a person changed away from, which stay theirs and keep working
 * (decided by the owner, 2026-11-22; `docs/decisions/identity-and-access/username-changes.md`). Each keeps its row
 * in `names`, pointing at the workspace, so everything that resolves a name through `findName` (websites, short
 * links, capture mail, invitations, shares by name) already reaches the workspace by an old name. What is listed
 * here is for the places that hold a copy of the handle instead: a session's workspace list and a person's reach rows,
 * which the gateway matches `context: "@name"` against (`apps/mcp/src/session.js` `answersTo`).
 */

import type { Doc } from "../../../_generated/dataModel";

type Named = Pick<Doc<"workspaces">, "slug" | "formerSlugs">;

/** The former names, lower-case and without the current one; empty for a workspace never renamed. */
export function aliasesOf(workspace: Named): string[] {
  const current = workspace.slug.toLowerCase();
  return [...new Set((workspace.formerSlugs ?? []).map((name) => name.toLowerCase()))].filter((name) => name !== current);
}

/** `{aliases}` when there are any, else nothing: spread onto a row so a never-renamed workspace's rows are unchanged. */
export function aliasesField(workspace: Named): { aliases?: string[] } {
  const aliases = aliasesOf(workspace);
  return aliases.length > 0 ? { aliases } : {};
}

/** The handle, kind and former names a workspace object keeps for its members' reach rows (`serveMembers.js`). */
export function objectIdentity(workspace: Named & Pick<Doc<"workspaces">, "kind">): { slug: string; kind: string; aliases?: string[] } {
  return { slug: workspace.slug, kind: workspace.kind, ...aliasesField(workspace) };
}
