/**
 * The app opening a note through the gateway's `POST /files/read` (`apps/mcp/src/live/noteReadRoute.js`): read in
 * the note's workspace object, by the one copy of the editing-history engine there is.
 *
 * Until 2026-11-11 every open went to the control plane's `files.readNote`, which ran a second copy of that engine
 * against the object over the network while the gateway saved the person's typing with the first. A read caught
 * between two saves gave up with "This note cannot be opened safely for collaborative editing right now", and the
 * app closed the note the person was typing in (Dev2, 2026-11-11: "duplicated sources of information").
 *
 * The control plane is asked only when the gateway says the note is not its to answer (409 `not_object`: a workspace
 * whose notes are not in its object yet, a picture, a Tex note, a renamed note's old address to follow, a name with
 * no note this reader may open), or when there is no gateway address to ask. Anything else is the answer: a read the
 * engine cannot finish just now is a `STORAGE_UNSAFE` error the open does not close the note for
 * (`refusesOpen` in `browser/errors.ts`), and a network failure is a network failure, which the open answers from
 * the device's copy as it always has.
 *
 * Pure apart from `fetch`; fields are read by name, never spread.
 */

import { ConvexError } from "convex/values";
import type { Visibility } from "./types";

/** Long enough for a slow link; the open shows the device's copy meanwhile. */
export const GATEWAY_NOTE_READ_TIMEOUT_MS = 20_000;

export const NOTE_READ_UNAVAILABLE = "This note can't be loaded right now. What you see is kept; it will catch up.";

/** What one open answers: the shape `files.readNote` answers. */
export interface GatewayNoteRead {
  kind: "file";
  path: string;
  text: string;
  etag: string;
  rawEtag?: string;
  documentId?: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  encrypted: boolean;
}

/** `POST /files/read` on the gateway that serves `mcpEndpoint`, addressed to `slug` when known, or `null`. */
export function noteReadUrl(mcpEndpoint: string, slug: string | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const named = typeof slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(slug) ? `/@${slug}` : "";
  return `${parsed.origin}${named}/files/read`;
}

/** The gateway's answer, or `null` for a body this build cannot read. */
export function readNoteAnswer(body: unknown): GatewayNoteRead | null {
  if (!body || typeof body !== "object") return null;
  const { kind, path, text, etag, rawEtag, documentId, visibility, inherited, exception, readOnly, encrypted } = body as Record<string, unknown>;
  if (kind !== "file" || typeof path !== "string" || typeof text !== "string" || typeof etag !== "string" || etag === "") return null;
  if (typeof visibility !== "string" || typeof inherited !== "string") return null;
  if (typeof exception !== "boolean" || typeof readOnly !== "boolean" || typeof encrypted !== "boolean") return null;
  return {
    kind: "file",
    path,
    text,
    etag,
    ...(typeof rawEtag === "string" ? { rawEtag } : {}),
    ...(typeof documentId === "string" ? { documentId } : {}),
    visibility: visibility as Visibility,
    inherited: inherited as Visibility,
    exception,
    // Never less than the note says of itself: an encrypted note is read-only whatever came with it.
    readOnly: readOnly || encrypted,
    encrypted,
  };
}

const unavailable = () => new ConvexError({ code: "STORAGE_UNSAFE", message: NOTE_READ_UNAVAILABLE });

/**
 * One open through the gateway with the console grant: refused once, re-minted once, never a loop. `null` means "ask
 * the control plane"; anything else is the answer or the error to act on.
 */
export async function readNoteThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  path: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GatewayNoteRead | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const send = async (token: string): Promise<{ status: number; body: unknown }> => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), options.timeoutMs ?? GATEWAY_NOTE_READ_TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: options.path }),
        ...(abort === null ? {} : { signal: abort.signal }),
      });
      const body = await response.json().catch(() => null);
      if (abort?.signal.aborted) throw new TypeError("Network request failed");
      return { status: response.status, body };
    } catch {
      // The reason is dropped: an error here can carry the address.
      throw new TypeError("Network request failed");
    } finally {
      clearTimeout(deadline);
    }
  };

  let token: string;
  try {
    token = await options.token(false);
  } catch {
    return null; // No grant to send: the control plane, which signs in its own way.
  }
  let answer = await send(token);
  if (answer.status === 401) {
    try {
      token = await options.token({ rejected: token });
    } catch {
      return null;
    }
    answer = await send(token);
  }
  if (answer.status === 200) {
    const note = readNoteAnswer(answer.body);
    if (note === null) throw unavailable();
    return note;
  }
  // The gateway's own word that this is not its to answer, and an answer about access the control plane words better.
  if (answer.status === 409 || answer.status === 401 || answer.status === 403 || answer.status === 400 || answer.status === 404 || answer.status === 405) return null;
  throw unavailable();
}
