/**
 * Which folder is the Inbox, for a reader that lists what this product files
 * there (mail days, chat days, contact pages).
 *
 * Writers name the Inbox by its default name and the control plane carries
 * that to the folder doing the Inbox's job (`jobPath`), but a listing is not
 * carried: it lists the prefix it is given. So a reader asks the tree which
 * folder does the job and lists that one. When the tree cannot answer, it
 * lists both names this product has given the Inbox, `inbox` and, in a
 * workspace the 2026-10-21 rename skipped, `0-inbox`
 * (`docs/decisions/app-and-console/folder-jobs.md`).
 */

import { INBOX_FOLDER, LEGACY_INBOX_FOLDER } from "../../../../packages/communications/src/protocol.js";
import { factJobs } from "../tree/facts.js";

/**
 * `{ folders, home }`: the Inbox folders to list, and the folder the tree says
 * does the Inbox's job (null when it did not say), which a parser is given so
 * a key under a renamed Inbox still reads as ours (`asInboxKey`).
 *
 * @param {object} store
 * @returns {Promise<{ folders: string[], home: string | null }>}
 */
export async function inboxFolders(store) {
  const jobs = await factJobs(store);
  const home = jobs?.jobs?.inbox;
  if (typeof home === "string" && home !== "") return { folders: [home], home };
  return { folders: [INBOX_FOLDER, LEGACY_INBOX_FOLDER], home: null };
}

/** `path` under the Inbox's default name, carried to each of `folders`: `inbox/email` → `Capture/email`. */
export function underInbox(folders, path) {
  const rest = path === INBOX_FOLDER || path.startsWith(`${INBOX_FOLDER}/`) ? path.slice(INBOX_FOLDER.length) : `/${path}`;
  return folders.map((folder) => `${folder}${rest}`);
}

/**
 * `path` under the Inbox's default name, carried to the folder the tree says
 * does the Inbox's job, for a writer. A keyed write is carried by the control
 * plane anyway; an unkeyed one lands at the path it names, so without this a
 * workspace whose Inbox is still `0-inbox` would grow a second `inbox/`.
 *
 * @param {object} store
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function inboxPath(store, path) {
  if (path !== INBOX_FOLDER && !path.startsWith(`${INBOX_FOLDER}/`)) return path;
  const { home } = await inboxFolders(store);
  return underInbox([home ?? INBOX_FOLDER], path)[0];
}
