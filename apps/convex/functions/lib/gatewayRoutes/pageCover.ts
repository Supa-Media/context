/**
 * `POST /gateway/page-cover`: the gateway reports the cover it drew of a
 * `.page.md` note (`draw_visual` template `page`), so a linked page's card
 * can show it (`lib/shares/pageCover.ts`, owner 2026-10-27).
 *
 * The gateway secret gets the request in; the person's access token must
 * reach the workspace as `owner` or `editor` with `context:write`, as any
 * write's must (`writableWorkspace`). The path must be a live page in the
 * tree. The bytes must be a PNG and are written to the owner's own bucket,
 * at a leaf named for the note and the picture, so a new cover is a new
 * object and a new card address. Every refusal is `{ recorded: false }`.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { json, stringField } from "../gatewayAuth";
import { writableWorkspace } from "../nodes/gatewayNames";
import { GATEWAY_PATH_LENGTH } from "../nodes/gatewayManifest";

/** A cover is a 1080 x 1350 picture; past this it is not one. */
export const MAX_COVER_BYTES = 2_000_000;
/** The request: the picture as base64, and the rest. */
export const MAX_COVER_REQUEST_BYTES = 2_800_000;

const NOT_RECORDED = { recorded: false } as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG's bytes, or `null` for anything that is not one or is too big. */
export function coverBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value === "" || value.length > Math.ceil(MAX_COVER_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length <= PNG_MAGIC.length || PNG_MAGIC.some((byte, i) => bytes[i] !== byte)) return null;
  return bytes;
}

async function hex(data: Uint8Array | string, chars: number): Promise<string> {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, chars);
}

/** `cover-<note>-<picture>.png`: the note's part is hashed, so no id or name is in the object's name. */
export async function coverLeaf(workspaceId: string, key: string, bytes: Uint8Array): Promise<string> {
  return `cover-${await hex(`${workspaceId}:${key}`, 16)}-${await hex(bytes, 8)}.png`;
}

export async function gatewayPageCoverHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const path = stringField(body, "path");
  const bytes = coverBytes(body.png);
  if (accessToken === null || expected === null || path === null || path.length > GATEWAY_PATH_LENGTH || bytes === null) return json(NOT_RECORDED);
  try {
    const workspaceId = await writableWorkspace(ctx, accessToken, expected);
    if (workspaceId === null) return json(NOT_RECORDED);
    const target = await ctx.runQuery(internal.functions.pageCovers.coverTarget, { workspaceId, path });
    if (target === null) return json(NOT_RECORDED);
    const leaf = await coverLeaf(workspaceId, target.key, bytes);
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      // Not consulted for an image write; the barrier's signature asks for a scope (`shareCard.ts`).
      scope: "team",
      operation: { kind: "writeImage", leaf, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, contentType: "image/png" },
    });
    const recorded = await ctx.runMutation(internal.functions.pageCovers.recordCover, { workspaceId, path, leaf });
    return json({ recorded });
  } catch {
    // No bucket, a refused write, a control plane mid-deploy: the card stays the title card.
    return json(NOT_RECORDED);
  }
}
