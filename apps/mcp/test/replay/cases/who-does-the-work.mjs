import assert from "node:assert/strict";

import { TEX_PROMPT_WORDS, texModules } from "../../../../../packages/tex/gateway/agent/texConfig.js";

/**
 * The front door's rules named "do the ask" and "hand over a code, a captcha
 * or a payment" in several files, and never said a check-in offers the next
 * step and does not start it. Training already splits those (a check-in
 * offers, an ask does the work, a routine does its one step, a password
 * change after a possible break-in waits). The words now say that once.
 */
export default {
  id: "who-does-the-work",
  incident:
    "2026-11-17: the front door's own words told it to do an ask and, in other files, to offer after a recommendation, and never said which of those a check-in is. A check-in that found mail and an ask that said \"just edit it\" read as opposite advice. 2026-11-19 Training: the \"suggest a default\" line led Tex to hand a dropped shift to the rest of the crew and to offer resending a bounced email the same way.",
  cause:
    "The ask, the check-in, the routine, what is shown first, and the few steps only a person can do were each written somewhere else. No one block named the split. The \"suggest a default\" line never said whose choice a shared job is, or what to do after a bounce.",
  path: "1:1 text",
  async run() {
    const taught = texModules().texts.map((name) => TEX_PROMPT_WORDS[name]).join("\n");
    assert.match(taught, /On a check-in, say what came in and offer the next step, and don't start it/, "a check-in offers the next step and does not start it");
    assert.match(taught, /password change after a possible break-in/, "a password change after a possible break-in is handed over");
    assert.equal((taught.match(/a code, a captcha, a payment/g) ?? []).length, 1, "the hand-over list is written once");
    assert.match(taught, /name the gap and ask who covers it, never hand it to the rest/, "a dropped shared job is named and asked about, not assigned to the rest");
    assert.match(taught, /say it didn't arrive and offer a different way to reach them, never the same way again/, "a bounce gets another route, not a resend");
  },
};
