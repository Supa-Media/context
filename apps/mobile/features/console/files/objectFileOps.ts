import { ConvexError } from "convex/values";
import { objectServes } from "./fileBrowser/objectServes";

/**
 * Trash, restore, moves, copies and duplicates sent straight to the
 * workspace's object through the gateway (`POST /files/trash`, `/files/restore`,
 * `/files/move`, `/files/copy`, `/files/duplicate`), so they answer in well
 * under 100 ms instead of a round trip through Convex.
 *
 * The answer is one of three things, and the caller acts on each:
 *  - the moved result, the same shape the Convex action returns;
 *  - `null`: fall back to the Convex action, which is still correct for every
 *    workspace. That is the object not serving this workspace (`409 not_object`),
 *    a 5xx, a network failure or timeout, a mint that failed, a 401 that a
 *    re-mint did not cure, or an answer nobody listed here;
 *  - a thrown `ConvexError` shaped like the file action's own refusal, so the
 *    console reads it the way it reads `trashEntry`'s: `FILE_NOT_FOUND`,
 *    `CONFLICT` (with `currentEtag`), `DESTINATION_EXISTS`, `PATH_INVALID`,
 *    `FORBIDDEN`, and `SYNCING` for a 503 `mirror_pending` (the object has the
 *    move and Convex is catching up; retry, never re-send). A refusal never
 *    falls back: the object has answered it.
 *
 * The request mirrors `collaborationTransport` (`collaboration/transport.ts`):
 * the console grant as a bearer, JSON, and a deadline, so a hung connection
 * holds nothing up. The grant is minted by the caller; a 401 is retried once
 * with the rejected token, as the collaboration controller does.
 */

/** Long enough for a slow link; short enough that the Convex fallback is still quick. */
export const OBJECT_FILE_OP_TIMEOUT_MS = 10_000;

export interface ObjectMoved {
  kind: "moved";
  from: string;
  to: string;
  paths: string[];
  etag?: string;
}

export interface ObjectMoveTarget {
  workspaceId: string;
  /** The gateway's origin; `null` when the endpoint is not a URL, which falls back. */
  origin: string | null;
  /**
   * The workspace's name, without its `@`, when the caller knows it: the request is addressed to the workspace
   * (`/@slug/files/trash`), so the address says which workspace it acts on (decided by the owner, 2026-11-09, after
   * the bare `/files/...` address was read by the gateway as a workspace called `files`). `null` sends the bare
   * address, which the gateway also answers.
   */
  slug?: string | null;
  /** A console grant's bearer for the workspace. `rejected` names a token the gateway just refused. */
  mint: (rejected?: string) => Promise<string>;
  timeoutMs?: number;
}

export type ObjectTrashBody = { path: string; expectedEtag?: string };
export type ObjectRestoreBody = { from: string; to: string };

export function objectTrash(target: ObjectMoveTarget, body: ObjectTrashBody): Promise<ObjectMoved | null> {
  return sendObjectMove(target, "/files/trash", body);
}

export function objectRestore(target: ObjectMoveTarget, body: ObjectRestoreBody): Promise<ObjectMoved | null> {
  return sendObjectMove(target, "/files/restore", body);
}

export type ObjectMoveBody = { from: string; to: string; expectedEtag?: string };

/** A move or rename. The object leaves some to Convex (`409 not_object`), which answer `null` like any fallback. */
export function objectMove(target: ObjectMoveTarget, body: ObjectMoveBody): Promise<ObjectMoved | null> {
  return sendObjectMove(target, "/files/move", body);
}

export type ObjectCopyBody = { from: string; to: string };
export type ObjectDuplicateBody = { path: string };

/** Copy one note (paste). A folder, or anything the gateway leaves to Convex, answers `null` like any fallback. */
export function objectCopy(target: ObjectMoveTarget, body: ObjectCopyBody): Promise<ObjectMoved | null> {
  return sendObjectMove(target, "/files/copy", body);
}

/** Duplicate one note beside itself under a free "… copy" name. */
export function objectDuplicate(target: ObjectMoveTarget, body: ObjectDuplicateBody): Promise<ObjectMoved | null> {
  return sendObjectMove(target, "/files/duplicate", body);
}

