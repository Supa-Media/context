import { Directory, File, Paths } from "expo-file-system";
import type { CacheScope } from "./keys";
import { bodyFileName, segmentName, segmentValue } from "./mirrorPath";
import { guardMirror, type MirrorRoot, type MirrorSlot, type MirrorStore } from "./mirrorStoreCore";

/**
 * The mirror's storage — native: one file per note body.
 *
 * ```
 * <document>/context-offline/v1/<scope>/<workspaceId>/index.json
 * <document>/context-offline/v1/<scope>/<workspaceId>/current/<encoded path>
 * <document>/context-offline/v1/<scope>/<workspaceId>/base/<encoded path>
 * ```
 *
 * **The document directory, not the cache directory.** The cache directory is
 * the OS's to empty under storage pressure, silently, and a mirror that
 * vanishes on a train is exactly the failure this feature exists to remove.
 * The copies are still disposable derivatives (non-negotiable #3) — every one
 * is rebuilt by the next sync — but *we* decide when they go: sign-out, leaving,
 * losing a context, and the prune after a complete sync. The document
 * directory is included in device backups by default, as `AsyncStorage`'s
 * store already is; nothing here is a credential.
 *
 * **Every segment is encoded** (`mirrorPath.ts`), and that is the security
 * property of this file: a bucket key is untrusted input, and `..` in one must
 * not become a directory climb. `expo-file-system`'s `Paths.join` escapes `%`
 * in a segment before the native side decodes the URI once, so the name on
 * disk is exactly the encoded name, `%` and all.
 *
 * **`expo-file-system` is `core`** in `native-deps.json`, so this is a static
 * import with no `NativeModules` gate and no `runtimeVersion` bump —
 * `features/meetings/capture/audio.ts` already uses the same `File`/`Directory`
 * API on every build.
 *
 * **No directory listing decides what a file *is*.** A listed entry comes back
 * with a URI the native side built, whose escaping need not match the one the
 * JS side builds, so comparing names from a listing against `bodyFileName` is a
 * comparison that could come out "nothing matches" on one platform — and a
 * prune that believed it would delete every body. Bodies are therefore removed
 * by name, from the index's own diff. The one listing here is `roots()`, whose
 * names are scopes and Convex ids: letters and digits, which no escaping
 * changes. A body orphaned by a crash between its write and the index write is
 * unreachable (every read goes through the index) and goes with its workspace.
 */

const ROOT_NAME = ["context-offline", "v1"] as const;

const SCOPES: readonly CacheScope[] = ["private", "team"];

function root(): Directory {
  return new Directory(Paths.document, ...ROOT_NAME);
}

function workspaceDir(scope: CacheScope, workspaceId: string): Directory {
  return new Directory(root(), segmentName(scope), segmentName(workspaceId));
}

function slotDir(scope: CacheScope, workspaceId: string, slot: MirrorSlot): Directory {
  return new Directory(workspaceDir(scope, workspaceId), slot);
}

function ensure(directory: Directory): void {
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
}

async function readText(file: File): Promise<string | null> {
  try {
    if (!file.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

function removeIfThere(entry: File | Directory): void {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // A file that will not go is caught by the verification that follows every
    // clear (`forget.ts`), which is where "left behind" is reported.
  }
}

function decodedName(name: string): string | null {
  // The native side may hand the name back URI-escaped; scope names and Convex
  // ids are letters and digits either way, so decoding is harmless when it is
  // not needed.
  let plain = name;
  try {
    plain = decodeURIComponent(name);
  } catch {
    return null;
  }
  return segmentValue(plain);
}

/** The raw file store, guarded. Exported for its own test; use `openMirrorStore`. */
export function fileMirrorStore(): MirrorStore {
  return guardMirror({
    kind: "files",
    readIndex: async (scope, workspaceId) =>
      readText(new File(workspaceDir(scope, workspaceId), "index.json")),
    writeIndex: async (scope, workspaceId, json) => {
      const directory = workspaceDir(scope, workspaceId);
      ensure(directory);
      new File(directory, "index.json").write(json);
    },
    readBody: async (scope, workspaceId, slot, path) =>
      readText(new File(slotDir(scope, workspaceId, slot), bodyFileName(path))),
    writeBody: async (scope, workspaceId, slot, path, text) => {
      const directory = slotDir(scope, workspaceId, slot);
      ensure(directory);
      new File(directory, bodyFileName(path)).write(text);
    },
    removeBody: async (scope, workspaceId, slot, path) => {
      removeIfThere(new File(slotDir(scope, workspaceId, slot), bodyFileName(path)));
    },
    roots: async () => {
      const found: MirrorRoot[] = [];
      for (const scope of SCOPES) {
        const directory = new Directory(root(), segmentName(scope));
        // Deliberately unguarded past `exists`: a listing that fails has to
        // reach the clear's verification as a failure, not as "empty".
        if (!directory.exists) continue;
        for (const entry of directory.list()) {
          if (!(entry instanceof Directory)) continue;
          const workspaceId = decodedName(entry.name);
          if (workspaceId !== null && workspaceId !== "") found.push({ scope, workspaceId });
        }
      }
      return found;
    },
    forgetWorkspace: async (workspaceId) => {
      for (const scope of SCOPES) removeIfThere(workspaceDir(scope, workspaceId));
    },
    clearAll: async () => {
      removeIfThere(root());
    },
  });
}

let opened: Promise<MirrorStore | null> | null = null;

/**
 * The one mirror store for the life of the app.
 *
 * One, because every operation on it runs through `guardMirror`'s single
 * queue, and that queue is what orders a sign-out's clear against a sync's
 * writes. Two handles would be two queues, and the clear in one would not wait
 * for a write in the other. `null` if the platform refuses — a build whose
 * file system cannot be reached — and the console then says there is no
 * mirror on this device rather than claiming one.
 */
export function openMirrorStore(): Promise<MirrorStore | null> {
  opened ??= (async () => {
    try {
      const store = fileMirrorStore();
      // Touch the document directory once, so a platform that cannot reach it
      // answers `null` here rather than failing on every write later.
      void root().exists;
      return store;
    } catch {
      return null;
    }
  })();
  return opened;
}
