/**
 * A FOLDER MOVE ON THE ONE BACKEND THAT HAS FOLDERS.
 *
 * `createFolder` in the control plane writes down the assumption the whole
 * codebase is built on: *"object storage has no folders — a folder is a shared
 * key prefix"*. Delete the last key under `1-projects/old/` on R2 or on S3 and
 * the folder is gone, because it was never anything but those keys.
 *
 * **Dropbox has real directories.** The notes move, the directory stays,
 * `list_folder` goes on reporting it, and `DropboxStore.list` turns it into a
 * `delimitedPrefix` — so the console, Obsidian and Dropbox's own UI go on
 * drawing the folder somebody just moved, next to the one it moved into. A
 * move that leaves its source behind is a copy, and this is how a folder move
 * came to behave like one on exactly one backend.
 *
 * ## Why no suite saw it
 *
 * Every other suite here runs against an S3, in memory. The Dropbox fake was
 * an S3 too in the one respect that mattered — it *derived* folders from keys,
 * so an emptied directory vanished from the fake while it stayed in the
 * product. `createDropboxBackend` now keeps real directories, and this suite
 * is what asks it the question.
 *
 * The first check is deliberately the bug rather than the fix: the notes are
 * at the destination. If that ever fails, nothing below it means anything.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createDropboxBackend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";

const TOKEN_OWNER = `cat_dbxfolders_owner_${"0".repeat(20)}`;
/**
 * A second connection into the same workspace, at `team`.
 *
 * The guard at the end of this suite needs a mover who genuinely cannot see
 * one of the notes — and the owner can see everything, which is what made the
 * first version of that check a fixture proving nothing: the "hidden" note
 * moved with the rest, the folder really was empty, and removing it was right.
 */
const TOKEN_TEAM = `cat_dbxfolders_team_${"0".repeat(21)}`;
/** Dropbox's own short-lived tokens are `sl.`-prefixed. Obviously fake. */
const DROPBOX_TOKEN = "sl.FAKE-folder-move-access-token";

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  2-areas: team\n\nnote_overrides:\n  2-areas/keep/hidden.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

async function callTool(env, name, args = {}, tokenValue = TOKEN_OWNER) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text)?.result;
  } catch {
    return null;
  }
}

export async function runDropboxFolderChecks(check) {
  const previousFetch = globalThis.fetch;
  const dropbox = createDropboxBackend();
  const restoreDropbox = dropbox.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  try {
    controlPlane.addWorkspace("ws_dbx", "dbxfolders", {
      provider: "dropbox",
      accessToken: DROPBOX_TOKEN,
      capabilities: {
        conditionalWrite: true,
        conditionalCreate: true,
        // What a real Dropbox binding probes to: `files/upload` takes a rev as
        // a precondition and there is no conditional delete anywhere in the
        // API, so the move goes through `retireMovedSource`'s substitute.
        conditionalDelete: false,
        serverSideCopy: false,
      },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_OWNER,
      workspaceId: "ws_dbx",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_dbxfolders",
      userId: "user_dbx",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_TEAM,
      workspaceId: "ws_dbx",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_dbxfolders_team",
      userId: "user_dbx_team",
    });

    const files = dropbox.accountFor(DROPBOX_TOKEN);
    files.set("/privacy.md", { body: PRIVACY_MANIFEST, rev: "r0" });

    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

    // Seed legacy Dropbox files directly. A note written through write_note has
    // active collaboration history and must not fall back to Dropbox's
    // non-conditional source retirement during a move.
    files.set("/1-projects/old/a.md", { body: "# A\n", rev: "r-a" });
    files.set("/1-projects/old/deep/b.md", { body: "# B\n", rev: "r-b" });

    const folders = dropbox.foldersFor(DROPBOX_TOKEN);
    check(
      "the fixture has real Dropbox directories, which is what makes this reproducible",
      folders.has("/1-projects/old") && folders.has("/1-projects/old/deep")
    );

    const moved = await callTool(env, "move_folder", {
      source: "1-projects/old",
      destination: "2-areas/old",
    });
    check("the folder move succeeds", !moved?.isError);
    check(
      "the notes are at the destination",
      files.has("/2-areas/old/a.md") && files.has("/2-areas/old/deep/b.md")
    );
    check(
      "...and the old source paths are fenced by content-free retirement markers",
      isLogicalDeleteMarker(files.get("/1-projects/old/a.md")?.body) &&
        isLogicalDeleteMarker(files.get("/1-projects/old/deep/b.md")?.body)
    );

    /*
      Dropbox directories containing generation fences cannot be physically
      deleted: `delete_v2` is recursive and would erase the markers that stop
      a delayed old writer from resurrecting the source. The wrapper hides the
      markers and the directories they alone keep alive, so the folder is gone
      from the product while the storage-level fence remains durable.
    */
    check(
      "the retired source folder remains physically fenced in Dropbox",
      folders.has("/1-projects/old")
    );
    check(
      "...including its nested generation fence",
      folders.has("/1-projects/old/deep")
    );
    check(
      "...and it is gone from what a client lists, which is where it was seen",
      !(await callTool(env, "list_notes", { prefix: "1-projects/" }))?.content?.[0]?.text?.includes(
        "1-projects/old"
      )
    );

    check(
      "the customer's own top-level folder is left alone",
      folders.has("/1-projects")
    );
    check(
      "the destination folders the move built are still there",
      folders.has("/2-areas/old") && folders.has("/2-areas/old/deep")
    );

    /*
      AND THE GUARD: a folder still holding a note is never removed.

      `delete_v2` is recursive and takes no precondition, so the emptiness
      check is the only thing between a tidy-up and somebody's notes. A note
      the mover could not see is exactly the case — `move_folder` filters the
      invisible ones out and leaves them where they are, and the folder holding
      them has to stay with them.
    */
    // `visibility: "team"` explicitly: an owner connection defaults a new note
    // to private, so without it *both* notes are held back and the move has
    // nothing to carry — which is a fixture that proves nothing rather than
    // the case this guard is about.
    // Written by the TEAM connection, which defaults a new note to team. An
    // owner connection defaults one to private, so writing both here would
    // hold both back and leave the move nothing to carry — a fixture proving
    // nothing rather than the case this guard is about.
    files.set("/2-areas/keep/visible.md", { body: "# V\n", rev: "r-v" });
    files.set("/2-areas/keep/hidden.md", { body: "# H\n", rev: "r-h" });

    // Moved by the TEAM connection, which is the only caller for whom the
    // folder does not empty. The owner can see both notes, so for the owner
    // there is nothing left behind and removing the folder is correct.
    const partial = await callTool(
      env,
      "move_folder",
      { source: "2-areas/keep", destination: "2-areas/moved-keep" },
      TOKEN_TEAM
    );
    check("a folder with a note held back still moves what it can", !partial?.isError);
    check(
      "the visible note moved and its old path is only a content-free retirement marker",
      files.has("/2-areas/moved-keep/visible.md") &&
        isLogicalDeleteMarker(files.get("/2-areas/keep/visible.md")?.body)
    );
    check(
      "the folder holding the note left behind is not removed",
      dropbox.foldersFor(DROPBOX_TOKEN).has("/2-areas/keep")
    );
    check(
      "...and the note the mover could not see is untouched",
      files.has("/2-areas/keep/hidden.md")
    );
  } finally {
    restoreControlPlane();
    restoreDropbox();
    globalThis.fetch = previousFetch;
  }
}