async function sendObjectMove(
  target: ObjectMoveTarget,
  path: string,
  body: ObjectTrashBody | ObjectRestoreBody | ObjectMoveBody | ObjectCopyBody | ObjectDuplicateBody,
): Promise<ObjectMoved | null> {
  if (target.origin === null || !objectServes(target.workspaceId) || typeof fetch !== "function") return null;
  let token: string;
  try {
    token = await target.mint();
  } catch {
    return null;
  }
  let answer = await post(target, path, body, token);
  if (answer?.status === 401) {
    try {
      token = await target.mint(token);
    } catch {
      return null;
    }
    answer = await post(target, path, body, token);
    if (answer?.status === 401) return null;
  }
  if (answer === null) return null;
  return interpret(answer.status, answer.body);
}

interface Answer {
  status: number;
  body: unknown;
}

/** Where one operation is sent: `/@slug/files/...` on the gateway when the workspace's name is known. */
export function objectFileOpUrl(target: Pick<ObjectMoveTarget, "origin" | "slug">, path: string): string {
  const slug = typeof target.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(target.slug) ? target.slug : null;
  return new URL(slug === null ? path : `/@${slug}${path}`, target.origin!).toString();
}

/** One request with its deadline; `null` for a network failure or a timeout. */
async function post(target: ObjectMoveTarget, path: string, body: unknown, token: string): Promise<Answer | null> {
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  const deadline = setTimeout(() => abort?.abort(), target.timeoutMs ?? OBJECT_FILE_OP_TIMEOUT_MS);
  try {
    const response = await fetch(objectFileOpUrl(target, path), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(abort === null ? {} : { signal: abort.signal }),
    });
    const parsed = await response.json().catch(() => null);
    if (abort?.signal.aborted) return null;
    return { status: response.status, body: parsed };
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

function interpret(status: number, body: unknown): ObjectMoved | null {
  const error = errorOf(body);
  if (status === 200) {
    const moved = movedOf(body);
    // The object moved it; a body that does not say so cannot be re-sent as a
    // Convex call (the path would be gone), so it is reported as an unknown failure.
    if (moved === null) throw new ConvexError({ code: "UNKNOWN", message: "That did not work. Try again." });
    return moved;
  }
  if (status === 409 && error === "not_object") return null;
  // The object has done the move and is still mirroring it to Convex, which will
  // catch up on its own. A fallback would send the same move again against a path
  // that is already gone, so this is a refusal the person can retry.
  if (status === 503 && error === "mirror_pending") {
    throw new ConvexError({ code: "SYNCING", message: "Still syncing. Try again in a moment." });
  }
  if (status >= 500) return null;
  const refusal = REFUSALS[`${status}:${error ?? ""}`];
  if (refusal === undefined) return null;
  const { code, message } = refusal;
  const currentEtag = status === 409 && error === "changed" ? currentEtagOf(body) : undefined;
  throw new ConvexError({ code, message, ...(currentEtag === undefined ? {} : { currentEtag }) });
}

/** The gateway's refusals, by status and error, as the file actions name them. */
const REFUSALS: Record<string, { code: string; message: string }> = {
  "404:not_found": { code: "FILE_NOT_FOUND", message: "That note is not there any more." },
  "409:changed": { code: "CONFLICT", message: "That changed somewhere else. Reload to see the version that is there now." },
  "409:taken": { code: "DESTINATION_EXISTS", message: "Something already exists there." },
  "400:invalid_path": { code: "PATH_INVALID", message: "That path is not allowed." },
  "403:forbidden": { code: "FORBIDDEN", message: "You cannot change that here." },
};

function errorOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function currentEtagOf(body: unknown): string | undefined {
  const etag = body !== null && typeof body === "object" ? (body as { currentEtag?: unknown }).currentEtag : undefined;
  return typeof etag === "string" ? etag : undefined;
}

function movedOf(body: unknown): ObjectMoved | null {
  if (body === null || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (row.kind !== "moved" || typeof row.from !== "string" || typeof row.to !== "string") return null;
  if (!Array.isArray(row.paths) || !row.paths.every((path) => typeof path === "string")) return null;
  return {
    kind: "moved",
    from: row.from,
    to: row.to,
    paths: row.paths as string[],
    ...(typeof row.etag === "string" ? { etag: row.etag } : {}),
  };
}
