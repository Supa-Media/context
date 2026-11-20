import assert from "node:assert/strict";
import { parsePhotonEvent } from "../../../../../packages/tex/worker/photonInbound.ts";
import { reactionLine } from "../../../../../packages/tex/worker/reactions.ts";

const LINE = "+15555550199";
const VOTER = "+15555550100";
const GUID = "any;+;ABCDEF0123456789";

/** A tapback in a group as the Photon bridge sends it, the target read by the bridge (`enrich.mjs`). */
const tapback = (kind, targetText) => ({
  seq: 1,
  eventId: `photon:message.reactionAdded:vote-${kind}`,
  type: "message.reactionAdded",
  line: LINE,
  chat: { guid: GUID, kind: "group", participants: [VOTER, "+15555550101"] },
  from: VOTER,
  fromMe: false,
  at: "2026-11-18T19:09:00.000Z",
  reaction: { kind, targetGuid: "msg-option", targetText, targetFromMe: false },
});

export default {
  id: "tapback-vote-named",
  incident: "2026-11-18: in a group chat a person posted two options, \"Thumbs up here if ...\" and \"thumbs down here if ...\", the others voted by tapback, and asked Tex for the results; Tex said there was no poll.",
  cause: "Every tapback on a person's message reached the chat's record as \"👍 (yes) on a message\": the bridge read the message's words, and the texting Worker dropped them unless the message was Tex's, so nothing said which option each vote was on.",
  path: "group text",
  // Sabotage (2026-11-19): drop `otherWords` in photonInbound.ts targetOf, or stop reading it in reactions.ts
  // reactionLine, and the line is "👍 (yes) on a message" again.
  async run() {
    const up = parsePhotonEvent(tapback("like", "Thumbs up here if lunch at noon"));
    assert.equal(up.kind, "group-message");
    assert.equal(reactionLine(up.reaction, false), '👍 (yes) on the message "Thumbs up here if lunch at noon"', "the vote names the option it was on");
    assert.equal(up.reaction.words, "", "somebody else's words are never taken for an ask of Tex's (thumbs.ts matches a yes on words)");
    const down = parsePhotonEvent(tapback("dislike", "thumbs down here if lunch at one"));
    assert.equal(reactionLine(down.reaction, false), '👎 (no) on the message "thumbs down here if lunch at one"');
  },
};
