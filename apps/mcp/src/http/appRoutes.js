/**
 * Routes only the Context app's own clients answer to, each checking its
 * client itself: what the egress gate is holding (`approvals.js`, the
 * console's), and what a card in Messages shows (`cards.js`, the card key's).
 * `route.js` resolves the session for them as it does for `/mcp`, with read
 * scope, and lets each take GET. The Lab's Test Set (`texTestSet.js`) is the
 * third: the console's client, for someone who edits @context-lc. The app's
 * chat with Tex (`agent/appChatRoute.js`) is the fourth: POST, its own check. Tex in a note's comments
 * (`agent/noteRunRoute.js`) is the fifth: a POST run and a GET of the note's log, each with its own check. A data
 * source armed from the app (`data/sync/route.js`) is the sixth: POST, the console's client, an owner or editor.
 */

import { handleApprovals } from "./approvals.js";
import { APP_CHAT_PATH, handleAppChat } from "../../../../packages/tex/gateway/agent/appChatRoute.js";
import { NOTE_RUN_PATH, NOTE_RUNS_READ_PATH, handleNoteRun, handleNoteRuns } from "../../../../packages/tex/gateway/agent/noteRunRoute.js";
import { CARD_PATHS, handleCards } from "./cards.js";
import { TEX_TEST_SET_PATH, handleTexTestSet } from "./texTestSet.js";
import { DATA_SYNC_PATH, handleDataSync } from "../data/sync/route.js";

/** Each takes `(request, store, session, path, env)`. */
export const APP_ROUTES = new Map([
  ["/approvals", handleApprovals],
  ...CARD_PATHS.map((path) => [path, handleCards]),
  // The Lab's Test Set, people only (`texTestSet.js`).
  [TEX_TEST_SET_PATH, (request, _store, session, _path, env) => handleTexTestSet(request, env, session)],
  // The app's chat with Tex, the console's client for its owner (`agent/appChatRoute.js`): POST, which the handler checks.
  [APP_CHAT_PATH, handleAppChat],
  // Tex in a note's comments, the console's client for its owner (`agent/noteRunRoute.js`): a POST run, and the note's log.
  [NOTE_RUN_PATH, handleNoteRun],
  [NOTE_RUNS_READ_PATH, handleNoteRuns],
  // A "Fetch from a URL" source armed, and its last runs, the console's client for an owner or editor (`data/sync/route.js`): POST.
  [DATA_SYNC_PATH, handleDataSync],
]);
