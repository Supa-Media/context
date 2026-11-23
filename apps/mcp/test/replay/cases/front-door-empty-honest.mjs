import assert from "node:assert/strict";

import { EMPTY_FALLBACK, EMPTY_NOTICE, emptyFallback } from "../../../../../packages/tex/gateway/agent/replyChecks.js";
import { frontDoorChecks } from "../../../../../packages/tex/gateway/agent/untriedWeb.js";

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
  },
};
