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

import assert from "node:assert/strict";
import { test } from "node:test";

import { privateAsideTool, withPrivateLinks, GUEST_ASIDE_REFUSAL, MAX_ASIDES } from "../../../packages/tex/gateway/agent/privateAside.js";
import { withVaultWatch } from "../../../packages/tex/gateway/agent/vaultSaved.js";
import { crossChatOf, crossChatPrompt, crossChatQuestion } from "../../../packages/tex/gateway/agent/crossChat.js";
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
  assert.match(said(result), /@shyoh/);
  assert.match(said(result), /I'll text you/);
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
  assert.match(GUEST_ASIDE_REFUSAL, /set up an account first/);
  assert.equal(made, 0);
  assert.equal(ledger.asides, undefined);
  const tool = privateAsideTool({ group: guest, ledger });
  assert.equal((await tool.call({ what: "the code Instacart sent" })).isError, true);
});

test("text_privately keeps the ask for the tagger, at most twice a turn; other tools pass through", async () => {
  const ledger = {};
  const tool = privateAsideTool({ group: member, ledger });
  assert.equal(tool.tool.name, "text_privately");
  assert.match(said(await tool.call({ what: "the code Instacart just sent you, to sign in for the order" })), /say only/);
  assert.equal((await tool.call({ what: "" })).isError, true);
  for (let i = 1; i < MAX_ASIDES; i++) await tool.call({ what: `ask ${i}` });
  assert.equal((await tool.call({ what: "one more" })).isError, true);
  assert.equal(ledger.asides.length, MAX_ASIDES);
  assert.equal(privateAsideTool({ group: null, ledger }), null, "a 1:1 has no aside");
  const passed = await withPrivateLinks(member, {}, async (name) => ({ content: [{ type: "text", text: name }] }))("write_note", {});
  assert.equal(said(passed), "write_note");
});

test("the tagger's 1:1 run is told to text them, with the link exactly, and to pass a code back to the group", () => {
  const event = crossChatOf({ event: "chat_answer", crossChat: { id: "xabcdefghij01", from: "a group chat they're in", what: "a private link to save instacart.com", state: "aside", texts: [LINK], key: "d".repeat(64) } }, { chatTurn: true, job: null });
  assert.equal(event.state, "aside");
  assert.equal(event.key, "d".repeat(64));
  assert.match(crossChatQuestion(event), /not in front of the group/);
  const prompt = crossChatPrompt(event);
  assert.match(prompt, new RegExp(TOKEN));
  assert.match(prompt, /ask_chat, do true, chat "d{64}"/);
  assert.match(prompt, /never ask them to send it there/);
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
