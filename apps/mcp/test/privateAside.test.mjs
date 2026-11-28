/**
 * SENSITIVE DETAILS GO TO THE ASKER'S OWN CHAT (Dev2, 2026-11-25: "steps for that shouldn't be stated in the groupchat -
 * it should be handled in 1:1"). In a group turn a vault link never reaches the model or the chat: its words go to the
 * tagger as an aside, and the vault watch still keys on the group. `text_privately` asks for anything else sensitive. A
 * guest is told to make an account first. Worker half: `packages/tex/worker/privateAsides.test.ts`.
 *
 * Sabotage (2026-11-25): return the inner result from `withPrivateLinks` and "the model never sees the link" fails; make
 * `canAside` return true and "a guest is told to make an account first" fails; wrap the turn's
 * `withVaultWatch` outside `withPrivateLinks` and "the turn wraps the vault watch inside" fails.
 */

import "./gatewayConnected.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { privateAsideTool, withPrivateLinks, GUEST_ASIDE_REFUSAL, MAX_ASIDES } from "../../../packages/tex/gateway/agent/privateAside.js";
import { withVaultWatch } from "../../../packages/tex/gateway/agent/vaultSaved.js";
import { backTo, crossAskTool, crossChatOf, crossChatPrompt, crossChatQuestion } from "../../../packages/tex/gateway/agent/crossChat.js";
import { groupOf, groupPrompt } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { GROUP_SENSITIVE_LINE } from "../../../packages/tex/gateway/agent/groupSignIns.js";

const TOKEN = "b".repeat(32);
const LINK = `Link to save the login: https://context.lc/vault/${TOKEN}\nIt opens only for this person, signed in, for 30 minutes.`;
const member = { key: "c3".repeat(32), from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] };
const guest = { ...member, from: "", guestTagger: true };
const minted = async () => ({ content: [{ type: "text", text: LINK }] });

const said = (result) => result.content.map((part) => part.text).join("\n");

