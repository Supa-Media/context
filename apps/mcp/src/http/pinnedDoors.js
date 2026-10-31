/**
 * The two doors a group chat's turn has into the pin it may not otherwise
 * address (`session.js`): `openPinnedSetup`, to read Tex's setup
 * (`agent/production.js`), and `openChatHome`, to keep the chat's memory in
 * its home there and nowhere else (`agent/chatHome.js`). Each answers
 * `{ session, store }`, and is attached only when the grant carries it.
 */
import { attachChangeReporters } from "../controlPlane/changeReporters.js";
import { sessionForChatHome, sessionForSetup } from "../session.js";

export function attachPinnedDoors(store, session, openStore, controlPlane = null) {
  const setupSession = sessionForSetup(session);
  if (setupSession !== null) store.openPinnedSetup = async () => ({ session: setupSession, store: await openStore(setupSession) });
  const homeSession = sessionForChatHome(session);
  if (homeSession === null) return;
  store.openChatHome = async () => {
    const opened = await openStore(homeSession);
    // A home's writes report as any write in the pin does: its tree, its activity, and its routines (`lib/routines/homes.ts`).
    if (controlPlane !== null) attachChangeReporters(opened, homeSession.workspaceId, controlPlane);
    return { session: homeSession, store: opened };
  };
}
