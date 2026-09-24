/**
 * Dropbox is the one backend with real directories: a folder move that reads
 * as a copy, and the emptiness guard for removeEmptyFolder/pruneEmptyFolders.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { R2Store, pruneEmptyFolders, dropbox, dbxJson } from "./fixtures.mjs";

export async function runStoreDropboxFolderChecks(check) {
  /* ---------------- the one backend that has real folders ----------------- */

  /**
   * A Dropbox that behaves like Dropbox about **directories**, which is the
   * one thing the fakes above deliberately did not model.
   *
   * Every other adapter here is built on the sentence `createFolder` writes
   * down: object storage has no folders, a folder is a shared key prefix, and
   * deleting the last key under one removes it because it was never anything
   * else. Dropbox has real directories — so the files move, the directory
   * stays, `list_folder` goes on reporting it, and the folder somebody moved
   * is still sitting beside the one it moved into.
   *
   * That is a folder move that reads as a **copy**, on exactly one backend,
   * which is how it went unnoticed: the in-memory store every other suite runs
   * against is an S3, and an S3 cannot reproduce it.
   */
  function dropboxWithFolders(seed = []) {
    const files = new Map(seed.map((path) => [path, { rev: "r1" }]));
    const folders = new Set();
    for (const path of files.keys()) {
      const parts = path.replace(/^\//, "").split("/").slice(0, -1);
      for (let end = 1; end <= parts.length; end += 1) {
        folders.add(`/${parts.slice(0, end).join("/")}`);
      }
    }
    const store = dropbox(async (call) => {
      const url = String(call.url);
      const arg = call.headers?.["Dropbox-API-Arg"];
      const body = arg ? JSON.parse(arg) : JSON.parse(call.body || "{}");
      if (url.includes("/files/list_folder")) {
        const prefix = body.path === "" ? "" : `${body.path}/`;
        const entries = [];
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue;
          if (!body.recursive && path.slice(prefix.length).includes("/")) continue;
          entries.push({
            ".tag": "file",
            path_display: path,
            size: 1,
            server_modified: "2026-09-01T10:00:00Z",
            rev: "r1",
          });
        }
        for (const path of folders) {
          if (path === body.path || !path.startsWith(prefix)) continue;
          if (!body.recursive && path.slice(prefix.length).includes("/")) continue;
          entries.push({ ".tag": "folder", path_display: path });
        }
        return dbxJson({ entries, has_more: false });
      }
      if (url.includes("/files/delete")) {
        // Dropbox deletes a folder recursively, which is exactly why the
        // adapter has to establish emptiness before it asks.
        let removed = files.delete(body.path);
        if (folders.delete(body.path)) removed = true;
        for (const path of [...files.keys()]) {
          if (path.startsWith(`${body.path}/`)) {
            files.delete(path);
            removed = true;
          }
        }
        if (!removed) {
          return dbxJson(
            {
              error_summary: "path_lookup/not_found/..",
              error: { ".tag": "path_lookup", path_lookup: { ".tag": "not_found" } },
            },
            409
          );
        }
        return dbxJson({});
      }
      return dbxJson({ rev: "r1" });
    });
    return { store, files, folders };
  }

  {
    const { store, folders } = dropboxWithFolders(["/1-projects/old/a.md"]);
    // The move has already carried the note away, exactly as `toolMoveFolder`
    // leaves things before it tidies up.
    await store.delete("1-projects/old/a.md");
    check(
      "the emptied directory is still there, which is the bug in one line",
      folders.has("/1-projects/old")
    );
    check(
      "...and still listed, so the console draws a folder somebody moved",
      (await store.list({ prefix: "1-projects/", delimiter: "/" })).delimitedPrefixes.includes(
        "1-projects/old/"
      )
    );

    check("an emptied folder is removed", (await store.removeEmptyFolder("1-projects/old")) === true);
    check("...and is gone from the listing", !folders.has("/1-projects/old"));
  }

  {
    // The guard, and the one that matters: `delete_v2` is recursive and has no
    // precondition, so emptiness is the only thing standing between a tidy-up
    // and somebody's notes. A note this caller could not see is still a note.
    const { store, files } = dropboxWithFolders(["/1-projects/old/private.md"]);
    check(
      "a folder that still holds anything is left alone",
      (await store.removeEmptyFolder("1-projects/old")) === false
    );
    check("...and nothing in it was touched", files.has("/1-projects/old/private.md"));
  }

  {
    // Recursive, so a folder whose only child is a folder holding a note is
    // refused rather than flattened.
    const { store, files } = dropboxWithFolders(["/1-projects/old/deep/kept.md"]);
    check(
      "a folder holding only a non-empty subfolder is left alone",
      (await store.removeEmptyFolder("1-projects/old")) === false
    );
    check("...and the note under it survives", files.has("/1-projects/old/deep/kept.md"));
  }

  {
    const { store } = dropboxWithFolders(["/1-projects/a.md"]);
    check(
      "the root is never a candidate, whatever is passed",
      (await store.removeEmptyFolder("")) === false &&
        (await store.removeEmptyFolder("/")) === false
    );
  }

  {
    // The whole tree in one pass, deepest first, which is what a folder move
    // needs: `old/deep` empties, and only then does `old`.
    const { store, folders } = dropboxWithFolders([
      "/1-projects/old/a.md",
      "/1-projects/old/deep/b.md",
    ]);
    await store.delete("1-projects/old/a.md");
    await store.delete("1-projects/old/deep/b.md");
    const removed = await pruneEmptyFolders(
      store,
      ["1-projects/old/a.md", "1-projects/old/deep/b.md"],
      { roots: ["1-projects/old"], keep: ["2-areas/old"] }
    );
    check(
      "a folder move's whole emptied tree goes, child before parent",
      removed.includes("1-projects/old/deep") && removed.includes("1-projects/old")
    );
    check("...and the customer's own top-level folder stays", folders.has("/1-projects"));
  }

  {
    /*
      `keep` is about a move INSIDE one tree, which is the only shape where the
      destination can turn up as a candidate at all.

      `1-projects/a/b` → `1-projects/a/c` empties `b`, and the walk up from
      `b`'s keys reaches `1-projects/a` — which is holding the folder the move
      just built. The adapter's own listing refuses it, and `keep` is the guard
      that does not depend on a listing taken a moment later.

      Written against a fake that reports `1-projects/a` as empty precisely so
      the listing cannot be what saves it: without `keep`, this removes the
      parent of the move's own destination.
    */
    const { store, folders } = dropboxWithFolders(["/1-projects/a/b/note.md"]);
    await store.delete("1-projects/a/b/note.md");
    folders.delete("/1-projects/a/b");
    const removed = await pruneEmptyFolders(store, ["1-projects/a/b/note.md"], {
      roots: ["1-projects/a/b"],
      keep: ["1-projects/a/c"],
    });
    check(
      "the folder holding the move's own destination is kept, listing or no listing",
      !removed.includes("1-projects/a") && folders.has("/1-projects/a")
    );
  }

  {
    // A backend with no folders has nothing to remove, and says so by not
    // having the method — checked rather than assumed, because a no-op on
    // every adapter is the shape that hides the next difference between them.
    check(
      "the adapters without folders do not implement the method",
      typeof new R2Store({}).removeEmptyFolder !== "function"
    );
    check(
      "...and pruning is a no-op against them rather than a throw",
      (await pruneEmptyFolders(new R2Store({}), ["1-projects/old/a.md"])).length === 0
    );
  }

}
