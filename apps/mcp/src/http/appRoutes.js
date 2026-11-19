/**
 * Routes only the Context app's own clients answer to, each checking its
 * client itself: what the egress gate is holding (`approvals.js`, the
 * console's), and what a card in Messages shows (`cards.js`, the card key's).
 * `route.js` resolves the session for them as it does for `/mcp`, with read
 * scope, and lets each take GET. The Lab's Test Set (`texTestSet.js`) is the
 * third: the console's client, for someone who edits @context-lc. The app's
 * chat with Tex (`agent/appChatRoute.js`) is the fourth: POST, its own check.
 */

import { handleApprovals } from "./approvals.js";
import { APP_CHAT_PATH, handleAppChat } from "../agent/appChatRoute.js";
import { CARD_PATHS, handleCards } from "./cards.js";
import { TEX_TEST_SET_PATH, handleTexTestSet } from "./texTestSet.js";

/** Each takes `(request, store, session, path, env)`. */
export const APP_ROUTES = new Map([
  ["/approvals", handleApprovals],
  ...CARD_PATHS.map((path) => [path, handleCards]),
  // The Lab's Test Set, people only (`texTestSet.js`).
  [TEX_TEST_SET_PATH, (request, _store, session, _path, env) => handleTexTestSet(request, env, session)],
  // The app's chat with Tex, the console's client for its owner (`agent/appChatRoute.js`): POST, which the handler checks.
  [APP_CHAT_PATH, handleAppChat],
]);
