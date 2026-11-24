/**
 * The two routes a crawler uses to unfurl a note link Tex texted: its name,
 * and its card (Dev, 2026-11-23;
 * `docs/decisions/privacy-and-sharing/note-link-previews.md`).
 *
 * A note link is guessable, so it says nothing by itself. One Tex texted
 * carries the note's name and a key (`?t=<name>&k=<key>`), an HMAC the gateway
 * made over the workspace, the path and that name under a key derived from
 * `GATEWAY_SECRET` (`packages/shared/src/notePreview.cjs`). These routes answer
 * only when the key is the one this deployment would have made, so the only
 * names a context.lc card ever shows are names Tex itself put in a link it
 * texted. Nothing here reads a note, a row or a bucket: everything on the card
 * is in the link, and the key only proves Tex wrote it. Every other answer is
 * one shape: nulls for the name, a 404 for the card.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import {
  boardOf,
  folderLineOf,
  isPreviewKey,
  poseOf,
  previewSigningKey,
} from "@context/shared/src/notePreview.cjs";
import { isRenderableNoteCard } from "../cardCoverage";
import { GATEWAY_SECRET_ENV_VAR, json, readJsonBody } from "../gatewayAuth";
import type { NoteCardFacts } from "../noteCardArt";

/** A workspace's name as a link carries it; compared lowercased, as the key signs it. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A note path: relative, no `.` or `..` and no hidden segment, a Markdown file. */
const MAX_PATH = 512;
/** Longer than any name a key can sign (`MAX_TITLE` characters, each up to two UTF-16 units). */
const MAX_TITLE_UNITS = 200;

let signing: { secret: string; key: Promise<CryptoKey | null> } | null = null;

/** The deployment's preview key, derived once per isolate and again if the secret changes. */
function signingKey(): Promise<CryptoKey | null> {
  const secret = process.env[GATEWAY_SECRET_ENV_VAR] ?? "";
  if (signing === null || signing.secret !== secret) signing = { secret, key: previewSigningKey(secret) };
  return signing.key;
}

export function isNotePath(path: string): boolean {
  if (path === "" || path.length > MAX_PATH || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return false;
  return /\.md$/i.test(path);
}

/**
 * The card a signed link shows, or null for anything else: a field missing or
 * malformed, a key that does not match, or no secret to check it with.
 */
export async function signedNoteCard(body: Record<string, unknown> | null): Promise<NoteCardFacts | null> {
  if (body === null) return null;
  const { slug, path, title, key } = body;
  if (typeof slug !== "string" || typeof path !== "string" || typeof title !== "string" || typeof key !== "string") return null;
  const workspace = slug.toLowerCase();
  if (!SLUG.test(workspace) || !isNotePath(path) || title === "" || title.length > MAX_TITLE_UNITS) return null;
  if (!(await isPreviewKey(await signingKey(), { slug: workspace, path, title, key }))) return null;
  return noteCardFactsOf(workspace, path, title);
}

/** What the card shows for a note, all of it read off the link: the name, its folders, a backdrop and a pose. */
export function noteCardFactsOf(slug: string, path: string, title: string): NoteCardFacts {
  return { title, folder: folderLineOf(path), board: boardOf(slug.toLowerCase(), path), pose: poseOf(title, path) };
}

/** `POST /note/preview`: `{ title, description, card }` for a signed link, all null otherwise. */
export async function notePreviewHandler(_ctx: ActionCtx, request: Request): Promise<Response> {
  const facts = await signedNoteCard(await readJsonBody(request));
  if (facts === null) return json({ title: null, description: null, card: null });
  // Named rather than spread, as every unauthenticated route here is. `card`
  // is false for a name the card faces cannot draw: the tags still carry the
  // name, and the picture stays the product's rather than a row of tofu.
  return json({ title: facts.title, description: facts.folder, card: isRenderableNoteCard(facts) });
}

/** `POST /note/card`: the card's PNG for a signed link, a 404 for anything else. */
export async function noteCardHandler(ctx: ActionCtx, request: Request): Promise<Response> {
  const facts = await signedNoteCard(await readJsonBody(request));
  if (facts === null || !isRenderableNoteCard(facts)) return new Response(null, { status: 404 });
  let bytes: ArrayBuffer;
  try {
    bytes = await ctx.runAction(internal.functions.cardRender.renderNoteCard, facts);
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // The router caches it under a key rebuilt from the checked link.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
