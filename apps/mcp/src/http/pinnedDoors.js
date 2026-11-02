/**
 * The two doors a Tex turn has into the pin it may not otherwise address
 * (`session.js`): `openPinnedSetup`, for every Tex turn, to read Tex's setup
 * through the control plane's setup read (`agent/production.js`,
 * docs/decisions/texting-assistant/setup-read.md), and `openChatHome`, for a
 * group chat, to keep the chat's memory in its home there and nowhere else
 * (`agent/chatHome.js`). Each answers
 * `{ session, store }`, and is attached only when the grant carries it.
 *
 * Each door opens at most once per request (a turn reads its setup and home
 * more than once). The two are never shared: they open the same workspace
 * under different sessions, each clamped for its own purpose.
 */
import { sessionForChatHome, sessionForSetup } from "../session.js";
import { markChatHome } from "../agent/chatHomeSeal.js";

export function attachPinnedDoors(store, session, openStore, equipDoor = () => {}) {
  const setupSession = sessionForSetup(session);
  if (setupSession !== null) store.openPinnedSetup = door(setupSession, openStore, equipDoor);
  const homeSession = sessionForChatHome(session);
  if (homeSession !== null) {
    store.openChatHome = door(homeSession, openStore, (opened, doorSession) => {
      equipDoor(opened, doorSession);
      markChatHome(opened, doorSession.chatHome); // the seal is its access: no row is set there (`agent/chatHomeSeal.js`)
    });
  }
}

/**
 * One door: its session's store, opened once and held; a failed open is forgotten. `equipDoor(store, session)` lays
 * the control plane's calls on it for the door's own session (`routing.js` `attachLinkCalls`): without its tree
 * manifest every listing in the home was refused as "this workspace's file list could not be read", so no chat's
 * history page could be written there (2026-11-02).
 */
function door(doorSession, openStore, equipDoor) {
  let opening = null;
  return () => {
    if (opening === null) {
      const started = openStore(doorSession).then((opened) => {
        equipDoor(opened, doorSession);
        return { session: doorSession, store: opened };
      });
      opening = started;
      started.catch(() => {
        if (opening === started) opening = null;
      });
    }
    return opening;
  };
}
