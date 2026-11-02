/**
 * The two doors a group chat's turn has into the pin it may not otherwise
 * address (`session.js`): `openPinnedSetup`, to read Tex's setup
 * (`agent/production.js`), and `openChatHome`, to keep the chat's memory in
 * its home there and nowhere else (`agent/chatHome.js`). Each answers
 * `{ session, store }`, and is attached only when the grant carries it.
 *
 * Each door opens at most once per request (a turn reads its setup and home
 * more than once). The two are never shared: they open the same workspace
 * under different sessions, each clamped for its own purpose.
 */
import { sessionForChatHome, sessionForSetup } from "../session.js";

export function attachPinnedDoors(store, session, openStore) {
  const setupSession = sessionForSetup(session);
  if (setupSession !== null) store.openPinnedSetup = door(setupSession, openStore);
  const homeSession = sessionForChatHome(session);
  if (homeSession !== null) store.openChatHome = door(homeSession, openStore);
}

/** One door: its session's store, opened once and held; a failed open is forgotten. */
function door(doorSession, openStore) {
  let opening = null;
  return () => {
    if (opening === null) {
      const started = openStore(doorSession).then((opened) => ({ session: doorSession, store: opened }));
      opening = started;
      started.catch(() => {
        if (opening === started) opening = null;
      });
    }
    return opening;
  };
}
