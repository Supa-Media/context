import assert from "node:assert/strict";

import { TEX_PROMPT_WORDS, texModules } from "../../../src/agent/texConfig.js";

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
    "2026-11-17: the front door's own words told it to do an ask and, in other files, to offer after a recommendation, and never said which of those a check-in is. A check-in that found mail and an ask that said \"just edit it\" read as opposite advice.",
  cause:
    "The ask, the check-in, the routine, what is shown first, and the few steps only a person can do were each written somewhere else. No one block named the split.",
  path: "1:1 text",
  async run() {
    const taught = texModules().texts.map((name) => TEX_PROMPT_WORDS[name]).join("\n");
    assert.match(taught, /On a check-in, say what came in and offer the next step, and don't start it/, "a check-in offers the next step and does not start it");
    assert.match(taught, /password change after a possible break-in/, "a password change after a possible break-in is handed over");
    assert.equal((taught.match(/a code, a captcha, a payment/g) ?? []).length, 1, "the hand-over list is written once");
  },
};
