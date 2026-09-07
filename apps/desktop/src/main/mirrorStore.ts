/**
 * The mirror on disk: one directory, rebuilt whole or deleted.
 *
 * `core/shell/mirror.ts` decides *what* may be mirrored and *when* it may be
 * served; this is the part that touches a filesystem, and it holds one rule of
 * its own: **a mirror is replaced atomically or not at all.** A snapshot is
 * written into `pending/`, and only when every file and the manifest are down
 * is `current/` deleted and `pending/` renamed over it. A crash halfway through
 * leaves the previous mirror intact and a `pending/` that the next save
 * overwrites — never a half-written console served as if it were whole.
 *
 * No Electron is imported, so `test/mirror.test.mjs` drives this against a real
 * temporary directory rather than a fake filesystem: the checks that matter
 * here are that a corrupt manifest deletes the directory and that a version
 * change does the same, and both are facts about `rm` rather than about types.
 *
 * The manifest is written **last** on purpose. It is the only thing `load`
 * reads, so its absence is what "this snapshot never finished" looks like.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MIRROR_DIR,
  MIRROR_FORMAT,
  fitsInBudget,
  mirrorIsUsable,
  mirrorKey,
  type MirrorEntry,
  type MirrorManifest,
} from "../core/shell/mirror.ts";

/** One file to mirror, already fetched and already allowed by `shouldMirror`. */
export interface MirrorFile {
  /** `pathname + search` at the live origin. */
  path: string;
  contentType: string;
  body: Uint8Array;
}

export interface MirrorSaveInput {
  appVersion: string;
  origin: string;
  savedAtMs: number;
  /** The document first: it is the index a navigation falls back to. */
  files: readonly MirrorFile[];
}

export class MirrorStore {
  readonly #root: string;

  constructor(userDataDir: string) {
    this.#root = join(userDataDir, ...MIRROR_DIR.split("/"));
  }

  get root(): string {
    return this.#root;
  }

  get #current(): string {
    return join(this.#root, "current");
  }

  get #pending(): string {
    return join(this.#root, "pending");
  }

  #manifestPath(dir: string): string {
    return join(dir, "manifest.json");
  }

  #blobPath(dir: string, key: string): string {
    /*
      `key` is a hex hash from `mirrorKey`, never anything a URL chose, so there
      is no separator, no `..` and no length surprise to defend against here.
      Checked anyway, because "it is always a hash" is a property of every
      caller rather than of this line.
    */
    if (!/^[0-9a-f]{8,64}$/.test(key)) throw new Error("a mirror key is a hash");
    return join(dir, "blobs", key);
  }

  /**
   * The manifest, if there is a usable one.
   *
   * Anything else — no directory, no manifest, JSON that will not parse, a
   * different app version, a different origin, a copy too old to show — deletes
   * the mirror and answers `null`. A mirror is a derivative of one successful
   * load, so repair is never the cheaper option.
   */
  async load(context: {
    appVersion: string;
    liveOrigin: string;
    nowMs: number;
  }): Promise<MirrorManifest | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#manifestPath(this.#current), "utf8"));
    } catch {
      // Missing is the ordinary first run; corrupt is the one worth clearing.
      await this.clear();
      return null;
    }
    if (!mirrorIsUsable(parsed, context)) {
      await this.clear();
      return null;
    }
    return parsed;
  }

  /** One mirrored file's bytes, or `null` if it is not there any more. */
  async read(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.#blobPath(this.#current, key));
    } catch {
      return null;
    }
  }

  /**
   * Replace the mirror with this snapshot.
   *
   * Returns the manifest that was written, or `null` when there was nothing to
   * write: a snapshot with no document is not a mirror, and writing one would
   * mean a later navigation falling back to an index that does not exist.
   */
  async save(input: MirrorSaveInput): Promise<MirrorManifest | null> {
    if (input.files.length === 0) return null;

    await rm(this.#pending, { recursive: true, force: true });
    await mkdir(join(this.#pending, "blobs"), { recursive: true, mode: 0o700 });

    const entries: Record<string, MirrorEntry> = {};
    let total = 0;
    let index: string | null = null;

    for (const file of input.files) {
      const bytes = file.body.byteLength;
      if (!fitsInBudget(total, bytes)) continue;
      const key = mirrorKey(file.path);
      if (entries[key] !== undefined) continue;
      await writeFile(this.#blobPath(this.#pending, key), file.body, { mode: 0o600 });
      entries[key] = { key, path: file.path, contentType: file.contentType, bytes };
      total += bytes;
      index ??= key;
    }
    if (index === null) {
      await rm(this.#pending, { recursive: true, force: true });
      return null;
    }

    const manifest: MirrorManifest = {
      format: MIRROR_FORMAT,
      appVersion: input.appVersion,
      origin: input.origin,
      savedAtMs: input.savedAtMs,
      index,
      entries,
    };
    // Last, and that is the whole atomicity story: `load` reads this file and
    // nothing else, so a snapshot that died before it is a snapshot that never
    // happened.
    await writeFile(this.#manifestPath(this.#pending), JSON.stringify(manifest), { mode: 0o600 });

    await rm(this.#current, { recursive: true, force: true });
    await rename(this.#pending, this.#current);
    return manifest;
  }

  /** Delete the whole mirror. The next successful load rebuilds it. */
  async clear(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }

  /** For the suite: what is actually on disk under `current/blobs`. */
  async storedKeys(): Promise<string[]> {
    try {
      return (await readdir(join(this.#current, "blobs"))).sort();
    } catch {
      return [];
    }
  }
}
