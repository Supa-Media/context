/**
 * A workspace's own emoji: listing, drawing, adding, renaming and removing
 * them, and finding new ones on Slackmojis.
 *
 * The bytes live in the workspace's bucket (`lib/fileOps/emoji.ts`) and pass
 * through here on the way in and out; nothing about an emoji is written to a
 * table. Every call reaches the bucket through `runFileOperation`, the one
 * barrier that opens a credential.
 *
 * ## Who may do what
 *
 * **Every member sees every emoji.** An emoji has no note to borrow a
 * visibility from, and it is drawn in any note that names it, so it belongs to
 * the workspace the way its icon does. Adding, renaming and removing change
 * what every member's notes look like, so they take an editor — the same role
 * a paste takes. A non-member gets `WORKSPACE_NOT_FOUND` from
 * `authorizeFileAccess`, as for a workspace that does not exist.
 *
 * ## Slackmojis
 *
 * Searched, previewed and imported by this server, never by the reader's
 * browser, for the reason remote images are proxied: a picture drawn straight
 * from another host tells that host who is looking. The search goes to one
 * fixed address, and previews and imports are held to Slackmojis' image host,
 * so none of the three is a general-purpose fetcher. Importing copies the
 * bytes into the bucket once; after that the emoji is the workspace's own.
 *
 * See `docs/decisions/app-and-console/custom-emoji.md`.
 */

import { ConvexError, v } from "convex/values";
import { CUSTOM_EMOJI_MAX_BYTES } from "@context/shared/src/customEmoji";
import { fetchableImageUrl, fetchRemoteImage } from "@context/shared/src/remoteImage.cjs";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { FileOperation as Operation, OperationResult } from "./lib/filesFns/operationTypes";

/** Where a Slackmojis search goes. */
export const SLACKMOJIS_SEARCH_URL = "https://slackmojis.com/emojis/search.json";
/** The only host a Slackmojis picture is fetched from. */
export const SLACKMOJIS_IMAGE_HOST = "emojis.slackmojis.com";
/** Results one search returns at most. */
const SLACKMOJIS_RESULTS = 40;

type Role = "member" | "editor" | "owner";

async function run(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  minimum: Role,
  operation: Operation,
): Promise<OperationResult> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId,
    minimum,
  });
  return await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId,
    scope,
    grantedNames,
    operation,
  });
}

/** Membership alone, for the Slackmojis calls that never touch the bucket. */
async function authorize(ctx: ActionCtx, workspaceId: Id<"workspaces">, minimum: Role): Promise<void> {
  const actorUserId = await callerId(ctx);
  await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum });
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A Slackmojis picture URL, or `null` for anything on another host. */
function slackmojiImageUrl(value: string): URL | null {
  const url = fetchableImageUrl(value);
  return url !== null && url.hostname === SLACKMOJIS_IMAGE_HOST ? url : null;
}

async function fetchSlackmoji(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (slackmojiImageUrl(url) === null) {
    throw new ConvexError({ code: "SLACKMOJI_INVALID", message: "That is not a Slackmojis picture." });
  }
  const fetched = await fetchRemoteImage(url, (input: string, init: RequestInit) => fetch(input, init));
  if ("error" in fetched) {
    throw new ConvexError({ code: "REMOTE_IMAGE_UNAVAILABLE", message: `Slackmojis did not send that emoji: ${fetched.error}.` });
  }
  return { bytes: fetched.bytes as Uint8Array, contentType: fetched.contentType as string };
}

const emojiEntry = v.object({ name: v.string(), leaf: v.string() });

/** Every emoji in the workspace, by name. Any member. */
export const list = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(emojiEntry),
  handler: async (ctx, args): Promise<Array<{ name: string; leaf: string }>> => {
    const result = (await run(ctx, args.workspaceId, "member", { kind: "emojiList" })) as Extract<
      OperationResult,
      { kind: "emojiList" }
    >;
    return result.emoji;
  },
});

/**
 * One emoji's picture, by name. Any member. The caller names an emoji, never a
 * leaf, so this can return nothing from the image store but an emoji.
 */
export const read = action({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
    const result = (await run(ctx, args.workspaceId, "member", { kind: "emojiRead", name: args.name })) as Extract<
      OperationResult,
      { kind: "emojiImage" }
    >;
    return { bytes: result.bytes, contentType: result.contentType };
  },
});

