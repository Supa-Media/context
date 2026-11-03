/**
 * Whether a workspace's object serves its file tree right now, as the live tree
 * learned it from the object's socket (`useLiveTree`, `objectTree.ts`).
 *
 * A module-level store rather than state: file actions read it when they run,
 * not when they render, and must see the answer the socket gave most recently
 * whichever component asks. `useLiveTree` writes it when the object says it
 * serves or stops serving, and when its socket is closed (offline, unmount,
 * workspace change), which reads as not served.
 */
const serving = new Set<string>();

export function setObjectServes(workspaceId: string, served: boolean): void {
  if (served) serving.add(workspaceId);
  else serving.delete(workspaceId);
}

export function objectServes(workspaceId: string): boolean {
  return serving.has(workspaceId);
}
