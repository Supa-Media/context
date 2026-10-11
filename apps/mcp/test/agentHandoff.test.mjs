/**
 * Handing the browser to the person (`src/agent/browse.js`), after the
 * 2026-10-10 conversation where Tex said "a link is on its way" and none came:
 * a browser that cannot be handed over is never described as one that can,
 * and a handoff that made no link ends the reply with the gateway's own line
 * saying so, whatever the model wrote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL, NO_LINK_LINE } from "../src/agent/browse.js";

function fakeComputer({ canHandOff, liveUrl = null }) {
  return {
    canHandOff: () => canHandOff,
    mayResume: () => canHandOff,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps) {
      const url = steps.find((step) => step.do === "goto")?.url ?? "https://shop.example.com/login";
      return {
        session: "sess-handoff-0001",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url, title: "Sign in", text: "", truncated: false, elements: [] },
        ...(liveUrl ? { liveUrl } : {}),
      };
    },
    async closeBrowser() {},
  };
}

const description = (web) => web.tools.find((tool) => tool.name === BROWSE_TOOL).description;
const handoffSteps = { steps: [{ do: "goto", url: "https://shop.example.com/" }, { do: "handoff" }] };

test("a browser that can be handed over is described as one, and its link ends the reply", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, liveUrl: "https://live.example.com/abc" }), "sign in on shop.example.com");
  assert.match(description(web), /a link to this browser is added to your reply/);
  await web.call(BROWSE_TOOL, handoffSteps);
  assert.match(web.browser.handoffLine(), /https:\/\/live\.example\.com\/abc/);
});

test("a browser that cannot be handed over never promises a link", () => {
  const web = webSession(fakeComputer({ canHandOff: false }), "sign in on shop.example.com");
  assert.doesNotMatch(description(web), /a link to this browser is added/);
  assert.match(description(web), /never promise them a link/);
});

test("a handoff that made no link ends the reply with the gateway's line saying so", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, liveUrl: null }), "sign in on shop.example.com");
  assert.equal(web.browser.handoffLine(), null, "nothing to say before a handoff is asked for");
  const result = await web.call(BROWSE_TOOL, handoffSteps);
  assert.match(result.content[0].text, /could not be made/);
  assert.equal(web.browser.handoffLine(), NO_LINK_LINE);
});

test("browsing with no handoff adds no line", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, liveUrl: null }), "look at shop.example.com");
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  assert.equal(web.browser.handoffLine(), null);
});
