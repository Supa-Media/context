/**
 * A CHAT'S HOME HAS NO ROW ACCESS OF ITS OWN: THE SEAL IS ITS ACCESS (the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * The control plane draws the seal over `tex/groups` in `@context-lc` and refuses every access change a chat's grant
 * asks for beneath it (`sealedChange`, `apps/convex/functions/lib/nodes/sealedChats.ts`); a row's own base there is
 * dropped anyway. So `write_note` in a home sets no row: before 2026-11-02 it asked to set each new note's row to
 * `team` after its text was in, the control plane refused, the write threw, and no chat's history page was ever
 * reported written (`rowswriterefused` on the pages probe).
 *
 * Only the home's own door marks its store (`http/pinnedDoors.js`), from a session `sessionForChatHome` checked.
 */

export const HOME_PRIVATE_REFUSAL =
  "Not written: this chat's folder is open to the people in the chat and no one else, so a note in it can't be made private. Write it without visibility.";

/** Lay the home's folder on the store its door opened. Not enumerable, so nothing copies it by accident. */
export function markChatHome(store, folder) {
  if (store && typeof folder === "string" && folder !== "") Object.defineProperty(store, "chatHome", { value: folder, enumerable: false, configurable: true });
}

/** Whether `path` is inside the home the store was opened for. */
export function inChatHome(store, path) {
  const home = typeof store?.chatHome === "string" ? store.chatHome.toLowerCase().replace(/\/+$/, "") : "";
  if (home === "" || typeof path !== "string") return false;
  const folded = path.toLowerCase();
  return folded.startsWith(`${home}/`);
}

/**
 * The one change a home's store reports: that a routine in it may have changed, and by whom (`activity/record.js`
 * `announceRoutineChange`), so the control plane scans it and keeps its writer (the owner, 2026-11-02: a chat's
 * routines live in its home; `apps/convex/functions/lib/routines/homes.ts`). Only paths inside this home are sent,
 * and the control plane keeps a writer only if they are one of the chat's people now. Without it a routine written
 * here would be found by the next scan with nobody to run it as.
 */
export function attachHomeRoutineReports(store, session, controlPlane) {
  if (!store || typeof session?.chatHome !== "string" || typeof controlPlane?.reportRoutineChange !== "function") return;
  store.reportRoutineChange = (paths, userId) => {
    const inside = paths.filter((path) => inChatHome(store, path));
    if (inside.length === 0) return Promise.resolve();
    return controlPlane.reportRoutineChange(session.workspaceId, userId, inside).catch(() => {});
  };
}
