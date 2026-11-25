/**
 * The Tapback node, `tapback` (config wire `tools -> tapback`, promoted 2026-11-17; `../../tapbackEnding.js`).
 * When the front door answers their text with only a tapback (Dev2, 2026-11-17: "Front door picks the tapback"), it
 * says whether the turn may end that way, and with which of the 64 emoji (`textDecide.cjs` `REACT_EMOJI`).
 *
 * No model and no reads: pure code over what it is handed, logged like every node. Output `to`: "react" with the
 * emoji the Worker sends, or "refuse" with why, in words the model reads before it writes its reply instead.
 */
import { stickerIdOf, tapbackEmoji } from "../../tapbackEnding.js";

/** The emoji that goes when a sticker asked for with an emoji off the list can't be stuck. */
const STICKER_FALLBACK = "❤️";

/**
 * `lastFailed`: the last call this turn made before it failed (only the last: one that fails beside it in the same
 * round is caught when the round settles, `tapbackEnding.js`). `tagged`: a literal @Tex tag, always answered in words,
 * as `say_nothing` is refused there (Dev2, 2026-11-12).
 * `sticker`: a sticker of this chat's, by its id, asked for in the emoji's place (only while the step's "Chat stickers"
 * setting is on, `tapbackEnding.js`); handed on when it reads as one, and the Worker checks the chat kept it.
 * @param {{ emoji: string, why?: string, lastFailed?: boolean, tagged?: boolean, sticker?: string }} input
 */
export async function tapbackNode(input) {
  const refuse = (why) => ({ to: "refuse", why });
  if (input?.tagged === true) return refuse("they tagged you by name, so this turn answers them in words; reply with text instead");
  if (input?.lastFailed === true) return refuse("your last call failed, so tell them what happened in words");
  const sticker = stickerIdOf(input?.sticker);
  // With a sticker, the emoji only goes if the sticker can't: an emoji off the list never holds the sticker back
  // (Battle of the Bots, 2026-11-25: "use that sticker" with 🤖 was refused, then the retry was refused as a failed call).
  const emoji = tapbackEmoji(input?.emoji) ?? (sticker ? STICKER_FALLBACK : null);
  if (emoji === null) return refuse("a tapback is one of the listed emoji, and that one isn't; pick one of them");
  return { to: "react", emoji, ...(sticker ? { sticker } : {}) };
}