/** Add an uploaded picture as `:name:`. Editor. */
export const add = action({
  args: { workspaceId: v.id("workspaces"), name: v.string(), bytes: v.bytes(), replace: v.optional(v.boolean()) },
  returns: emojiEntry,
  handler: async (ctx, args): Promise<{ name: string; leaf: string }> => {
    if (args.bytes.byteLength > CUSTOM_EMOJI_MAX_BYTES) {
      throw new ConvexError({ code: "CONTENT_TOO_LARGE", message: `An emoji must be at most ${CUSTOM_EMOJI_MAX_BYTES / 1_000_000} MB.` });
    }
    const result = (await run(ctx, args.workspaceId, "editor", {
      kind: "emojiStore",
      name: args.name,
      bytes: args.bytes,
      replace: args.replace === true,
    })) as Extract<OperationResult, { kind: "emojiStored" }>;
    return { name: result.name, leaf: result.leaf };
  },
});

/** Rename an emoji. Editor. */
export const rename = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: emojiEntry,
  handler: async (ctx, args): Promise<{ name: string; leaf: string }> => {
    const result = (await run(ctx, args.workspaceId, "editor", {
      kind: "emojiRename",
      from: args.from,
      to: args.to,
    })) as Extract<OperationResult, { kind: "emojiStored" }>;
    return { name: result.name, leaf: result.leaf };
  },
});

/** Remove an emoji. Editor. */
export const remove = action({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await run(ctx, args.workspaceId, "editor", { kind: "emojiRemove", name: args.name });
    return null;
  },
});

const slackmoji = v.object({ name: v.string(), url: v.string(), category: v.union(v.string(), v.null()) });

/**
 * Search Slackmojis. Editor, because the only thing a result is for is adding
 * it. Answers with names and picture URLs; the pictures come through
 * `slackmojiPreview`, never from the URL directly.
 */
export const searchSlackmojis = action({
  args: { workspaceId: v.id("workspaces"), query: v.string() },
  returns: v.array(slackmoji),
  handler: async (ctx, args): Promise<Array<{ name: string; url: string; category: string | null }>> => {
    await authorize(ctx, args.workspaceId, "editor");
    const query = args.query.trim().slice(0, 64);
    if (query === "") return [];
    let body: unknown;
    try {
      const response = await fetch(`${SLACKMOJIS_SEARCH_URL}?query=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) throw new Error(String(response.status));
      body = await response.json();
    } catch {
      throw new ConvexError({ code: "SLACKMOJIS_UNAVAILABLE", message: "Slackmojis is not answering right now." });
    }
    return parseSlackmojis(body);
  },
});

/** Keep only well-formed results whose picture is on Slackmojis' own host. */
export function parseSlackmojis(body: unknown): Array<{ name: string; url: string; category: string | null }> {
  if (!Array.isArray(body)) return [];
  const results: Array<{ name: string; url: string; category: string | null }> = [];
  for (const entry of body) {
    if (results.length >= SLACKMOJIS_RESULTS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { name, image_url: url, category } = entry as { name?: unknown; image_url?: unknown; category?: unknown };
    if (typeof name !== "string" || typeof url !== "string" || slackmojiImageUrl(url) === null) continue;
    const categoryName =
      typeof category === "object" && category !== null && typeof (category as { name?: unknown }).name === "string"
        ? ((category as { name: string }).name.slice(0, 80))
        : null;
    results.push({ name: name.slice(0, 80), url, category: categoryName });
  }
  return results;
}

/** One Slackmojis picture, fetched here so the browser never asks for it. Editor. */
export const slackmojiPreview = action({
  args: { workspaceId: v.id("workspaces"), url: v.string() },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
    await authorize(ctx, args.workspaceId, "editor");
    const { bytes, contentType } = await fetchSlackmoji(args.url);
    return { bytes: asBuffer(bytes), contentType };
  },
});

/** Copy a Slackmojis picture into the workspace as `:name:`. Editor. */
export const importSlackmoji = action({
  args: { workspaceId: v.id("workspaces"), url: v.string(), name: v.string(), replace: v.optional(v.boolean()) },
  returns: emojiEntry,
  handler: async (ctx, args): Promise<{ name: string; leaf: string }> => {
    await authorize(ctx, args.workspaceId, "editor");
    const { bytes } = await fetchSlackmoji(args.url);
    if (bytes.byteLength > CUSTOM_EMOJI_MAX_BYTES) {
      throw new ConvexError({ code: "CONTENT_TOO_LARGE", message: `That emoji is over ${CUSTOM_EMOJI_MAX_BYTES / 1_000_000} MB.` });
    }
    const result = (await run(ctx, args.workspaceId, "editor", {
      kind: "emojiStore",
      name: args.name,
      bytes: asBuffer(bytes),
      replace: args.replace === true,
    })) as Extract<OperationResult, { kind: "emojiStored" }>;
    return { name: result.name, leaf: result.leaf };
  },
});
