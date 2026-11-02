/**
 * A like known to be on somebody else's message is not the yes to the ask.
 *
 * `onTheAsk` promotes a like with no words to the ask still waiting, for a
 * message whose words could not be read (#2089): the gateway then checks
 * those words against what is armed (`thumbsUpIsYes`). The words promoted
 * are the very string that check compares, so the promotion has to be
 * reserved for the case it was written for.
 *
 * On WhatsApp it was not. Every reaction arrives with no words
 * (`whapiInbound.ts` `tapbackOf`) and they are filled in from the message
 * it was on; a message read and found not to be Tex's own left them empty
 * too (`index.ts`), which is the ordinary shape of liking one's own
 * earlier text. That reached `onTheAsk` as "could not read" and was taken
 * for the ask, so a like on one's own message answered an armed "Here's
 * the email I'd send" or "Before I pay".
 *
 * `onOther` now keeps the two apart: read and not Tex's names no ask;
 * unread still falls back, as Sendblue's bare tapbacks rely on.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `onTheAsk` promoting on empty words whatever `onOther` says (as
 *     shipped). → `a like read and found not to be Tex's …` fails.
 *  2. `index.ts` dropping `onOther` from the reaction it builds. → `the
 *     WhatsApp path marks …` fails.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { holdsAsYes, onTheAsk, rememberAskReply } from "./thumbs";

const NOW = 1_800_000_000_000;
const ASK = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\nGive it a 👍 and I'll send it.";
const CHAT = "Sure, I'll keep an eye on it.";

async function withAsk() {
  const storage = new MemoryStorage();
  await rememberAskReply(storage, [CHAT, ASK], NOW);
  return storage;
}

describe("placing a like that carries no words", () => {
  it("a like read and found not to be Tex's own answers no ask", async () => {
    const got = await onTheAsk(await withAsk(), { how: "Liked", words: "", onOther: true }, NOW + 60_000);

    expect(got.words).toBe("");
    expect(holdsAsYes(got)).toBe(false);
  });

  it("a like whose message could not be read still falls back to the ask", async () => {
    const got = await onTheAsk(await withAsk(), { how: "Liked", words: "" }, NOW + 60_000);

    expect(got.words).toBe(ASK);
    expect(holdsAsYes(got)).toBe(true);
  });

  it("a like on a text of the reply that carried the ask is still the ask", async () => {
    const got = await onTheAsk(await withAsk(), { how: "Liked", words: CHAT }, NOW + 60_000);

    expect(got.words).toBe(ASK);
    expect(holdsAsYes(got)).toBe(true);
  });
});