test("the model never sees the link: it goes to the tagger alone, and the save still wakes the group", async () => {
  const ledger = {};
  const call = withPrivateLinks(member, ledger, withVaultWatch(ledger, minted));
  const result = await call("vault_add_link", { type: "login", site: "instacart.com" });
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(said(result), /vault\//, "no link in what the model reads");
  assert.deepEqual(JSON.parse(said(result)), { link_made: true, texted_privately: "@shyoh", when: "right after your answer", this_group_sees: "nothing of it", once_they_save: "you are told here and carry on" });
  assert.equal(ledger.asides.length, 1);
  assert.match(ledger.asides[0].texts[0], new RegExp(TOKEN), "the link's words go to them exactly");
  assert.match(ledger.asides[0].what, /instacart\.com/);
  assert.equal(ledger.vaultLink, true, "the group still watches for the save");
  assert.equal(ledger.vaultLinks.length, 1);
});

test("a guest is told to make an account first, and no link is made", async () => {
  let made = 0;
  const ledger = {};
  const call = withPrivateLinks(guest, ledger, async () => (made++, minted()));
  const result = await call("vault_add_link", { site: "instacart.com" });
  assert.equal(result.isError, true);
  assert.equal(said(result), GUEST_ASIDE_REFUSAL);
  const facts = JSON.parse(GUEST_ASIDE_REFUSAL);
  assert.equal(facts.sent, false);
  assert.equal(facts.has_account, false, "a guest is told, as a fact, that they have no account");
  assert.match(facts.to_sign_up, /text you directly/, "and the way to sign up: texting Tex on their own");
  assert.equal(made, 0);
  assert.equal(ledger.asides, undefined);
  const tool = privateAsideTool({ group: guest, ledger });
  assert.equal((await tool.call({ what: "the code Instacart sent" })).isError, true);
});

test("text_privately keeps the ask for the tagger, at most twice a turn; other tools pass through", async () => {
  const ledger = {};
  const tool = privateAsideTool({ group: member, ledger });
  assert.equal(tool.tool.name, "text_privately");
  assert.deepEqual(JSON.parse(said(await tool.call({ what: "the code Instacart just sent you, to sign in for the order" }))), { texted_privately: "@shyoh", when: "right after your answer", this_group_sees: "nothing of it", answer_here: "tapback" });
  assert.equal((await tool.call({ what: "" })).isError, true);
  for (let i = 1; i < MAX_ASIDES; i++) await tool.call({ what: `ask ${i}` });
  assert.equal((await tool.call({ what: "one more" })).isError, true);
  assert.equal(ledger.asides.length, MAX_ASIDES);
  assert.equal(privateAsideTool({ group: null, ledger }), null, "a 1:1 has no aside");
  const passed = await withPrivateLinks(member, {}, async (name) => ({ content: [{ type: "text", text: name }] }))("write_note", {});
  assert.equal(said(passed), "write_note");
});

test("the tagger's 1:1 run is handed the follow-up as data: the link's words exactly, and how to pass back to the group", () => {
  const event = crossChatOf({ event: "chat_answer", crossChat: { id: "xabcdefghij01", from: "a group chat they're in", what: "a private link to save instacart.com", state: "aside", texts: [LINK], key: "d".repeat(64) } }, { chatTurn: true, job: null });
  assert.equal(event.state, "aside");
  assert.equal(event.key, "d".repeat(64));
  assert.equal(crossChatQuestion(event), `(${JSON.stringify({ event: "follow_up_from_group", group: "a group chat they're in", chat: "d".repeat(64) })})`);
  const facts = JSON.parse(crossChatPrompt(event).trim()).follow_up_from_group;
  assert.deepEqual(facts, {
    group: "a group chat they're in",
    chat: "d".repeat(64),
    follow_up: "a private link to save instacart.com",
    the_group_sees: "nothing of this chat",
    private_link_words: [LINK],
    send_link_words: "exactly as written",
    back_to_the_group: `send ask_chat, do true, chat "${"d".repeat(64)}"`,
  });
});

// Dev2, 2026-11-27 ("yea you can text me 1:1" went unanswered; "a two way loop indeed"): a group's Tex follows up with
// its tagger for anything of theirs, not only something sensitive, and their own Tex can post back what they share.
// Sabotage: make `backTo` return null and "the follow-up run can answer back" fails; let it return any group and
// "to that one group only" fails.
test("text_privately takes any follow-up for the tagger, and their 1:1 run can answer back to that one group only", async () => {
  const ledger = {};
  const tool = privateAsideTool({ group: member, ledger });
  assert.match(tool.tool.description, /their own notes, a summary/);
  await tool.call({ what: "Send them a short summary of their own thoughts and reflection notes." });
  assert.deepEqual(ledger.asides, [{ what: "Send them a short summary of their own thoughts and reflection notes.", texts: [] }]);
  const key = "d".repeat(64);
  const groups = [{ key, name: "Battle of the Bots" }, { key: "e".repeat(64), name: "Family" }];
  const event = crossChatOf({ event: "chat_answer", crossChat: { id: "xabcdefghij02", from: "a group chat they're in", what: "summary", state: "aside", texts: [], key } }, { chatTurn: true, job: null });
  assert.equal(backTo(event, groups), groups[0]);
  const fired = [];
  const asking = crossAskTool({ event, groups, counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async (input) => (fired.push(input), { to: "ask", ask: { to: input.to } }) });
  assert.ok(asking, "the follow-up run can answer back");
  assert.match(asking.tool.description, /Battle of the Bots/);
  assert.doesNotMatch(asking.tool.description, /Family/, "to that one group only");
  assert.equal((await asking.call({ chat: "Family", what: "share it", do: true })).isError, true);
  await asking.call({ chat: "Battle of the Bots", what: "Post the fall reflection summary they chose to share.", do: true });
  assert.equal(fired[0].to.key, key);
  // Any other run another chat started still asks nobody (one hop).
  const answered = crossChatOf({ event: "chat_answer", crossChat: { id: "xabcdefghij03", from: "a group", what: "x", state: "answered", texts: ["y"], key } }, { chatTurn: true, job: null });
  assert.equal(crossAskTool({ event: answered, groups, counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async () => null }), null);
  const ask = crossChatOf({ event: "chat_ask", crossChat: { id: "xabcdefghij04", from: "a group", what: "x" } }, { chatTurn: true, job: null });
  assert.equal(crossAskTool({ event: ask, groups, counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async () => null }), null);
  // A group's own turn never asks.
  assert.equal(crossAskTool({ event, group: member, groups, counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async () => null }), null);
});

test("every group is told sensitive details are asked for in their own chat, never here", () => {
  const prompt = groupPrompt({ ...groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] } }), home: { folder: "tex/groups/a-b-c" } }, "supa");
  assert.ok(prompt.includes(GROUP_SENSITIVE_LINE));
  assert.doesNotMatch(prompt, /send whoever asked a vault_add link/);
  assert.match(prompt, /never here/);
});

