import assert from "node:assert/strict";

import { webSession } from "../../../../../packages/tex/gateway/agent/computer.js";
import { BROWSE_TOOL } from "../../../../../packages/tex/gateway/agent/browse.js";
import { STUCK_LINE } from "../../../../../packages/tex/gateway/agent/captchaLadder.js";
import { browserUseFlag } from "../../../../../packages/tex/gateway/agent/browserUseFallback.js";
import { TEX_CONFIG } from "../../../../../packages/tex/gateway/agent/texConfig.js";

const PAGE = "https://register.example.org/conference";

/**
 * A browser that is already on the registration page. Browserbase answers
 * with a block or a captcha. Browser Use starts blank, so a click that does
 * not open the page fails there unless the open is replayed first.
 */
function computer({ failClick = false } = {}) {
  const calls = [];
  const rows = [];
  return {
    calls,
    rows,
    browserUseFallback: () => "on",
    canHandOff: () => true,
    mayResume: () => true,
    async noteBrowse(row) {
      rows.push(row);
    },
    async browse(_session, steps, options = {}) {
      calls.push({ provider: options.provider ?? "browserbase", steps, handoff: options.handoff === true });
      if (options.provider === "browser-use") {
        return {
          provider: "browser-use",
          session: "bu-1",
          ran: steps.map((step) => ({ do: step.do, ok: failClick ? step.do !== "click" : true })),
          page: { url: failClick ? "about:blank" : PAGE, title: "", text: failClick ? "BLANK_BROWSER" : "You're registered.", elements: [] },
        };
      }
      const blocked = steps.some((step) => step.do === "click");
      return {
        provider: "browserbase",
        session: "bb-1",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: {
          url: PAGE,
          title: "Registration",
          text: failClick ? "Verify you are human" : blocked ? "Access denied" : "Register for the conference.",
          elements: [{ ref: 1, kind: "input text", label: "Name" }, { ref: 4, kind: "button", label: "Register" }],
        },
        ...(failClick && !options.handoff ? { captcha: "unsolved", captchaKind: "widget" } : {}),
        ...(blocked && !failClick ? { blocked: { reason: "403", host: "register.example.org" } } : {}),
        ...(options.handoff ? { handoffUrl: "https://context.lc/tex/maya" } : {}),
      };
    },
    async closeBrowser() {},
  };
}

export default {
  id: "fallback-steps-cleared",
  incident:
    "2026-11-17: a site block retried on the other browser reran only the current click, on a browser that had not opened the page. The click failed, the block log still said the fallback was ok, and the hand-off was cancelled.",
  cause:
    "The retry did not rebuild the page the way a silent submit does, and a result with no captcha counted as cleared even when a step had failed.",
  path: "1:1 text",
  async run() {
    assert.equal(browserUseFlag(TEX_CONFIG, {}), "off", "the committed flag stays off");
    assert.equal(TEX_CONFIG.browsers.browserUseFallback, "off");

    const replay = computer();
    const web = webSession(replay, `open ${PAGE}, type Maya, then click Register`);
    await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }, { do: "type", ref: 1, text: "Maya" }] });
    await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
    const fallback = replay.calls.find((call) => call.provider === "browser-use");
    assert.ok(fallback, "the blocked click was tried on the other browser");
    assert.deepEqual(
      fallback.steps.map((step) => step.do),
      ["goto", "type", "click"],
      "the blank browser opens the page and redoes the steps already done, then this call",
    );
    assert.equal(fallback.steps[0].url, PAGE);
    assert.equal(fallback.steps[1].text, "Maya");

    const said = [];
    const failed = computer({ failClick: true });
    const stuck = webSession(failed, `open ${PAGE} and click Register`, { say: async (line) => (said.push(line), true) });
    const result = await stuck.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }, { do: "click", ref: 4 }, { do: "handoff" }] });
    assert.equal(failed.rows.at(-1)?.fallback?.outcome, "steps_failed");
    assert.equal(failed.rows.at(-1)?.fallback?.step, "click");
    assert.equal(result.captchaStuck, true);
    assert.equal(result.content[0].text.includes("BLANK_BROWSER"), false);
    assert.ok(result.content[0].text.includes(STUCK_LINE));
    assert.equal(said.length, 1, "the hand-off was not cancelled");
    assert.equal(failed.calls.at(-1)?.provider, "browserbase");
    assert.equal(failed.calls.at(-1)?.handoff, true);
  },
};
