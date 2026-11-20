/**
 * Whether the object may answer that nothing is at a path, so the gateway makes a new note there without asking the
 * control plane (`store/objectLookup.js`). The control plane's note-id lookup reads a path through two things the
 * object's rows do not settle on their own, and a path that touches either is left to it:
 *  - a built-in folder's default name (`inbox/...`) reaches whichever folder does that job now
 *    (`apps/convex/functions/lib/nodes/folderJobs.ts` `canonicalJobPath`), unless a root folder has that very name;
 *  - a new note in the Tex folder or a group chat's home is kept in Tex's store (`apps/convex/functions/lib/noteIds/
 *    texHome.ts` `texHomesFor`); the object places it itself where it can tell (`texHomeOwner` below).
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
const HOME_WORDS = /^[a-z]+(?:-[a-z]+){2}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/**
 * The Tex folder of a personal workspace, as `texHome.ts` `texFolderPath` names it: the one live folder doing the
 * `tex` job, else a root `tex` folder doing none. `null` where there is none, or where two folders do the job (the
 * control plane picks one by its own index order, so the object leaves that to it).
 */
function texFolderOf(rows) {
  const doing = rows.foldersByRole("tex");
  if (doing.length > 1) return undefined;
  if (doing.length === 1) return doing[0].path;
  const root = rows.byPath("tex");
  return root !== null && root.kind === "folder" && !root.role ? "tex" : null;
}

/**
 * The Tex owner a new note at `path` is kept in (`person:<workspaceId>` or `chat:<key>`), placed by the object the way
 * the control plane places it (`apps/convex/functions/lib/noteIds/texHome.ts` `texHomesFor`), or `null` when the path
 * is no Tex home here or the object cannot tell (then the control plane is asked, as before):
 *  - in a personal workspace (`workspaceKind` from the gateway's session), a note beneath its Tex folder is its
 *    person's;
 *  - in the workspace that seals the chat homes (the pin), a note beneath a home `tex/groups/<words>/` is that
 *    chat's, by the key its words name: the access set's `chatHomes` (words to key, sent by the control plane), or
 *    the chat's own session's `{folder, chat}` from its grant. Where both are known and differ, nothing is placed.
 * Only a path with no live row, and never plumbing. Folders beneath the Tex folder or the home that do not stand yet
 * are stood up by the adoption (`writeOps.js` `adopt`), as for any new note.
 *
 * @param {{workspaceId?: string, workspaceKind?: string|null, sealsChats?: boolean|null, chatHomes?: Record<string,string>|null, chatHome?: {folder: string, chat: string}|null}} where
 */
export function texHomeOwner(rows, path, { workspaceId = null, workspaceKind = null, sealsChats = null, chatHomes = null, chatHome = null } = {}) {
  if (typeof path !== "string" || path === "" || isPlumbing(path)) return null;
  // Neither a personal workspace nor a path under the pin's chat homes: no Tex home here, nothing read.
  if (workspaceKind !== "personal" && !(sealsChats === true && path.startsWith(CHAT_HOMES))) return null;
  if (rows.byPath(path) !== null) return null;
  if (workspaceKind === "personal") {
    const folder = texFolderOf(rows);
    if (typeof folder !== "string" || !path.startsWith(`${folder}/`)) return null;
    return typeof workspaceId === "string" && workspaceId !== "" ? `person:${workspaceId}` : null;
  }
  if (sealsChats !== true || !path.startsWith(CHAT_HOMES)) return null;
  const [words, ...inside] = path.slice(CHAT_HOMES.length).split("/");
  if (!HOME_WORDS.test(words ?? "") || inside.length === 0) return null;
  const held = chatHomes && typeof chatHomes === "object" && Object.hasOwn(chatHomes, words) && CHAT_KEY.test(chatHomes[words]) ? chatHomes[words] : null;
  const own = chatHome && chatHome.folder === `${CHAT_HOMES}${words}` && CHAT_KEY.test(chatHome.chat ?? "") ? chatHome.chat : null;
  if (held !== null && own !== null && held !== own) return null;
  const chat = held ?? own;
  return chat === null ? null : `chat:${chat}`;
}

/**
 * Whether a new note at `path` in the pin is a plain note, by the control plane's own placing: under the chat homes,
 * but in no home its access set names a key for (`chatKeyOfHome` answers none there too: no chat has those words, or
 * two do), so it is kept as any other note. Only where the set carries the map (`chatHomes` not null); without it, the
 * control plane is asked. `rows` must already hold no row at the path.
 */
export function plainUnderHomes(path, { sealsChats = null, chatHomes = null } = {}) {
  if (sealsChats !== true || chatHomes === null || typeof chatHomes !== "object" || typeof path !== "string" || !path.startsWith(CHAT_HOMES)) return false;
  if (isPlumbing(path)) return false;
  const [words, ...inside] = path.slice(CHAT_HOMES.length).split("/");
  if (inside.length === 0 || !HOME_WORDS.test(words ?? "")) return true;
  return !Object.hasOwn(chatHomes, words);
}

/**
 * A group chat's own session making a note in its own home: `texHomeOwner` with only what the chat's grant carries.
 * Kept for the callers that know nothing else.
 */
export function chatHomeOwner(rows, path, chatHome, sealsChats) {
  if (!chatHome || typeof chatHome !== "object" || typeof chatHome.folder !== "string" || !path?.startsWith?.(`${chatHome.folder}/`)) return null;
  return texHomeOwner(rows, path, { sealsChats, chatHome });
}
