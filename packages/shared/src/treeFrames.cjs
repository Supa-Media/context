/**
 * The app's live file tree socket (`GET /presence/tree` on the gateway, answered by the
 * workspace's object: `apps/mcp/src/workspaceStore/treeSockets.js`). Both
 * sides read their frames through this file, so neither can drift.
 *
 * Client to object:
 *   {t: "watch", folders: string[]}   the folders to keep live, at most TREE_WATCH_MAX
 *   {t: "ping"}
 * Object to client:
 *   {t: "listing", folder, page}      one folder at the socket's clearance (FolderListing)
 *   {t: "not_served"}                 this workspace's tree is not read from its object: use Convex
 *   {t: "pong"}
 *
 * The socket closes with TREE_CLOSE_REAUTH when the grant it opened on needs
 * checking again, and the client reconnects with a fresh grant.
 */

const TREE_PROTOCOL = "context.tree";
/**
 * The socket's path on the gateway. Under `/presence`, whose first segment is
 * reserved (`apps/mcp/src/workspacePath.js`): a bare `/tree` read as "the
 * workspace called tree" and answered 404 in production (2026-11-01).
 */
const TREE_SOCKET_PATH = "/presence/tree";
/** Folders one socket watches: the same bound as `LIVE_FOLDERS` in the app. */
const TREE_WATCH_MAX = 40;
/** The longest a tree socket stays open before its grant is checked again. */
const TREE_SOCKET_MAX_MS = 5 * 60_000;
const TREE_CLOSE_REAUTH = 4001;
const TREE_CLOSE_NOT_SERVED = 4404;
const MAX_FRAME_BYTES = 64 * 1024;

function folderOk(folder) {
  return typeof folder === "string" && folder.length <= 1024 && !folder.includes("\0");
}

/** A client frame as the object reads it, or null when it is not one. */
function decodeClientFrame(raw) {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) return null;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  if (frame.t === "ping") return { t: "ping" };
  if (frame.t === "watch") {
    if (!Array.isArray(frame.folders) || frame.folders.length > TREE_WATCH_MAX || !frame.folders.every(folderOk)) return null;
    return { t: "watch", folders: [...new Set(frame.folders)] };
  }
  return null;
}

/** An object frame as the app reads it, or null when it is not one. */
function decodeServerFrame(raw) {
  if (typeof raw !== "string") return null;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  if (frame.t === "pong" || frame.t === "not_served") return { t: frame.t };
  if (frame.t === "listing" && folderOk(frame.folder) && frame.page && typeof frame.page === "object" && Array.isArray(frame.page.entries)) {
    return { t: "listing", folder: frame.folder, page: frame.page };
  }
  return null;
}

const watchFrame = (folders) => JSON.stringify({ t: "watch", folders: [...folders].slice(0, TREE_WATCH_MAX) });
const pingFrame = () => JSON.stringify({ t: "ping" });
const listingFrame = (folder, page) => JSON.stringify({ t: "listing", folder, page });
const notServedFrame = () => JSON.stringify({ t: "not_served" });
const pongFrame = () => JSON.stringify({ t: "pong" });

module.exports = {
  TREE_PROTOCOL,
  TREE_SOCKET_PATH,
  TREE_WATCH_MAX,
  TREE_SOCKET_MAX_MS,
  TREE_CLOSE_REAUTH,
  TREE_CLOSE_NOT_SERVED,
  decodeClientFrame,
  decodeServerFrame,
  watchFrame,
  pingFrame,
  listingFrame,
  notServedFrame,
  pongFrame,
};
