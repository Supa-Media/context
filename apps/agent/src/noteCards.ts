/**
 * A note's link texted with a picture of the note (the owner, 2026-10-27:
 * "Can we also work on an actual preview graphic for the links tex sends?").
 *
 * Messages draws a link's preview by itself only when the sender's own phone
 * attached one. A link Tex texts through Sendblue has none, so it arrives as
 * a grey "Click to Load Preview" box. So a text that is nothing but a link to
 * a note goes as two: the note's card, drawn by the control plane
 * (`/agent-texts/note-card`), then the link alone in its own text, with no
 * words or punctuation around it. That is what Sendblue's support named as
 * the most reliable way for Messages to load the link's own preview (to the
 * owner, 2026-10-27); a link inside a sentence never gets one.
 *
 * The card shows the note's name and workspace, both already in the link, to
 * the chat the link goes to. Anything that fails sends the link alone, as
 * before: the picture is never the only way to the note.
 */

import { post, type Fetch } from "./clients";
import { noteLinkOf, type NoteLink } from "./appCards";
import type { Picture } from "./line";

/** Long enough for a cold renderer, short enough that the link is not held up for long. */
export const NOTE_CARD_TIMEOUT_MS = 8_000;

/** Draws a note link's card, or null when it was not drawn. Never throws. */
export type NoteCardDrawer = (link: NoteLink) => Promise<Picture | null>;

export function noteCardDrawer(fetcher: Fetch, controlPlaneOrigin: string, workerSecret: string): NoteCardDrawer {
  return async (link) => {
    try {
      const { status, json } = await post(
        fetcher,
        "control_plane",
        `${controlPlaneOrigin}/agent-texts/note-card`,
        workerSecret,
        { title: link.caption, slug: link.slug },
        NOTE_CARD_TIMEOUT_MS,
      );
      const png = (json as { png?: unknown } | null)?.png;
      if (status !== 200 || typeof png !== "string" || png === "") return null;
      return { name: "note.png", mediaType: "image/png", data: png };
    } catch {
      return null;
    }
  };
}

/**
 * The picture for a text that is only a note's link, hosted where the app can
 * fetch it, with the link it shows; null to send the text as it is. Shared by
 * a 1:1 chat (`line.ts`) and a group (`groupLine.ts`). Never throws.
 */
export async function hostedNoteCard(
  text: string,
  draw: NoteCardDrawer | undefined,
  host: ((picture: Picture) => Promise<string>) | undefined,
): Promise<{ link: NoteLink; address: string } | null> {
  const link = draw && host ? noteLinkOf(text) : null;
  if (!link || !draw || !host) return null;
  const picture = await draw(link);
  const address = picture ? await host(picture).catch(() => null) : null;
  return address ? { link, address } : null;
}
