import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { CARD_SUBTITLE_TEXTED } from "../cardArt";
import { isRenderableTitle } from "../cardCoverage";
import { json } from "../gatewayAuth";
import { normalizePreviewTitle } from "../shareTitle";

/** A workspace's name as a link carries it: `context.lc/note/@<slug>/…`. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * POST /agent-texts/note-card — the picture Tex texts beside a note's link.
 *
 * A link texted through Sendblue arrives as "Click to Load Preview" (Messages
 * draws a preview by itself only for a link the sender's own phone attached
 * one to), so the texting Worker sends this card first and the link with it.
 *
 * Behind the texting Worker's own secret, which is what keeps this from being
 * the arbitrary-text image generator `renderCard` refuses to be: only that
 * Worker asks, and it asks only with the name and workspace already in a
 * note link it is about to text to someone who can open it. Both are in that
 * link, so the picture tells them nothing the link does not.
 *
 * `{ png }` (base64) or 404 for anything it will not draw: a name the font
 * cannot draw (tofu), a malformed workspace, or a renderer that failed. The
 * Worker then sends the link alone, as before.
 */
export async function agentTextsNoteCardHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const title = typeof body.title === "string" ? normalizePreviewTitle(body.title) : null;
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (title === null || !SLUG.test(slug) || !isRenderableTitle(title)) return json({ error: "not_drawn" }, 404);
  try {
    const bytes: ArrayBuffer = await ctx.runAction(internal.functions.cardRender.renderCard, {
      title,
      handle: `@${slug}`,
      kind: "note",
      subtitle: CARD_SUBTITLE_TEXTED,
    });
    return json({ png: base64Of(bytes) });
  } catch {
    return json({ error: "not_drawn" }, 404);
  }
}

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
