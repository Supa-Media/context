import assert from "node:assert/strict";
import { withPrivateLinks } from "../../../../../packages/tex/gateway/agent/privateAside.js";
import { withVaultWatch } from "../../../../../packages/tex/gateway/agent/vaultSaved.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

export default {
  id: "group-login-on-the-side",
  incident:
    "Dev2, 2026-11-25, on what a group chat asking Tex to order with a site's login should do: \"Tex being - sure thing, and then texting " +
    "the person who asked on the side\"; \"anything that requires a user to enter sensitive information ... should be handled in 1:1\". " +
    "Before, Tex sent the private save link and the steps in the group.",
  cause:
    "A group turn was told to send whoever asked a vault_add link in the chat, and its tool answer handed the model the link, so the link " +
    "and the steps to save it went to everyone in the group.",
  path: "group text",
  // Sabotage (2026-11-25): return the vault tool's own answer from `withPrivateLinks`, or put "send whoever asked a
  // vault_add link" back in the group prompt, and this fails.
  async run() {
    const group = { ...groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] } }), home: { folder: "tex/groups/cactus-lotus-badge" } };
    const told = groupPrompt(group, "supa");
    assert.doesNotMatch(told, /send whoever asked a vault_add link/, "never told to send the link here");
    assert.match(told, /say here only that you'll text them/);
    const ledger = {};
    const token = "e".repeat(32);
    const call = withPrivateLinks(group, ledger, withVaultWatch(ledger, async () => ({ content: [{ type: "text", text: `Link to save the login: https://context.lc/vault/${token}` }] })));
    const answer = (await call("vault_add_link", { type: "login", site: "instacart.com" })).content[0].text;
    assert.doesNotMatch(answer, /vault\//, "the group's model never holds the link");
    assert.match(ledger.asides[0].texts[0], new RegExp(token), "it goes to @shyoh's own chat");
    assert.equal(ledger.vaultLinks.length, 1, "and the save still carries the group's task on");
  },
};
