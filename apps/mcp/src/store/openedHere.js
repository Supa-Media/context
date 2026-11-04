/**
 * A store's `ws.open` answer that came back beside its session (`workspaceStore/sessionOpen.js`), held for that one
 * session object and taken once by `objectBinding.js`, so the store is opened without a second trip to the same object.
 * Kept in a WeakMap, never on the session: nothing that spreads, logs or copies a session carries it, and a session made
 * for another context (`sessionForContext`) has none.
 */
const held = new WeakMap();

/** Hold `open` for `session`, when it is an open answer for a workspace and a person. */
export function holdOpened(session, open) {
  if (!session || typeof session !== "object" || !open || typeof open !== "object") return;
  if (typeof open.workspaceId !== "string" || typeof open.userId !== "string") return;
  held.set(session, open);
}

/** Pass a held answer from the control plane's session to the session `resolveSession` built from it. */
export function carryOpened(from, to) {
  const open = held.get(from);
  if (open === undefined) return;
  held.delete(from);
  held.set(to, open);
}

/** The held answer for `session`, once, only for its own workspace and person; `null` otherwise. */
export function takeOpened(session) {
  const open = held.get(session);
  if (open === undefined) return null;
  held.delete(session);
  return open.workspaceId === session.workspaceId && open.userId === session.actorUserId ? open : null;
}
