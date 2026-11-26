/**
 * Faces for Agent Mail: a person by their own face, a bot by the logo its card names, anyone else as an agent. One
 * card read per bot for the whole page (the list's rows and the open thread draw the same faces), none at all for a
 * bot the Areas page already drew this session (`botPictures.ts`; Dev2, 2026-11-26: "can we have it be instant? like
 * the person images? also for mail we should show the images on the left").
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { knownAvatar, readAvatar, readPicture, type FacePicture } from "../faces/botPictures";
import type { Face } from "../files/folderPage/Glyphs";
import { cardSlug } from "../files/folderPage/areas/seat";
import { avatarOf, botCardOf, isPersonName, type Conversation } from "./model";
import type { MailNoteIO } from "./MailThread";

/** Each bot this mail is with, by its mail name, and its card: `grok-bot` → `bots/grok-bot/about.md`. */
export function botCardsOf(conversations: readonly Pick<Conversation, "path" | "place">[]): Map<string, string> {
  const cards = new Map<string, string>();
  for (const each of conversations) {
    const card = botCardOf(each);
    if (card !== null && each.place.kind === "bot" && !cards.has(each.place.bot)) cards.set(each.place.bot, card);
  }
  return cards;
}

export function useBotFaces(conversations: readonly Conversation[], io: MailNoteIO, workspaceId: string): (name: string) => Face {
  const cards = useMemo(() => botCardsOf(conversations), [conversations]);
  const cardsKey = [...cards].map(([bot, card]) => `${bot}=${card}`).join("\n");
  const cardKey = useCallback((card: string) => `${workspaceId}|${card}`, [workspaceId]);
  const readLeaf = useCallback(
    (card: string) => readAvatar(cardKey(card), async () => {
      const note = await io.read(card);
      return note.encrypted === true ? "" : avatarOf(note.text);
    }),
    [cardKey, io],
  );
  // Redrawn as each card answers; what this session already knows is drawn from the first frame.
  const [, setAnswered] = useState(0);
  useEffect(() => {
    let live = true;
    for (const card of cards.values()) {
      if (knownAvatar(cardKey(card)) !== undefined) continue;
      void readLeaf(card).then(() => live && setAnswered((count) => count + 1));
    }
    return () => {
      live = false;
    };
    // `cardsKey` stands for `cards`, which is a new map whenever the list is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardsKey, cardKey, readLeaf]);

  return useCallback(
    (name: string): Face => {
      if (isPersonName(name)) return { kind: "person", name };
      const card = cards.get(cardSlug(name));
      const read = io.picture;
      if (card === undefined || read === undefined) return { kind: "agent" };
      const leaf = knownAvatar(cardKey(card));
      if (leaf === "") return { kind: "agent" };
      const logo = (named: string): FacePicture => ({ key: io.pictureKey?.(named) ?? `${card}|${named}`, read: () => read(card, named) });
      if (leaf !== undefined) return { kind: "agent", picture: logo(leaf) };
      // The card isn't read yet: the face waits for it, drawn plain rather than as a robot that then becomes the logo.
      return {
        kind: "agent",
        picture: {
          key: `${cardKey(card)}|card`,
          read: async () => {
            const named = await readLeaf(card);
            return named === "" ? null : readPicture(logo(named));
          },
        },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardsKey, cardKey, io, readLeaf],
  );
}