test("the turn wraps the vault watch inside the private links, so the watch sees the link the model doesn't", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../../packages/tex/gateway/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.ok(source.includes("withPrivateLinks(asideGroup, ledger, withVaultWatch(ledger,"));
  const ledger = {};
  await withVaultWatch(ledger, withPrivateLinks(member, ledger, minted))("vault_add_link", { site: "instacart.com" });
  assert.equal(ledger.vaultLinks, undefined, "the other way round, nothing is watched");
});

// Dev2, 2026-11-27, choosing that a check-in's calendar clash goes to the calendar's own person privately: the room
// reads a shared calendar as free or busy only, so whether a busy time is the plan is asked of its owner alone.
// Sabotage: let `calendarAside` take any handle and "only someone whose calendar is shared here" fails.
test("a calendar clash goes to the calendar's own person only, on a check-in with no tagger too", async () => {
  const checkIn = { key: "c3".repeat(32), people: ["shyoh", "seyi"], calendar: [{ handle: "shyoh", address: "s@example.com" }] };
  const ledger = {};
  const tool = privateAsideTool({ group: checkIn, ledger });
  const sent = await tool.call({ what: "The chat plans Saturday 3 PM; your calendar is busy 2 to 6 PM then.", to: "@shyoh" });
  assert.equal(sent.isError, undefined);
  assert.deepEqual(JSON.parse(said(sent)), { texted_privately: "@shyoh", about: "shared_calendar", when: "right after your answer" });
  assert.deepEqual(ledger.asides, [{ what: "The chat plans Saturday 3 PM; your calendar is busy 2 to 6 PM then.", texts: [], to: "shyoh", calendar: true }]);
  // Only someone whose calendar is shared here.
  const other = await tool.call({ what: "x", to: "seyi" });
  assert.equal(other.isError, true);
  assert.deepEqual(JSON.parse(said(other)), { sent: false, status: "no_calendar_of_theirs_shared_here", calendars_shared_by: ["@shyoh"] });
  assert.equal(ledger.asides.length, 1);
  // Without a `to`, a check-in has nobody who tagged it to text.
  assert.equal((await tool.call({ what: "x" })).isError, true);
});

test("their own 1:1 run is told the clash as data, and that the group sees only free or busy", () => {
  const event = crossChatOf(
    { event: "chat_answer", crossChat: { id: "xabcdefghij", from: "a group chat they're in", what: "The chat plans Saturday 3 PM; busy then.", state: "aside", texts: [], calendar: true, key: "d".repeat(64) } },
    { chatTurn: true, job: null },
  );
  assert.equal(event.calendar, true);
  assert.match(crossChatQuestion(event), /"event":"calendar_check_from_group"/);
  const prompt = crossChatPrompt(event);
  const facts = JSON.parse(prompt.trim()).calendar_check_from_group;
  assert.deepEqual(facts, {
    group: "a group chat they're in",
    chat: "d".repeat(64),
    what_the_group_check_in_found: "The chat plans Saturday 3 PM; busy then.",
    the_group_sees_your_calendar_as: "free or busy only",
    your_own_calendar: "readable here in full",
  });
});

test("text_privately naming the tagger in to is their own follow-up, never a calendar clash; a guest naming themselves is still told to sign up", async () => {
  const ledger = {};
  const tool = privateAsideTool({ group: member, ledger });
  const result = await tool.call({ to: `@${member.from}`, what: "Go over their week with them." });
  assert.notEqual(result.isError, true, said(result));
  assert.equal(ledger.asides.length, 1);
  assert.equal(ledger.asides[0].calendar, undefined, "not a calendar aside");
  const asGuest = await privateAsideTool({ group: guest, ledger: {} }).call({ to: "@gus", what: "Go over their week." });
  assert.equal(JSON.parse(said(asGuest)).has_account, false);
});

test("a group chat's send list names text_privately with its args; a 1:1's never does", async () => {
  // Battle of the Bots, 2026-11-28: Haiku thought "the send tool's listed actions don't include it" and handed the 1:1
  // follow-up to a background job, which cannot text anyone 1:1. The catalogue had no text_privately.
  const { fixedCarriers } = await import("../../../packages/tex/gateway/agent/sixToolsFixed.js");
  const { sixToolsOver } = await import("../../../packages/tex/gateway/agent/sixTools.js");
  const sendOf = (kind) => {
    const shown = fixedCarriers(kind);
    return sixToolsOver([...shown.values()], null, { shown }).tools.find((tool) => tool.name === "send").description;
  };
  assert.match(sendOf("group"), /text_privately: .*args: what\*/);
  assert.doesNotMatch(sendOf("one"), /text_privately/);
});
