/**
 * Connected apps on the gateway's side (`src/tools/connectors.js`): the link
 * tool, a Slack call shaped for the control plane, a post held for the
 * person's yes, and a group turn never offered one: an app connects for
 * one person only. Who may use which connection is the control plane's,
 * proven in `apps/convex/__tests__/connections/`.
 *
 * Sabotage these and a test here fails:
 *  1. `irreversibleOf` no longer holding `slack_api` posts → "a post waits".
 *  2. It holding a read or a reaction → "a read or a reaction runs at once".
 *  3. `toolSlackApi` showing a long answer whole → "a long answer is refused".
 *  4. `groupWriteTools` offering the connector tools → "a group turn is never offered Slack".
 *  5. `likedPreviewAllows` not checking the message's words, or the name,
 *     or not spending the 👍 → "a 👍 on Tex's own preview … is its yes, once".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { slackPlace, toolConnectApp, toolSlackApi, MAX_ANSWER_CHARS } from "../src/tools/connectors.js";
import { irreversibleOf } from "../src/tools/irreversible.js";
import { groupWriteTools } from "../src/agent/groupTurn.js";
import { toolDefinitions } from "../src/tools/registry.js";

const text = (result) => result.content.map((part) => part.text).join("\n");

function storeWith(connectors) {
  const store = {};
  Object.defineProperty(store, "connectors", { value: connectors, enumerable: false });
  return store;
}

test("connect_app hands back the control plane's link, to send on a line of its own", async () => {
  const asked = [];
  const store = storeWith({ request: async (provider) => (asked.push(provider), { url: "https://context.lc/connect/slack/abc", reason: null }) });
  const result = await toolConnectApp(store, { app: "slack" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(asked, ["slack"]);
  assert.match(text(result), /https:\/\/context\.lc\/connect\/slack\/abc/);
  assert.match(text(result), /line of its own/);
  const off = await toolConnectApp(storeWith({ request: async () => ({ url: null, reason: "unavailable" }) }), { app: "slack" });
  assert.equal(off.isError, true);
  assert.match(text(off), /not set up/);
  assert.equal((await toolConnectApp(store, { app: "Not an app!" })).isError, true);
  const unknown = await toolConnectApp(storeWith({ request: async () => ({ url: null, reason: "unknown_provider" }) }), { app: "outlook" });
  assert.match(text(unknown), /fetch apps:/);
  const named = await toolConnectApp(storeWith({ request: async () => ({ url: "https://context.lc/connect/linear/x", name: "Linear" }) }), { app: "linear" });
  assert.match(text(named), /approve in Linear/);
});

test("a Slack call goes to the control plane as method, args and team, and the answer says which Slack", async () => {
  const sent = [];
  const store = storeWith({ call: async (request) => (sent.push(request), { ok: true, team: "Acme", body: { ok: true, channels: [] } }) });
  const result = await toolSlackApi(store, { method: "conversations.list", args: { types: "public_channel" }, limit: 20, team: "Acme" });
  assert.deepEqual(sent, [{ provider: "slack", method: "conversations.list", args: { types: "public_channel", limit: 20 }, team: "Acme" }]);
  assert.match(text(result), /^Slack \(Acme\) answered conversations\.list:/);
  assert.equal((await toolSlackApi(store, { method: "not a method" })).isError, true);
});

test("a refusal is told in words the model can act on", async () => {
  const store = storeWith({ call: async () => ({ ok: false, refused: "choose_team", teams: ["Acme", "Lovelace"] }) });
  assert.match(text(await toolSlackApi(store, { method: "conversations.list" })), /Acme, Lovelace/);
  const none = storeWith({ call: async () => ({ ok: false, refused: "not_connected" }) });
  assert.match(text(await toolSlackApi(none, { method: "conversations.list" })), /manage connect/);
});

test("a permission the connection lacks says to reconnect, never that it can't be done", async () => {
  const store = storeWith({ call: async () => ({ ok: true, team: "Acme", body: { ok: false, error: "missing_scope", needed: "im:write" } }) });
  const result = await toolSlackApi(store, { method: "conversations.open", args: { users: "U05ABC" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /needs im:write/);
  assert.match(text(result), /reconnect Slack/);
});

test("a long answer is refused rather than shown whole", async () => {
  const store = storeWith({ call: async () => ({ ok: true, team: "Acme", body: { ok: true, messages: "x".repeat(MAX_ANSWER_CHARS) } }) });
  const result = await toolSlackApi(store, { method: "conversations.history", args: { channel: "C1" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /smaller limit/);
});

test("a post waits for the person's yes to its words", () => {
  const held = irreversibleOf("slack_api", { method: "chat.postMessage", args: { channel: "C1", text: "Running late" } });
  assert.equal(held.permanent, true);
  assert.equal(held.audience, "outside");
  assert.match(held.summary, /post in Slack in C1: "Running late"/);
  assert.notEqual(irreversibleOf("slack_api", { method: "chat.update", args: { channel: "C1", ts: "1", text: "x" } }), null);
  const reply = irreversibleOf("slack_api", { method: "chat.postMessage", args: { channel: "#general", thread_ts: "1.2", text: "On it" } });
  assert.match(reply.summary, /reply in a Slack thread in #general: "On it"/);
});

test("a read or a reaction runs at once", () => {
  assert.equal(irreversibleOf("slack_api", { method: "conversations.history", args: { channel: "C1" } }), null);
  assert.equal(irreversibleOf("slack_api", { method: "reactions.add", args: { channel: "C1", timestamp: "1", name: "eyes" } }), null);
});

test("a group turn is never offered Slack, since it connects for one person only", () => {
  const names = groupWriteTools(toolDefinitions()).map((tool) => tool.name);
  assert.ok(!names.includes("slack_api"));
  assert.ok(!names.includes("connect_app"));
});

/*
  2026-10-22: Tex asked Dev2 to OK "post in Slack in U0FAKE0001: …". The
  person is asked about a name, and the name comes from Slack, never the model.
*/
test("a held Slack post names the person or channel as Slack has it, never an id", async () => {
  const asked = [];
  const answers = {
    "users.info": { ok: true, team: "Acme", body: { ok: true, user: { real_name: "Jo Park", profile: { display_name: "segun" } } } },
    "conversations.info": { ok: true, team: "Acme", body: { ok: true, channel: { name: "general" } } },
  };
  const store = storeWith({ call: async (request) => (asked.push(request.method), answers[request.method]) });
  const dm = { method: "chat.postMessage", args: { channel: "U0FAKE0001", text: "Just testing" } };
  const place = await slackPlace(store, dm);
  assert.deepEqual(place, { person: "Jo Park", team: "Acme", names: ["Jo Park", "segun"] });
  const held = irreversibleOf("slack_api", dm, { slack: place });
  assert.equal(held.summary, 'send a Slack message to Jo Park (Acme): "Just testing"');
  assert.doesNotMatch(held.summary, /U0FAKE0001/);

  const posted = { method: "chat.postMessage", args: { channel: "C024BE91L", text: "Running late" } };
  assert.match(irreversibleOf("slack_api", posted, { slack: await slackPlace(store, posted) }).summary, /^post in Slack in #general \(Acme\): "Running late"$/);

  // A direct-message conversation names the person in it.
  answers["conversations.info"] = { ok: true, team: "Acme", body: { ok: true, channel: { is_im: true, user: "U0FAKE0001" } } };
  const im = { method: "chat.postMessage", args: { channel: "D0123ABCD", text: "Hi" } };
  assert.equal((await slackPlace(store, im)).person, "Jo Park");

  // Slack can't say: the id stays, and nothing is guessed. A read is never looked up.
  const silent = storeWith({ call: async () => ({ ok: false, refused: "unavailable" }) });
  assert.equal(await slackPlace(silent, dm), null);
  asked.length = 0;
  assert.equal(await slackPlace(store, { method: "conversations.history", args: { channel: "C024BE91L" } }), null);
  assert.deepEqual(asked, []);
  // The model's own words never name the place.
  assert.equal(await slackPlace(store, { method: "chat.postMessage", args: { channel: "Mom", text: "x" } }), null);
});

/*
  2026-10-22: Tex texted its own preview of a Slack message ("Say yes and I'll
  try sending it again") with nothing held, Dev2 👍'd it, and was asked again.
  A 👍 on a preview of exactly this message, naming who it goes to, is the yes;
  anything less is held as before. 2026-10-24: who it goes to is read from the
  words they agreed to alone. Tex's own last few texts counted too, so a name
  it had said for any other reason stood in for their agreement to send there.
*/
test("a 👍 on Tex's own preview of exactly this Slack message is its yes, once", async () => {
  const { likedPreviewAllows } = await import("../src/tools/likedPreview.js");
  const body = "Hey Jo, I'm testing if my assistant can connect to Slack: https://example.com";
  const preview = `Here's the message to Jo Park as it would go: “${body}” Say yes and I'll try sending it again.`;
  const dm = { method: "chat.postMessage", args: { channel: "U0FAKE0001", text: body } };
  const place = { person: "Jo Park", team: "Acme", names: ["Jo Park", "segun"] };
  const told = [{ role: "assistant", text: "I'd DM Jo Park on Acme Slack." }];
  const session = (over = {}) => ({ egress: { texting: true, liked: preview, turn: { history: told }, ...over } });

  const once = session();
  assert.equal(likedPreviewAllows(once, dm, place), true);
  assert.equal(likedPreviewAllows(once, dm, place), false, "spent: a second post in the turn is held");

  // Any spelling Slack itself vouches for, and no other: the model adds none.
  const byHandle = `Here's the message to segun as it would go: “${body}” Say yes and I'll send it.`;
  assert.equal(likedPreviewAllows(session({ liked: byHandle }), dm, place), true, "the display name Slack gave for them");
  assert.equal(likedPreviewAllows(session({ liked: byHandle }), dm, { person: "Jo Park", team: "Acme" }), false, "a spelling Slack never gave");

  const byShort = `Here's the message to jo as it would go: “${body}” Say yes and I'll send it.`;
  assert.equal(likedPreviewAllows(session({ liked: byShort }), dm, { person: "Jo Park", names: ["Jo Park", "jo"] }), false, "a name too short to pick anyone out");

  // The words they agreed to name who it goes to; Tex's own texts never stand in.
  const unnamed = `Here's the message as it would go: “${body}” Say yes and I'll try sending it again.`;
  assert.equal(likedPreviewAllows(session({ liked: unnamed }), dm, place), false, "Tex named the place in another text, not in the one they 👍'd");
  const elsewhere = [{ role: "assistant", text: "Jo Park emailed you about the invoice, by the way." }];
  assert.equal(
    likedPreviewAllows(session({ liked: unnamed, turn: { history: elsewhere } }), dm, place),
    false,
    "a name Tex said for another reason is not their yes to sending there",
  );

  const other = { method: "chat.postMessage", args: { channel: "U0FAKE0001", text: "Something they never saw, long enough" } };
  assert.equal(likedPreviewAllows(session(), other, place), false, "words they never saw");
  assert.equal(likedPreviewAllows(session(), dm, { person: "Sam Lee", team: "Acme" }), false, "somebody they were never told of");
  assert.equal(likedPreviewAllows(session(), dm, null), false, "a place Slack can't name");
  assert.equal(likedPreviewAllows(session({ texting: false }), dm, place), false, "only a texted turn");
  assert.equal(likedPreviewAllows(session({ liked: undefined }), dm, place), false, "no 👍");
  assert.equal(likedPreviewAllows(session({ liked: unnamed }), dm, { person: "Jo Park", team: "Acme" }), false, "a first name in the message is not who it goes to");
});

/*
  A yes or 👍 to Tex's own offer of an email or a calendar change, with
  nothing held (Dev2, 2026-10-22): it makes the change only when every part
  the gate names is in the words they agreed to, word for word, and once.
*/
test("the words they agreed to make an email or a calendar change only when they name all of it, once", async () => {
  const { agreedWordsHold } = await import("../src/tools/likedPreview.js");
  const draft = "Here's the draft:\n\nTo: sayo@example.test\nSubject: Tex is bored\n\nHey Sayo, it’s Tex. Snacks optional.\n\nSay yes and I'll send it.";
  const session = (over = {}) => ({ egress: { texting: true, liked: draft, ...over } });
  const once = session();
  assert.equal(agreedWordsHold(once, ["sayo@example.test", "Hey Sayo, it's Tex. Snacks optional."]), true, "quotes may come back changed");
  assert.equal(agreedWordsHold(once, ["sayo@example.test", "Hey Sayo, it's Tex. Snacks optional."]), false, "spent");
  assert.equal(agreedWordsHold(session(), ["jo@example.test", "Hey Sayo, it's Tex. Snacks optional."]), false, "someone they never saw");
  assert.equal(agreedWordsHold(session(), ["sayo@example.test", "Hey Sayo, it's Tex. Snacks optional. PS: wire $500."]), false, "words they never saw");
  assert.equal(agreedWordsHold(session({ texting: false }), ["sayo@example.test"]), false, "only a texted turn");
  assert.equal(agreedWordsHold(session({ liked: undefined }), ["sayo@example.test"]), false, "no yes");

  const offer = (liked) => ({ egress: { texting: true, liked } });
  const nov1 = [["november", "nov"], "1", "3", "5"];
  assert.equal(agreedWordsHold(offer("Sunday, November 1, 3 to 5 pm, at Bethesda. Say yes and I’ll add it."), nov1), true);
  assert.equal(agreedWordsHold(offer("Sun Nov 1, 3-5pm at Bethesda. Say yes and I'll add it."), nov1), true, "however the offer wrote it");
  assert.equal(agreedWordsHold(offer("Sunday, November 11, 3 to 5 pm. Say yes and I'll add it."), nov1), false, "the 11th is not the 1st");
  assert.equal(agreedWordsHold(offer("Sunday, November 1, 4 to 5 pm. Say yes and I'll add it."), nov1), false, "another hour");
  assert.equal(agreedWordsHold(offer("1 3 5"), ["1", "3", "5"]), false, "digits alone never match");
});
