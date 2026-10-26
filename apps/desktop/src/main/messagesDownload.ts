/**
 * Download messages, on this Mac: the folder it writes into and the gateway
 * it reads from, around `core/messages/download.ts`.
 *
 * The folder is a new one in Downloads, `Messages backup <yyyy-mm-dd>`, never
 * one that already exists, so a second download never mixes with or writes
 * over the first. Every path written is checked to resolve inside it. When it
 * is done the folder is shown in Finder, and the console is told counts only.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { MessagesBackupDownload } from "@context/desktop-bridge";
import { readBackupFile, readBackupLogPage, runMessagesDownload } from "../core/messages/download.ts";
import { gatewayBaseFrom } from "../core/sync/connection.ts";

export interface MessagesDownloadDeps {
  connection: { baseUrl(): string | null; token(): Promise<string | null> };
  downloadsDir: () => string;
  reveal: (folder: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
}

/** A folder in `parent` no one has made yet: `<name>`, then `<name> 2`, and so on. */
export async function freshFolder(parent: string, name: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let n = 1; n < 1000; n += 1) {
    const folder = join(parent, n === 1 ? name : `${name} ${n}`);
    try {
      await mkdir(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("no free folder name");
}

/** `relative` under `root`, or null when it would land anywhere else. */
export function insideFolder(root: string, relative: string): string | null {
  const target = resolve(root, relative);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : null;
}

export function createMessagesDownloader(deps: MessagesDownloadDeps): () => Promise<MessagesBackupDownload> {
  let running = false;
  return async () => {
    if (running) return { ok: false, problem: "busy" };
    const base = deps.connection.baseUrl();
    if (base === null) return { ok: false, problem: "not_connected" };
    running = true;
    try {
      const config = { baseUrl: gatewayBaseFrom(base), token: () => deps.connection.token(), fetch: deps.fetch };
      const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
      let root: string | null = null;
      const result = await runMessagesDownload({
        readLogPage: (after) => readBackupLogPage(config, after),
        readFile: (folder, id) => readBackupFile(config, folder, id),
        write: async (path, data) => {
          // The folder is made at the first write, so a download that fails before it leaves nothing behind.
          root ??= await freshFolder(deps.downloadsDir(), `Messages backup ${day}`);
          const target = insideFolder(root, path);
          if (target === null) throw new Error("a path outside the download folder");
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, data);
        },
        // Reads answer refusals; only a write throws.
      }).catch(() => ({ ok: false as const, code: "write_failed" }));
      if (!result.ok) return { ok: false, problem: result.code };
      if (root !== null) deps.reveal(root);
      return result;
    } finally {
      running = false;
    }
  };
}
