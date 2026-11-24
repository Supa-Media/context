/**
 * A folder page's notes through the gateway's `POST /files/folder-notes` (`apps/mcp/src/live/folderNotesRoute.js`):
 * listed and parsed in the workspace's object, one hop from the app.
 *
 * Owner, 2026-11-24, of the Areas page: "it takes like 3 seconds to load", and "we should just be able to talk
 * directly to cloudflare". The control plane's `folderNotes` reached the same object several times over before it
 * answered; the gateway asks it once for the listing and once per hundred notes for their front matter.
 *
 * `null` means "ask the control plane": the gateway's own word that this is not its to answer (409 `not_object`, a
 * workspace whose notes are not in its object yet), no grant to send, a refusal the control plane words better, a
 * network failure, or a body this build cannot read. The page is never left without an answer because of this road.
 *
 * Pure apart from `fetch`; fields are read by name, never spread.
 */

import { FRONT_NOTES } from "../../../mcp/src/lists/grammar.js";
import { readNoteThroughGateway } from "../console/files/gatewayNoteRead";
import type { ListNote } from "../console/files/listBlock/model";
import { tableListNotes, type FolderNotesPage } from "./serverLists";

/** Long enough for a slow link, short enough that the control plane still answers in good time behind it. */
export const GATEWAY_FOLDER_NOTES_TIMEOUT_MS = 8_000;

/** `POST /files/folder-notes` on the gateway that serves `mcpEndpoint`, or `null`. The grant names the workspace. */
export function folderNotesUrl(mcpEndpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/files/folder-notes`;
}

/** The gateway's answer as a page, or `null` for a body this build cannot read. */
export function folderNotesAnswer(body: unknown): FolderNotesPage | null {
  if (!body || typeof body !== "object") return null;
  const { kind, available, notes, cursor, missing } = body as Record<string, unknown>;
  if (kind !== "folderNotes" || typeof available !== "boolean" || !Array.isArray(notes) || !Array.isArray(missing)) return null;
  if (cursor !== null && typeof cursor !== "string") return null;
  const rows: FolderNotesPage["notes"] = [];
  for (const note of notes) {
    if (!note || typeof note !== "object") return null;
    const { path, updatedAt, props } = note as Record<string, unknown>;
    if (typeof path !== "string" || typeof props !== "string") return null;
    rows.push({ path, props, ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt } : {}) });
  }
  if (!missing.every((path) => typeof path === "string")) return null;
  return { available, notes: rows, cursor, missing: missing as string[] };
}

/** One page through the gateway with the console grant: refused once, re-minted once, never a loop. */
export async function folderNotesThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  folder: string;
  subfolders: boolean;
  cursor: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<FolderNotesPage | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const request = JSON.stringify({
    folder: options.folder,
    subfolders: options.subfolders,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  const send = async (token: string): Promise<{ status: number; body: unknown } | null> => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), options.timeoutMs ?? GATEWAY_FOLDER_NOTES_TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: request,
        ...(abort === null ? {} : { signal: abort.signal }),
      });
      const body = await response.json().catch(() => null);
      return abort?.signal.aborted ? null : { status: response.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
    }
  };

  let token: string;
  try {
    token = await options.token(false);
  } catch {
    return null;
  }
  let answer = await send(token);
  if (answer?.status === 401) {
    try {
      token = await options.token({ rejected: token });
    } catch {
      return null;
    }
    answer = await send(token);
  }
  return answer?.status === 200 ? folderNotesAnswer(answer.body) : null;
}

/**
 * The front notes of `folders` (`about.md` and the rest, without their text) through the gateway, one page each
 * without subfolders, in place of the control plane's batch read; `null` for anything less than a whole answer
 * (a folder handed back, a page with more after it, a front note the facts have not read), and the caller reads them
 * from the control plane as before. The words a page draws are read after, by name (`peekNoteThroughGateway`).
 */
export async function frontNotesThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  folders: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<ListNote[] | null> {
  const pages = await Promise.all(
    options.folders.map(async (folder) => {
      const page = await folderNotesThroughGateway({ url: options.url, token: options.token, folder, subfolders: false, cursor: undefined, fetchImpl: options.fetchImpl });
      if (page === null || !page.available || page.cursor !== null) return null;
      const isFront = (path: string) => parentOf(path) === folder && FRONT_NOTES.includes(path.slice(path.lastIndexOf("/") + 1));
      if (page.missing.some(isFront)) return null;
      const list = await tableListNotes({ readNotes: async () => [], folderNotes: async () => page }, folder, false);
      return list.notes.filter((note) => isFront(note.path));
    }),
  );
  return pages.some((page) => page === null) ? null : pages.flat() as ListNote[];
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * One note's words for a page to draw, through the gateway's `/files/read` as a peek (no editing history started,
 * no open counted); `null` where the control plane should answer: not a Markdown note, handed back, or not readable
 * just now.
 */
export async function peekNoteThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  path: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; encrypted: boolean } | null> {
  if (!options.path.endsWith(".md")) return null;
  try {
    const note = await readNoteThroughGateway({ url: options.url, token: options.token, path: options.path, peek: true, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    return note === null ? null : { text: note.text, encrypted: note.encrypted };
  } catch {
    return null;
  }
}
