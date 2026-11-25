/**
 * Each sticker a group chat keeps, looked at once so Decide knows what it is (node `stickerLook`, turned on by a Lab
 * promote; Dev2, 2026-11-25). Decide offers kept stickers by id (`stickers.ts` `stickersAsk`), and an id
 * says nothing about the picture: in the Lab it picked the emoji every time.
 *
 * After a message is kept, the chat object asks this for the chat's stickers with no words yet (`unlookedStickers`, all
 * of them, `LOOK_AT_ONCE` at a time, a failed one again after `LOOK_AGAIN_MS`): it fetches each one's picture off Photon's line by its guid
 * (a signed `/photon/attachment/<guid>` address, `photon.ts`, minted by the texting Worker over its RPC entrypoint
 * when this object runs in the gateway, `TexRoutines.stickerPictureUrl`), makes it a picture the model reads (`attachments.ts`:
 * HEIC to JPEG), and asks the gateway's `/texts/sticker-look` on the `TexTexts` binding, naming the chat's ledger key so
 * the run is logged in the chat's record. The words that come back are kept beside the sticker (`noteLooked`).
 *
 * Never waits a message and never throws; logged on every path, codes only.
 */

import { prepareAttachments, type ImagesLike } from "./attachments";
import type { Fetch } from "./clients";
import type { TextsBinding } from "./gatewaySession";
import { sha256Hex } from "./groupChat";
import type { InboxStorage } from "./inbox";
import { noteLooked, unlookedStickers } from "./stickers";

export type StickerLookDeps = {
  texts?: TextsBinding;
  fetch: Fetch;
  images?: ImagesLike;
  /** A signed address for a kept sticker's picture on Photon's line, by its guid (`photon.ts`); null where none is served. */
  pictureUrl: (guid: string) => Promise<string | null>;
  now: () => number;
};

export type StickerLookOutcome = "none" | "looked" | "off" | "no_gateway" | "failed";

/** While the gateway answers "off" (the node off), no picture is fetched again for this long. */
export const OFF_FOR_MS = 30 * 60 * 1000;
const OFF_KEY = "sticker-look:off";

/** How many pictures are asked about at once. */
export const LOOK_AT_ONCE = 5;

type Answer =
  | { kind: "words"; id: string; words: string }
  | { kind: "none" | "refused"; id: string }
  | { kind: "no_address" | "off"; id: string };

/** Ask about one sticker's picture. Never throws: a throw is "none". */
async function askOne(sticker: { id: string; guid: string }, chat: string, deps: StickerLookDeps): Promise<Answer> {
  const { id } = sticker;
  try {
    const url = await deps.pictureUrl(sticker.guid).catch(() => null);
    if (url === null) return { kind: "no_address", id };
    const [picture] = await prepareAttachments([{ url, mimeType: "image/png", filename: "sticker", size: null }], { fetch: deps.fetch, images: deps.images });
    if (picture === undefined || !("data" in picture)) return { kind: "none", id };
    const response = await deps.texts!.fetch("https://gateway/texts/sticker-look", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat, sticker: id, mediaType: picture.mediaType, data: picture.data }),
    });
    if (!response.ok) return { kind: "refused", id };
    const answer = (await response.json().catch(() => null)) as { when?: unknown; why?: unknown; words?: unknown } | null;
    // The node off: nothing is looked at until a draft turns it on, and the stickers wait as they are.
    if (Array.isArray(answer?.when) && answer.when.includes("skip") && answer.why === "off") return { kind: "off", id };
    return typeof answer?.words === "string" && answer.words !== "" ? { kind: "words", id, words: answer.words } : { kind: "none", id };
  } catch {
    return { kind: "none", id };
  }
}

/** Look at the chat's kept stickers that have no words yet. Never throws. */
export async function lookAtStickers(storage: InboxStorage, place: { line: string; groupId: string }, deps: StickerLookDeps): Promise<StickerLookOutcome> {
  const done = (outcome: StickerLookOutcome, looked = 0): StickerLookOutcome => {
    if (outcome !== "none") console.log(JSON.stringify({ event: "sticker_look", outcome, looked }));
    return outcome;
  };
  try {
    const waiting = await unlookedStickers(storage, deps.now());
    if (waiting.length === 0) return "none";
    if (deps.texts === undefined) return done("no_gateway");
    const off = await storage.get<number>(OFF_KEY);
    if (typeof off === "number" && deps.now() - off < OFF_FOR_MS) return "none";
    const chat = await sha256Hex(`${place.line}:${place.groupId}`);
    let looked = 0;
    // A few pictures asked at once, so a chat's first stickers all get words on one message; the notes are written one
    // after another, since each rewrites the chat's sticker list.
    for (let at = 0; at < waiting.length; at += LOOK_AT_ONCE) {
      const answers = await Promise.all(waiting.slice(at, at + LOOK_AT_ONCE).map((sticker) => askOne(sticker, chat, deps)));
      for (const answer of answers) {
        if (answer.kind === "off") {
          await storage.put(OFF_KEY, deps.now());
          return done("off", looked);
        }
        // Tried now, whatever came back but "off": a sticker that cannot be read waits `LOOK_AGAIN_MS` before it is tried again.
        if (answer.kind !== "no_address") await noteLooked(storage, answer.id, deps.now(), answer.kind === "words" ? answer.words : undefined);
        if (answer.kind === "words") looked += 1;
      }
      const stop = answers.find((answer) => answer.kind === "no_address" || answer.kind === "refused");
      if (stop !== undefined) return done("failed", looked);
    }
    return done("looked", looked);
  } catch {
    return done("failed");
  }
}
