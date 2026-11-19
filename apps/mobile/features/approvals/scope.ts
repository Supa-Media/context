/**
 * Which contexts the approvals in the Tex chat are listed from.
 *
 * The pinned context (`@context-lc`) is reach, not membership: every account can
 * open it, but nothing can be held there for this person. The control plane
 * refuses to mint a console grant for it, by design (`apps/convex/functions/lib/pinnedContext.ts`).
 * Asking it made every listing fail for an account with nothing waiting
 * (google-review account, 2026-11-19), so it is left out of both the list and
 * the shown workspace.
 */
export function approvalsScope(
  contexts: ReadonlyArray<{ id: string; pinned?: boolean }>,
  selectedId: string | null,
): { workspaceId: string | null; workspaceIds: string[] } {
  const workspaceIds = contexts.filter((c) => c.pinned !== true).map((c) => c.id);
  const selectedIsPinned =
    selectedId === null || contexts.some((c) => c.id === selectedId && c.pinned === true);
  const workspaceId = selectedIsPinned ? (workspaceIds[0] ?? null) : selectedId;
  return { workspaceId, workspaceIds };
}
