/**
 * Each sticker a group chat keeps, looked at once so Decide knows what it is (node `stickerLook`, off on main until a
 * Lab draft turns it on; Dev2, 2026-11-25). Decide offers kept stickers by id (`stickers.ts` `stickersAsk`), and an id
 * says nothing about the picture: in the Lab it picked the emoji every time.
 *
 * After a message is kept, the chat object asks this for the chat's stickers with no words yet (`unlookedStickers`, a
 * few at a time, a failed one again after `LOOK_AGAIN_MS`): it fetches each one's picture off Photon's line by its guid
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
    for (const sticker of waiting) {
      // Tried now, whatever comes back but "off": a sticker that cannot be read waits `LOOK_AGAIN_MS` before it is tried again.
      const tried = () => noteLooked(storage, sticker.id, deps.now());
      const url = await deps.pictureUrl(sticker.guid).catch(() => null);
      if (url === null) return done("failed", looked);
      const [picture] = await prepareAttachments([{ url, mimeType: "image/png", filename: "sticker", size: null }], { fetch: deps.fetch, images: deps.images });
      if (picture === undefined || !("data" in picture)) {
        await tried();
        continue;
      }
      const response = await deps.texts.fetch("https://gateway/texts/sticker-look", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat, sticker: sticker.id, mediaType: picture.mediaType, data: picture.data }),
      });
      if (!response.ok) {
        await tried();
        return done("failed", looked);
      }
      const answer = (await response.json().catch(() => null)) as { when?: unknown; why?: unknown; words?: unknown } | null;
      // The node off: nothing is looked at until a draft turns it on, and the stickers wait as they are.
      if (Array.isArray(answer?.when) && answer.when.includes("skip") && answer.why === "off") {
        await storage.put(OFF_KEY, deps.now());
        return done("off", looked);
      }
      if (typeof answer?.words === "string" && answer.words !== "") {
        await noteLooked(storage, sticker.id, deps.now(), answer.words);
        looked += 1;
      } else await tried();
    }
    return done("looked", looked);
  } catch {
    return done("failed");
  }
}
