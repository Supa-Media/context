/**
 * A chat's history file: `tex/history.ledger.json` for a person, `tex/groups/<words>/history.ledger.json` for a group
 * chat (`agent/historyFile.js`, which refuses writes to it by this same predicate).
 *
 * The one predicate for both, because two callers judge the same path for opposite reasons and must not drift: the
 * write side refuses it, and the egress ledger marks a read of it untrusted (`privacy/egress.js`) — every word in a
 * chat is somebody else's, as `read_texts` already says, and `fetch` routes this file to `read_note`, so the mark has
 * to follow the path rather than the tool's name.
 *
 * Normalized here rather than by `normalizePath`, which leaves a `@context/` prefix on: an id naming another context's
 * history file is still a chat's history.
 */
// The conversations file beside it is a view of the same chat (`texStore/historyView.js`), judged the same way.
const CHAT_HISTORY_PATH = /(?:^|\/)tex\/(?:groups\/[^/]+\/)?(?:history|conversations)\.ledger\.json$/i;

function isChatHistoryPath(path) {
  if (typeof path !== "string") return false;
  const bare = path
    .trim()
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/^@[^/]*\/+/, "")
    .replace(/\/{2,}/g, "/");
  return CHAT_HISTORY_PATH.test(bare);
}

module.exports = { isChatHistoryPath };
