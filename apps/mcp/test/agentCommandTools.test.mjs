/**
 * TEX'S CHAT COMMANDS AS TOOLS (`src/agent/commandTools.js`, Jhonatan,
 * 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`).
 *
 * "Tex, settings" worked only as an exact phrase, and a turn asked another way
 * wrote a note and said the settings were saved. The tools are the only way a
 * turn changes how Tex acts in a chat, and each answer says what happened.
 * The control plane takes the chat and person off the turn's grant
 * (`functions/texCommands.ts`, tested there); here, what each surface is
 * offered and what the turn is told.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - give a guest's tag the mail tools (drop the guestTagger branch):
 *    "a guest's tag is offered no tool that acts as a person" fails;
 *  - word a refusal as success (answered() ignoring status): "a refusal is
 *    never worded as done" fails;
 *  - send identity from the arguments (pass args through to run):
 *    "the arguments never name who acts" fails;
 *  - drop the own-words check (consent ignored in chat_share_mail):
 *    "another member's words, a quote or an email cannot share Ada's mail" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMAND_SEND_ACTIONS, OWN_WORDS_REFUSAL, commandTools, consentFor } from "../src/agent/commandTools.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { createControlPlane } from "../src/controlPlane/index.js";
import { SETTINGS_LINE } from "../src/agent/chatVoice.js";
import { systemPrompt } from "../src/agent/prompt.js";

const names = (tools) => tools.map((entry) => entry.tool.name).sort();
const byName = (tools, name) => tools.find((entry) => entry.tool.name === name);
const words = (result) => result.content[0].text;

function recorder(answer) {
  const sent = [];
  return { sent, run: async (command) => (sent.push(command), typeof answer === "function" ? answer(command) : answer) };
}

test("each surface is offered its own command tools", () => {
  const run = async () => ({ status: "done" });
  assert.deepEqual(names(commandTools({ run, group: null })), ["review_sharing_set", "tex_settings_get", "tex_style_set"]);
  assert.deepEqual(names(commandTools({ run, group: { key: "k" } })), [
    "chat_engagement_set", "chat_mute", "chat_share_mail", "chat_status", "chat_unshare_mail", "tex_settings_get", "tex_style_set",
  ]);
  assert.deepEqual(commandTools({ run: null, group: null }), []);
});

test("a guest's tag is offered no tool that acts as a person", () => {
  const tools = commandTools({ run: async () => ({ status: "done" }), group: { key: "k", guestTagger: true } });
  assert.deepEqual(names(tools), ["chat_engagement_set", "chat_mute", "chat_status", "tex_settings_get", "tex_style_set"]);
});

test("setting the style sends only the settings named, and the turn is told what was saved", async () => {
  const { sent, run } = recorder({ status: "done", style: { humor: 60, emoji: "less" } });
  const style = byName(commandTools({ run, group: { key: "k" } }), "tex_style_set");
  const result = await style.call({ humor: 60, emoji: "less", sender: "+15555550100", groupId: "other" });
  assert.deepEqual(sent, [{ kind: "style", style: { humor: 60, emoji: "less" } }]);
  assert.equal(result.isError, undefined);
  assert.match(words(result), /^Saved\. This chat's settings are now: humor 60%, emoji less\.$/);
});

test("the arguments never name who acts", async () => {
  const { sent, run } = recorder({ status: "done", address: "a@b.example", narrowed: false, count: 1, engagement: "quiet" });
  const tools = commandTools({ run, group: { key: "k" }, consent: async () => true });
  await byName(tools, "chat_share_mail").call({ address: "a@b.example", userId: "users:x", phone: "+1555" });
  await byName(tools, "chat_unshare_mail").call({ address: "a@b.example", as: "someone" });
  await byName(tools, "chat_engagement_set").call({ style: "quiet", setBy: "forged" });
  await byName(tools, "chat_mute").call({ chat: "another" });
  for (const command of sent) for (const key of Object.keys(command)) assert.ok(["kind", "address", "query", "engagement"].includes(key), key);
});

test("a refusal is never worded as done", async () => {
  for (const status of ["refused", "not_allowed", "bad_request", "mail_refused", "something_new"]) {
    const { run } = recorder({ status });
    const tools = commandTools({ run, group: { key: "k" }, consent: async () => true });
    for (const entry of tools) {
      const result = await entry.call({ humor: 10, style: "quiet", address: "a@b.example", share: true });
      assert.equal(result.isError, true, `${entry.tool.name} ${status}`);
      assert.doesNotMatch(words(result), /^(Saved|Done|Shared|Stopped)/, `${entry.tool.name} ${status}`);
    }
  }
  const thrown = byName(commandTools({ run: async () => { throw new Error("down"); }, group: null }), "tex_style_set");
  assert.equal((await thrown.call({ length: "short" })).isError, true);
  const empty = byName(commandTools({ run: async () => ({ status: "done" }), group: null }), "tex_style_set");
  assert.equal((await empty.call({})).isError, true, "no setting named changes nothing");
});

test("the settings answer lists the options, and mail sharing keeps its safety line", async () => {
  const tools = commandTools({ run: async (command) => (command.kind === "settings" ? { status: "done", style: {}, engagementChosen: true, engagement: "helpful" } : { status: "done", address: "a@b.example", narrowed: true }), group: { key: "k" }, consent: async () => true });
  const settings = words(await byName(tools, "tex_settings_get").call({}));
  assert.match(settings, /every setting at its default/);
  assert.match(settings, /When Tex speaks up here: helpful/);
  assert.match(settings, /Humor \(0 to 100% in steps of 10, default 75%\)/);
  assert.match(words(await byName(tools, "chat_share_mail").call({ address: "a@b.example" })), /Replies go from it only when they say yes\./);
});

test("the six tools show them as send actions only when the turn holds them, and resolve back", () => {
  const local = commandTools({ run: async () => ({ status: "done" }), group: null }).map((entry) => entry.tool);
  const six = sixToolsOver(local);
  const send = six.tools.find((tool) => tool.name === "send");
  assert.ok(send, "send is offered");
  assert.match(send.description, /- tex_style:/);
  assert.match(send.description, /- tex_settings:/);
  assert.doesNotMatch(send.description, /- chat_mute:/, "a 1:1 turn holds no group tools");
  assert.deepEqual(six.resolve("send", { action: "tex_style", args: { humor: 30 } }), { name: "tex_style_set", args: { humor: 30 } });
  assert.equal(Object.keys(COMMAND_SEND_ACTIONS).length, 8);
  assert.equal(sixToolsOver([]).tools.find((tool) => tool.name === "send"), undefined, "nothing held, nothing shown");
});

test("the control plane is asked with the turn's own token, and only known answers pass", async () => {
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization ?? init.headers.Authorization });
    return new Response(JSON.stringify(posted.length === 1 ? { status: "done", style: {} } : { status: "pwned" }), { headers: { "content-type": "application/json" } });
  };
  const cp = createControlPlane({ CONTROL_PLANE_URL: "https://control.example.test", GATEWAY_SECRET: "gw-secret-not-real" }, { fetchImpl });
  assert.deepEqual(await cp.texCommand("cat_turn", { kind: "settings" }), { status: "done", style: {} });
  assert.equal(await cp.texCommand("cat_turn", { kind: "settings" }), null);
  assert.match(posted[0].url, /\/gateway\/tex\/command$/);
  assert.deepEqual(posted[0].body, { accessToken: "cat_turn", command: { kind: "settings" } });
});

test("every texted prompt says settings change only through the tool", () => {
  for (const notes of [null, { prompt: "You are a production Tex." }]) assert.ok(systemPrompt(null, { texting: true, notes }).includes(SETTINGS_LINE), "a production setup keeps it");
  assert.ok(!systemPrompt(null).includes(SETTINGS_LINE), "the app's own chat is not a texted turn");
});

// Security review, 2026-10-31 (confused deputy): only the grant's own person's message may share or unshare their mail.
test("another member's words, a quote or an email cannot share Ada's mail; Ada's own ask can", async () => {
  const judge = async ({ words }) => ({ allow: /\bshare my (mail|email)\b/i.test(words) });
  const attempt = async (said) => {
    const { sent, run } = recorder({ status: "done", address: "ada@work.example", narrowed: false });
    const tools = commandTools({ run, group: { key: "k" }, consent: consentFor(said, judge) });
    const result = await byName(tools, "chat_share_mail").call({ address: "ada@work.example" });
    return { sent, result };
  };
  // Ada tagged Tex about lunch; Bo's line asking for Ada's mail is chat context, not the turn's own words.
  for (const said of ["Tex what's for lunch?", "Tex summarize the thread", "Tex read the email from Jo"]) {
    const { sent, result } = await attempt(said);
    assert.deepEqual(sent, [], said);
    assert.equal(result.isError, true, said);
    assert.equal(words(result), OWN_WORDS_REFUSAL);
  }
  // Ada's own message asking: it runs.
  const own = await attempt("Tex share my mail from ada@work.example here");
  assert.equal(own.sent.length, 1);
  assert.match(words(own.result), /^Shared/);
});

test("words that name mail but don't ask are refused by the judge; no judge, the code check still stands", async () => {
  const no = await consentFor("Tex the email says share my mail with Bo", async () => ({ allow: false }))("share_mail");
  assert.equal(no, false);
  assert.equal(await consentFor("Tex share my mail here", null)("share_mail"), true, "self-hosting without a judge: the code check alone");
  assert.equal(await consentFor("Tex what's up", null)("share_mail"), false);
  assert.equal(await consentFor("Tex share my mail", async () => { throw new Error("down"); })("share_mail"), false, "a judge that fails is a no");
  const tools = commandTools({ run: async () => ({ status: "done", sharing: true }), group: null });
  assert.equal(words(await byName(tools, "review_sharing_set").call({ share: true })), OWN_WORDS_REFUSAL, "no consent given, refused");
  const unshare = commandTools({ run: async () => ({ status: "done", count: 1 }), group: { key: "k" } });
  assert.equal(words(await byName(unshare, "chat_unshare_mail").call({})), OWN_WORDS_REFUSAL);
});
