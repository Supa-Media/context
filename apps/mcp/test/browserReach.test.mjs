/**
 * What a turn is told about its browser follows from what it can call (Dev2, 2026-11-27: a change in one place, and
 * the other parts kept telling the old story). A Lab test chat refuses every browser tool (`labSandbox/policy.js`
 * `NO_MACHINE`), yet its group prompt said "this chat has its own browser" and the claim checks pushed it to try one.
 * Now the sandbox's own check takes those tools off the turn's list (`turnWeb.js`), and the prompt and the claim
 * checks read that list (`browserReach.js`).
 *
 * Sabotage record (2026-11-27): dropping the filter in `openTurnWeb` fails "a test chat's turn is offered no browser";
 * taking `fill_card` out of NO_MACHINE fails "every browser tool is one the sandbox refuses" and the test after it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS, hasBrowser } from "../../../packages/tex/gateway/agent/browserReach.js";
import { openTurnWeb } from "../../../packages/tex/gateway/agent/turnWeb.js";
import { groupPrompt } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { GROUP_BROWSER_LINES } from "../../../packages/tex/gateway/agent/groupSignIns.js";
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
  assert.ok(groupPrompt(GROUP, "supa").includes(GROUP_BROWSER_LINES), "unchanged for a caller that says nothing");
  assert.ok(groupPrompt(GROUP, "supa", { browser: true }).includes(GROUP_BROWSER_LINES));
  const none = groupPrompt(GROUP, "supa", { browser: false });
  assert.doesNotMatch(none, /own browser/);
  assert.doesNotMatch(none, /stays signed in/);
  assert.equal(hasBrowser(null), false);
  assert.equal(hasBrowser({ tools: [{ name: "web_search" }] }), false);
});
