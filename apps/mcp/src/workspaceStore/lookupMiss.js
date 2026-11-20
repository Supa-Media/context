/**
 * Whether the object may answer that nothing is at a path, so the gateway makes a new note there without asking the
 * control plane (`store/objectLookup.js`). The control plane's note-id lookup reads a path through two things the
 * object's rows do not settle on their own, and a path that touches either is left to it:
 *  - a built-in folder's default name (`inbox/...`) reaches whichever folder does that job now
 *    (`apps/convex/functions/lib/nodes/folderJobs.ts` `canonicalJobPath`), unless a root folder has that very name;
 *  - a new note in the Tex folder or a group chat's home is kept in Tex's store, under a key only the control plane
 *    names (`apps/convex/functions/lib/noteIds/texHome.ts` `texHomesFor`).
 * Everything else with no live row is absent, whoever asks: a row the reader may not see is not absent, and stays the
 * control plane's to judge.
 */

import folderRoles from "../../../../packages/shared/src/folderRoles.cjs";
import { isPlumbing } from "../privacy/engine.js";

const { jobOfName } = folderRoles;
const CHAT_HOMES = "tex/groups/";
const fold = (path) => path.normalize("NFC").toLowerCase();

/**
 * `rows` is `workspaceRows(sql)`. True only when no live row is at `path` and nothing above reroutes it.
 *
 * `where` narrows what may reroute, from what is known of this workspace: `chatHomes: false` where its held access set
 * says it does not hold the chat homes (only the pinned workspace does), and `texFolder: false` where the gateway says
 * it is a shared workspace (only a personal one keeps a Tex folder's notes in Tex's store). Unknown is a reroute, as
 * before, and the control plane is asked. Either way the note is placed where the control plane would place it.
 */
export function absentHere(rows, path, { chatHomes = true, texFolder = true } = {}) {
  if (typeof path !== "string" || path === "" || rows.byPath(path) !== null) return false;
  const slash = path.indexOf("/");
  if (slash > 0) {
    const first = path.slice(0, slash);
    if (jobOfName(first) !== null) {
      const root = rows.byPath(first);
      if (root === null || root.kind !== "folder") return false;
    }
  }
  if (chatHomes !== false && fold(path).startsWith(CHAT_HOMES)) return false;
  if (texFolder === false) return true;
  const texFolders = rows.foldersByRole("tex").map((folder) => folder.path);
  const texRoot = rows.byPath("tex");
  if (texRoot !== null && texRoot.kind === "folder") texFolders.push("tex");
  return !texFolders.some((folder) => path.startsWith(`${folder}/`) || fold(path).startsWith(`${fold(folder)}/`));
}

/** A group chat's home folder, as the control plane names it (`textGroupHome.ts`): three words under the chat homes. */
const HOME_FOLDER = /^tex\/groups\/[a-z]+(?:-[a-z]+){2}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/**
 * The Tex owner (`chat:<key>`) a new note at `path` is kept in, for a group chat's own session writing in its own home,
 * or `null`. The control plane names a home's chat from its words (`texHome.ts` `chatKeyOfHome`); a chat's session
 * carries both, read from its grant (`session.js` `sessionForChatHome`, `texChatId`), so the object can place the note
 * without asking. Only in the workspace whose access set seals the chat homes (the pin), only strictly beneath that
 * home, only where the home is a live folder here and the note's own folder exists, and never a plumbing path.
 *
 * `chatHome` is `{folder, chat}` from the gateway. A wrong pair could only place a chat's note in that chat's own
 * object, which is the only Tex object its session may reach (`store/texRouting.js`); who sees the row is still the
 * row's access.
 */
export function chatHomeOwner(rows, path, chatHome, sealsChats) {
  if (sealsChats !== true || !chatHome || typeof chatHome !== "object") return null;
  const { folder, chat } = chatHome;
  if (typeof folder !== "string" || !HOME_FOLDER.test(folder) || typeof chat !== "string" || !CHAT_KEY.test(chat)) return null;
  if (typeof path !== "string" || !path.startsWith(`${folder}/`) || isPlumbing(path)) return null;
  const home = rows.byPath(folder);
  if (home === null || home.kind !== "folder") return null;
  const parent = path.slice(0, path.lastIndexOf("/"));
  const into = parent === folder ? home : rows.byPath(parent);
  if (into === null || into.kind !== "folder") return null;
  return `chat:${chat}`;
}
