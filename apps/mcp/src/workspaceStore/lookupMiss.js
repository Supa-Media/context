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

const { jobOfName } = folderRoles;
const CHAT_HOMES = "tex/groups/";
const fold = (path) => path.normalize("NFC").toLowerCase();

/** `rows` is `workspaceRows(sql)`. True only when no live row is at `path` and nothing above reroutes it. */
export function absentHere(rows, path) {
  if (typeof path !== "string" || path === "" || rows.byPath(path) !== null) return false;
  const slash = path.indexOf("/");
  if (slash > 0) {
    const first = path.slice(0, slash);
    if (jobOfName(first) !== null) {
      const root = rows.byPath(first);
      if (root === null || root.kind !== "folder") return false;
    }
  }
  if (fold(path).startsWith(CHAT_HOMES)) return false;
  const texFolders = rows.foldersByRole("tex").map((folder) => folder.path);
  const texRoot = rows.byPath("tex");
  if (texRoot !== null && texRoot.kind === "folder") texFolders.push("tex");
  return !texFolders.some((folder) => path.startsWith(`${folder}/`) || fold(path).startsWith(`${fold(folder)}/`));
}
