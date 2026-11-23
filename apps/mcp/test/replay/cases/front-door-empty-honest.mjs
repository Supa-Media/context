import assert from "node:assert/strict";

import { EMPTY_FALLBACK, EMPTY_NOTICE, emptyFallback } from "../../../../../packages/tex/gateway/agent/replyChecks.js";
import { frontDoorChecks } from "../../../../../packages/tex/gateway/agent/untriedWeb.js";
import { translateFetch } from "../../../src/tools/v2/searchFetch.js";

export default {
  id: "front-door-empty-honest",
  incident:
    "2026-11-22: asked to reply to an email looping someone in, Tex's three send calls were refused, it ended with an empty answer, and the person was texted \"Sorry, my answer to that one got lost.\" Nothing was lost: the email was never sent.",
  cause:
    "The front door ran no reply checks, so the empty answer never got the round every other turn gets to answer in words; and the line put in its place said the answer was lost instead of what really failed.",
  path: "1:1 text",
  async run() {
    // The front door's own checks now send an empty answer back once, as `claimCheck.js` does for every other turn.
    const checks = frontDoorChecks({ claims: null, runner: false, texted: true, group: null, question: "can you reply looping her in?" });
    assert.equal(checks.check(""), EMPTY_NOTICE);
    assert.notEqual(checks.check(""), EMPTY_NOTICE, "once a turn");

    // Still empty after that: the line names what did not go through, and never says it was lost.
    const line = emptyFallback([{ tool: "send", action: "email" }, { tool: "send", action: "email" }, { tool: "send", action: "email" }]);
    assert.match(line, /the email didn't go through/);
    assert.doesNotMatch(line, /lost/);
    assert.doesNotMatch(EMPTY_FALLBACK, /lost/);

    // 2026-11-23, the same ask in a Lab test chat: Tex fetched the email with from: the sender and summary: true, was
    // refused on types, and ended empty. Those two are an attachment's; the refusal now says so and how to read the email.
    const id = "email:me@team.example/1a205a21935afbd5";
    // The offset is now `start`: `from` read as the sender. A `from` is refused saying the sender is in the id.
    const sender = translateFetch({ id, args: { from: "sarah@team.example" } });
    assert.match(sender.error, /takes no from: the sender is already in the id/);
    assert.match(sender.error, /Call it again with no args to read the email/);
    const summed = translateFetch({ id, args: { summary: true } });
    assert.match(summed.error, /reads the whole email with no args/);
    assert.match(summed.error, /start \(where to pick up in a long attachment/);
    assert.equal(translateFetch({ id, args: { attachment: 1, start: 4000 } }).error, undefined);
    assert.equal(translateFetch({ id }).error, undefined);
    assert.match(translateFetch({ id, args: { mail: true } }).error, /go only with attachment/);
  },
};
