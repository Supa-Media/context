/**
 * Move a chat node "moveChat" (`texConfig.json`, Dev2's Photon switch, 2026-11-15: "I can flick a switch where their
 * existing text sends them a message to change the phone number ... one by one"): staff move one chat at a time to Tex's
 * new number from the console (Platform → Lines), and this words the one text the old line sends that chat.
 *
 * No model and no reads: the texting Worker hands in which kind of chat it is and the new number staff saved
 * (`apps/convex/functions/texOldLine.ts`), and sends the text itself on the chat's old line (`packages/tex/worker/moveChats.ts`).
 * Output `to`: "person" or "group", with the words in `text`; "skip" when there is no number to give.
 */

import { archiveSentence, formatNumber } from "../../../../src/texNumber.cjs";

const E164 = /^\+[1-9]\d{6,14}$/;

/** @param {{ kind: string, number?: string | null, archiveOn?: string | null }} input */
export async function moveChatNode(input) {
  const { kind, number, archiveOn } = input;
  if (typeof number !== "string" || !E164.test(number)) return { to: "skip" };
  const shown = formatNumber(number);
  if (kind === "group") {
    return { to: "group", text: `Hey all, swapping numbers here: same Tex, different phone number. I'm on ${shown} now, so that's me from here on.${archiveSentence(archiveOn)}` };
  }
  if (kind === "person") {
    return { to: "person", text: `Tex here, swapping numbers: I'm on ${shown} now. Same Tex, same notes, just text me there from now on.${archiveSentence(archiveOn)}` };
  }
  return { to: "skip" };
}
