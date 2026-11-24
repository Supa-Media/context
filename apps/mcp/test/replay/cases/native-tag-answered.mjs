import assert from "node:assert/strict";
import { parsePhotonEvent } from "../../../../../packages/tex/worker/photonInbound.ts";
import { tagsTex } from "../../../../../packages/tex/worker/groupWords.ts";

const LINE = "+15555550199";
const ASKER = "+15555550100";
const FRIEND = "+15555550101";
const GUID = "any;+;ABCDEF0123456789";

/** A group text as the Photon bridge sends it, with what Photon gives beyond the words (`map.mjs`). */
const text = (guid, message) => ({
  seq: 1,
  eventId: `photon:message.received:${guid}`,
  type: "message.received",
  line: LINE,
  chat: { guid: GUID, kind: "group", participants: [ASKER, FRIEND] },
  from: ASKER,
  fromMe: false,
  at: "2026-11-23T21:00:00.000Z",
  message: { guid, service: "iMessage", ...message },
});

export default {
  id: "native-tag-answered",
  incident: "2026-11-23: Dev asked whether Tex can see @mentions in groups. iMessage writes a native tag as the bare name, so a person who tagged Tex natively reached it as \"Tex ...\", and the always-answer rule for a literal @Tex never fired; effects and other apps' cards (Apple Cash, Check In) were dropped by the bridge.",
  cause: "The Photon bridge passed neither content.mentions, nor content.expressiveSendStyleId, nor content.miniApp's words, so the texting Worker could not tell a tag from the name, nor read an effect or a card.",
  path: "group text",
  // Sabotage (2026-11-24): return the words as given in photonRich.ts taggedWords, and the tag reads as "Tex" and
  // tagsTex is false; leave `effect` or `app` unread in richWords, and their words are gone.
  async run() {
    const tagged = parsePhotonEvent(text("m-tag", { text: "Tex what time is the dinner", mentions: [{ address: LINE, start: 0, length: 3 }] }));
    assert.equal(tagged.kind, "group-message");
    assert.equal(tagged.text, "@Tex what time is the dinner", "a native tag reads as a tag");
    assert.equal(tagsTex(tagged.text), true, "so it is always answered, as a typed @Tex is");
    const named = parsePhotonEvent(text("m-name", { text: "Tex is great" }));
    assert.equal(tagsTex(named.text), false, "the bare name is still the judge's to read");
    const slam = parsePhotonEvent(text("m-slam", { text: "WE GOT THE TABLE", effect: "com.apple.MobileSMS.expressivesend.impact" }));
    assert.equal(slam.text, "(sent with Slam) WE GOT THE TABLE");
    const cash = parsePhotonEvent(text("m-cash", { text: "", balloonBundleId: "x:T:com.apple.PassbookUIService.PeerPaymentMessagesExtension", appUrl: "https://pay.example/t", app: { bundle: "com.apple.PassbookUIService.PeerPaymentMessagesExtension", caption: "$40", subcaption: "Sent" } }));
    assert.equal(cash.text, "(Apple Cash card: $40 · Sent)", "another app's card reads as its words, never its link");
  },
};
