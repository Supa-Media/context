/**
 * The app saving a whole note through the gateway's `POST /files/write` (`apps/mcp/src/live/noteWriteRoute.js`),
 * written into the note's workspace object as an AI client's save is, with no control plane on the way (decided by
 * the owner, 2026-11-24; `docs/decisions/storage-and-credentials/app-saves-through-gateway.md`).
 *
 * Behind the flag `files.app-saves-in-objects`. The control plane's `files.writeNote` is asked only when the gateway
 * says the save is not its to make (409 `not_object`: a workspace not on its object, an encrypted note, a form, a
 * member's edit grant, and the rest the route lists), when it refuses the address or the client, or when there is no
 * gateway address to ask. Anything else is the answer:
 *
 *  - a conflict is the control plane's `CONFLICT`, with the same words and the note's current version, so the offline
 *    outbox parks it and Keep mine sends against that version exactly as before (`offline/sync.ts`);
 *  - a failure on the way is a failure, never a second try through the control plane: the save may have landed, and
 *    the outbox's own retry, or the person pressing Save again, is the one place that sends it again.
 *
 * Addressed by the workspace's slug and naming its id in the body, and sent only where both are known: the gateway
 * refuses a save named for any workspace but the one its session acts in, so a queue filed under one workspace can
 * never be written into another (`queuedWrite.ts`).
 *
 * Pure apart from `fetch`; fields are read by name, never spread.
 */

import { ConvexError } from "convex/values";
import type { ConflictCheck } from "./types";

/** The flag that turns this on (`packages/shared/src/flags.cjs`). */
export const APP_SAVES_FLAG = "files.app-saves-in-objects";

/** Long enough for a large note on a slow link. */
export const GATEWAY_NOTE_WRITE_TIMEOUT_MS = 30_000;

/** What one save answers: the shape `files.writeNote` answers. */
export interface GatewayWritten {
  kind: "written";
  path: string;
  etag: string;
  bytes: number;
  conflictCheck: ConflictCheck;
  forms: { created: string[]; occupied: string[] };
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `POST /@slug/files/write` on the gateway that serves `mcpEndpoint`, or `null` without a slug or a web address. */
export function noteWriteUrl(mcpEndpoint: string, slug: string | null | undefined): string | null {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/@${slug}/files/write`;
}

/** The gateway's answer, or `null` for a body this build cannot read. */
export function readWritten(body: unknown): GatewayWritten | null {
  if (!body || typeof body !== "object") return null;
  const { kind, path, etag, bytes, conflictCheck, forms } = body as Record<string, unknown>;
  if (kind !== "written" || typeof path !== "string" || typeof etag !== "string" || etag === "") return null;
  if (typeof bytes !== "number" || (conflictCheck !== "conditional" && conflictCheck !== "read-compare")) return null;
  const created = (forms as { created?: unknown } | null)?.created;
  const occupied = (forms as { occupied?: unknown } | null)?.occupied;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  return { kind: "written", path, etag, bytes, conflictCheck, forms: { created: strings(created), occupied: strings(occupied) } };
}

/** A save that went out and did not come back answered: not refused, and not to be sent anywhere else. */
const lost = () => new TypeError("Network request failed");

/**
 * One save through the gateway with the console grant: refused once, re-minted once, never a loop. `null` means "ask
 * the control plane"; anything else is the answer or the error to act on.
 */
export async function writeNoteThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  workspaceId: string;
  path: string;
  text: string;
  expectedEtag?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GatewayWritten | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const body = JSON.stringify({
    workspaceId: options.workspaceId,
    path: options.path,
    text: options.text,
    // Never dropped and never replaced: no version is a create, and the gateway refuses it over an existing note.
    ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
  });
  const send = async (token: string): Promise<{ status: number; body: unknown }> => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), options.timeoutMs ?? GATEWAY_NOTE_WRITE_TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        ...(abort === null ? {} : { signal: abort.signal }),
      });
      const answer = await response.json().catch(() => null);
      if (abort?.signal.aborted) throw lost();
      return { status: response.status, body: answer };
    } catch {
      // The reason is dropped: an error here can carry the address.
      throw lost();
    } finally {
      clearTimeout(deadline);
    }
  };

  let token: string;
  try {
    token = await options.token(false);
  } catch {
    return null; // No grant to send: the control plane, which signs in its own way. Nothing was sent.
  }
  let answer = await send(token);
  if (answer.status === 401) {
    try {
      token = await options.token({ rejected: token });
    } catch {
      return null; // Refused before the save was read, so nothing landed.
    }
    answer = await send(token);
  }
  const fields = (answer.body ?? {}) as Record<string, unknown>;
  if (answer.status === 200) {
    const written = readWritten(answer.body);
    // It landed, but this build cannot read what came back: a failure the outbox retries, never a second save.
    if (written === null) throw lost();
    return written;
  }
  if (answer.status === 409 && fields.error === "conflict") {
    throw new ConvexError({
      code: "CONFLICT",
      message: typeof fields.message === "string" ? fields.message : "That file changed somewhere else while you were editing it.",
      ...(typeof fields.currentEtag === "string" ? { currentEtag: fields.currentEtag } : {}),
    });
  }
  if (answer.status === 503 && fields.code === "STORAGE_UNSAFE" && typeof fields.message === "string") {
    throw new ConvexError({ code: "STORAGE_UNSAFE", message: fields.message });
  }
  // The gateway's word that the save is not its to make, or a refusal of the address or client before anything was
  // read: the control plane decides, and words it, as it always has.
  if ([400, 401, 403, 404, 405, 409, 413].includes(answer.status)) return null;
  // Anything else may have landed: the outbox's retry, or another press of Save, sends it again.
  throw lost();
}
