/**
 * Faces for Agent Mail: a person by their own face, a bot by the logo its card names, anyone else as an agent. One
 * card read per bot for the whole page (the list's rows and the open thread draw the same faces), none at all for a
 * bot the Areas page already drew this session (`botPictures.ts`; Dev2, 2026-11-26: "can we have it be instant? like
 * the person images? also for mail we should show the images on the left").
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { knownAvatar, readAvatar, readPicture, themedCardKey, type FacePicture } from "../faces/botPictures";
import { useScheme } from "../../design/theme";
import type { Face } from "../files/folderPage/Glyphs";
import { cardSlug } from "../files/folderPage/areas/seat";
import { avatarOf, botCardOf, isPersonName, type Conversation } from "./model";
import { isClaudeApp } from "../faces/ClaudeFace";
import { splitApp } from "@context/shared/src/mail.cjs";
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

/**
 * `name`'s face, and `app` the app its line was signed with (`Claude Code · @seyi`): a bot with a card is drawn by its
 * own logo; any other agent signing as Claude by Claude Code's mark with its person's face (Dev, 2026-11-26).
 */
export type FaceOf = ((name: string, app?: string | null) => Face) & {
  /** Whether `name` is a bot with a card here: its lines are its own, so the app it wrote from is not said beside it. */
  readonly isBot?: (name: string) => boolean;
};

export function useBotFaces(conversations: readonly Conversation[], io: MailNoteIO, workspaceId: string): FaceOf {
  const cards = useMemo(() => botCardsOf(conversations), [conversations]);
  const cardsKey = [...cards].map(([bot, card]) => `${bot}=${card}`).join("\n");
  // A card's dark-screen logo is drawn on a dark screen (Dev, 2026-11-27), so what a card names is kept per theme.
  const scheme = useScheme();
  const cardKey = useCallback((card: string) => themedCardKey(`${workspaceId}|${card}`, scheme), [workspaceId, scheme]);
  const readLeaf = useCallback(
    (card: string) => readAvatar(cardKey(card), async () => {
      const note = await io.read(card);
      return note.encrypted === true ? "" : avatarOf(note.text, scheme);
    }),
    [cardKey, io, scheme],
  );
  // Redrawn as each card answers; what this session already knows is drawn from the first frame, and every card is
  // read again each time the page opens, so a logo changed since is drawn (Dev, 2026-11-26: Agent Mail kept drawing a
  // bot's old logo after its card named a new one).
  const [, setAnswered] = useState(0);
  useEffect(() => {
    let live = true;
    for (const card of cards.values()) {
      const before = knownAvatar(cardKey(card));
      void readLeaf(card).then((leaf) => live && leaf !== before && setAnswered((count) => count + 1));
    }
    return () => {
      live = false;
    };
    // `cardsKey` stands for `cards`, which is a new map whenever the list is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardsKey, cardKey, readLeaf]);

  const faceOf = useCallback(
    (name: string, app?: string | null): Face => {
      if (isPersonName(name)) return { kind: "person", name };
      const card = cards.get(cardSlug(name));
      const signed = splitApp(app ?? null);
      if (card === undefined && isClaudeApp(signed.app)) return { kind: "claude", owner: signed.owner };
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
  return useMemo(() => Object.assign((name: string, app?: string | null) => faceOf(name, app), { isBot: (name: string) => !isPersonName(name) && cards.has(cardSlug(name)) }), [faceOf, cards]);
}
