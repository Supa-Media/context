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

import type { FolderNotesPage } from "./serverLists";

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
