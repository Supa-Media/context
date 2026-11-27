/**
 * What a turn is told about its browser follows from what it can call (Dev2, 2026-11-27: a change in one place, and
 * the other parts kept telling the old story). A Lab test chat refuses every browser tool (`labSandbox/policy.js`
 * `NO_MACHINE`), yet its group prompt said "this chat has its own browser" and the claim checks pushed it to try one.
 * Now the sandbox's own check takes those tools off the turn's list (`turnWeb.js`), and the prompt and the claim
 * checks read that list (`browserReach.js`).
 *
 * Sabotage record (2026-11-27): dropping the filter in `openTurnWeb` fails "a test chat's turn is offered no browser";
 * taking `fill_card` out of NO_MACHINE fails "every browser tool is one the sandbox refuses" and the test after it.
 *
 * The written guidance follows the same fact (slice 2, Dev2 2026-11-27 "yea we should go ahead with this"): a notice
 * is written for a turn with every tool, and `forReach` leaves out what sends Tex to a browser the turn doesn't have.
 * Every claim-check notice goes through it (`claimCheck.js` `keep`), so a notice added later is covered too.
 * Sabotage record: making `forReach` return its text unchanged fails "no claim-check notice sends a turn with no
 * browser to one"; dropping the browser filter in `untriedRoutes` fails the same test; dropping the
 * `browser_in_this_turn` line from `webPrompt` fails "the web prompt says so as data".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, forReach, hasBrowser } from "../../../packages/tex/gateway/agent/browserReach.js";
import { HANDBACK_NOTICE, claimCheck } from "../../../packages/tex/gateway/agent/claimCheck.js";
import { webPrompt } from "../../../packages/tex/gateway/agent/computer.js";
import { openTurnWeb } from "../../../packages/tex/gateway/agent/turnWeb.js";
import { groupPrompt } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { LAB_SANDBOX_KEY, sandboxRefusesTool } from "../src/labSandbox/policy.js";

const GROUP = { key: "a".repeat(64), members: "b".repeat(64), from: "seyi", chat: [] };
const SITE_SHOTS = { fetch: async () => Response.json({ ran: [], page: { url: "https://example.com/", title: "", text: "", elements: [] } }) };
const session = { actorUserId: "user_a", workspaceId: "ws_shared", egress: {} };
const store = {
  async get() {
    return null;
  },
  async put() {},
  actor: { workspaceId: "ws_shared", userId: "user_a" },
  contexts: [{ current: true, kind: "shared", name: "supa" }],
};

const open = (env) => openTurnWeb(env, { session, texting: false, group: GROUP, question: "Tex look at example.com", vouched: "Tex look at example.com", channel: null, store, dispatch: null, ledger: {} });

test("every browser tool is one the sandbox refuses, so a test chat's list and its refusals agree", () => {
  const env = { [LAB_SANDBOX_KEY]: { record() {} } };
  for (const name of BROWSER_TOOLS) assert.equal(sandboxRefusesTool(env, name), true, name);
  assert.equal(sandboxRefusesTool({}, "browse"), false, "a real turn refuses nothing here");
  assert.equal(sandboxRefusesTool(env, "web_search"), false);
});

test("a test chat's turn is offered no browser, and a real one with a computer is", async () => {
  const real = await open({ SITE_SHOTS, GATEWAY_SECRET: "test-secret" });
  assert.equal(hasBrowser(real.web), true, "the live chat's browser");
  const lab = await open({ SITE_SHOTS, GATEWAY_SECRET: "test-secret", [LAB_SANDBOX_KEY]: { record() {} } });
  assert.ok(lab.web.tools.length > 0, "the test chat keeps its other web tools");
  assert.equal(hasBrowser(lab.web), false);
  for (const tool of lab.web.tools) assert.equal(sandboxRefusesTool({ [LAB_SANDBOX_KEY]: { record() {} } }, tool.name), false, tool.name);
});

test("the group prompt names a browser only when one is offered", () => {
  assert.match(groupPrompt(GROUP, "supa"), /this chat has its own browser/, "unchanged for a caller that says nothing");
  assert.match(groupPrompt(GROUP, "supa", { browser: true }), /stays signed in for this chat's later asks/);
  const none = groupPrompt(GROUP, "supa", { browser: false });
  assert.doesNotMatch(none, /own browser/);
  assert.doesNotMatch(none, /stays signed in/);
  assert.equal(hasBrowser(null), false);
  assert.equal(hasBrowser({ tools: [{ name: "web_search" }] }), false);
});

/** Anything that sends Tex to its own browser. */
const SENDS_TO_THE_BROWSER = /your browser|browser call|\bbrowse\b(?! said)/i;

test("no claim-check notice sends a turn with no browser to one, and a turn with one keeps every line", async () => {
  const handback = "I couldn't find the receipt. Can you check their site and forward it to me?";
  const gaveUp = "Planning Center isn't answering right now, so I can't tell you who's serving.";
  const run = async (tools) => {
    const claims = claimCheck({ question: "who's serving sunday? and get the receipt" });
    const web = claims.wrapWeb({ tools: tools.map((name) => ({ name })), call: async () => ({ content: [] }) });
    await claims.wrap(async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }))("app_read", { app: "planning-center" });
    void web;
    const couldnt = "I couldn't open the Uber site, so I can't get the receipt.";
    return [await claims.check(handback), await claims.check(gaveUp), await claims.check(couldnt)].filter(Boolean).join("\n");
  };
  const none = await run(["search_web", "open_page"]);
  assert.ok(none.length > 0, "the notices still went");
  assert.doesNotMatch(none, SENDS_TO_THE_BROWSER, none);
  assert.match(none, /captcha browse said/, "a sentence that only names browse is kept");
  const some = await run(["search_web", "open_page", "browse"]);
  assert.ok(some.includes(HANDBACK_NOTICE), "a turn with a browser gets the notice as written");
  assert.equal(forReach(HANDBACK_NOTICE, { browser: true }), HANDBACK_NOTICE);
});

test("the web prompt says so as data when the turn has no browser", () => {
  assert.match(webPrompt(new Set(["search_web", "open_page"])), /\{"browser_in_this_turn":false\}/);
  assert.doesNotMatch(webPrompt(new Set(["search_web", "open_page", "browse"])), /browser_in_this_turn/);
});
