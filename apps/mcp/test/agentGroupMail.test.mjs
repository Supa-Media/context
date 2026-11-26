/**
 * Mail shared with a group chat (the owner, 2026-10-27;
 * `src/agent/groupMail.js`, `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * The control plane decides every read (`apps/convex/__tests__/textGroupMail.test.ts`);
 * this file proves the gateway offers the chat's turn `search_email` and
 * `read_email` only when the Worker names a shared mailbox, tells it whose,
 * and asks the control plane on the chat's own grant.
 *
 * Sabotage record (2026-10-27), each fails a test here:
 *  - `chatMailTools` offering the reads to every chat: "a chat with nothing
 *    shared is offered no mail";
 *  - `groupOf` dropping `mail`: "a chat with shared mail is told whose, and
 *    searches it on its own grant".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { askerMailOf, chatMailPrompt, mailOnShare } from "../../../packages/tex/gateway/agent/groupMail.js";

const TOKEN_CHAT = `cat_group_mail_chat_${"0".repeat(16)}`;
const KEY = "b".repeat(64);
const MEMBERS = "c".repeat(64);
const SHARED = [{ handle: "seyi", address: "seyi@work.example" }];
const LIVE = {
  address: "seyi@work.example",
  id: "18c0ffee",
  threadId: "18c0ffee",
  date: "2026-10-27T10:00:00.000Z",
  from: "Acme <ap@acme.example>",
  to: "team@work.example",
  subject: "Invoice 1042 overdue",
  snippet: "Please pay invoice 1042",
};

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  await controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  controlPlane.holdRules("ws_egress_team", { etag: "rules-mail-1", accessVersion: 1, folders: [], notes: [] });
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.mailResults = [LIVE];
});
after(() => world.restore());

const tagged = (question, mail) =>
  request(world.env, TOKEN_CHAT, "/agent", { question, group: { key: KEY, members: MEMBERS, from: "seyi", people: ["seyi"], ...(mail ? { mail } : {}) }, timeZone: "UTC" });

test("a chat with shared mail is told whose, and searches it on its own grant", async () => {
  world.model.install([{ toolCalls: [{ name: "search", args: { query: "invoice", args: { email: true, account: "seyi@work.example" } } }] }, { text: "Acme's invoice 1042 is overdue." }]);
  const asked = await tagged("Tex anything urgent in the work mail?", SHARED);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const first = world.model.requests.length - 2;
  assert.match(JSON.stringify(world.model.requests[first].system), /@seyi's seyi@work\.example/);
  assert.match(toolReplies(world.model.requests.at(-1))[0], /Invoice 1042 overdue/);
  const call = world.controlPlane.mailReadCalls.at(-1);
  assert.equal(call.path, "/gateway/email/search");
  assert.equal(call.body.expectedWorkspaceId, "ws_egress_team");
});

test("a chat with nothing shared is offered no mail", async () => {
  const before = world.controlPlane.mailReadCalls.length;
  world.model.install([{ toolCalls: [{ name: "search", args: { query: "invoice", args: { email: true } } }] }, { text: "I can't read mail here." }]);
  await tagged("Tex anything in the mail?");
  const first = world.model.requests.length - 2;
  assert.match(JSON.stringify(world.model.requests[first].system), /Nobody's mail is shared with this chat yet/); // since 2026-11-08 it says how to share it, never "never offer" (`capabilities.md`)
  assert.doesNotMatch(toolReplies(world.model.requests.at(-1))[0], /Invoice 1042/);
  assert.equal(world.controlPlane.mailReadCalls.length, before, "the control plane was never asked");
});

test("a chat with shared mail is told it watches that mail itself, with nothing to set up", async () => {
  const { chatMailPrompt } = await import("../../../packages/tex/gateway/agent/groupMail.js");
  const prompt = chatMailPrompt({ mail: [{ handle: "seyi", address: "seyi@work.example" }] });
  assert.match(prompt, /You watch this mail for the chat on your own/);
  assert.match(prompt, /Nobody has to set that up/);
});

// 2026-11-25, Crystal Care: the asker had the shared mailbox connected too, and Tex, told only that it was @seyi's,
// offered the reply for Seyi's yes. Sabotage: drop `askerSends` from `chatMailOf` or the mark in `chatMailPrompt`.
test("a chat is told which shared mailbox its asker has connected, and only that one", async () => {
  const { chatMailOf, chatMailPrompt } = await import("../../../packages/tex/gateway/agent/groupMail.js");
  const mail = chatMailOf([
    { handle: "seyi", address: "seyi@work.example", askerSends: true },
    { handle: "seyi", address: "seyi@home.example" },
    { handle: "bo", address: "bo@work.example", askerSends: "yes" },
  ]);
  assert.deepEqual(mail, [
    { handle: "seyi", address: "seyi@work.example", askerSends: true },
    { handle: "seyi", address: "seyi@home.example" },
    { handle: "bo", address: "bo@work.example" },
  ]);
  const prompt = chatMailPrompt({ from: "tunji", mail });
  assert.match(prompt, /@seyi's seyi@work\.example \(connected to @tunji too\)/);
  assert.match(prompt, /@seyi's seyi@home\.example(?! \()/);
  assert.match(prompt, /@bo's bo@work\.example(?! \()/);
  // The sharer asking about their own mailbox is told nothing new.
  assert.doesNotMatch(chatMailPrompt({ from: "seyi", mail }), /connected to @seyi/);
});

test("a check-in marks its person's mail a group chat also watches, and is told to leave the group's to it", async () => {
  const { newMailSection, newMailSince } = await import("../../../packages/tex/gateway/agent/newMail.js");
  const store = {
    email: {
      search: async () => ({
        ok: true,
        results: [
          { address: "seyi@work.example", id: "m1", date: "Oct 27", from: "Client <c@example.invalid>", subject: "Invoice", snippet: "" },
          { address: "seyi@home.example", id: "m2", date: "Oct 27", from: "Mom <m@example.invalid>", subject: "Dinner", snippet: "" },
        ],
        mailboxes: [
          { address: "seyi@work.example", folder: "x", watchedIn: ["crystal-care", "Not A Slug"] },
          { address: "seyi@home.example", folder: "y" },
        ],
      }),
    },
  };
  const mail = await newMailSince(store, 0);
  assert.match(mail[0].line, /also watched in the @crystal-care group chat/);
  assert.doesNotMatch(mail[0].line, /Not A Slug/);
  assert.doesNotMatch(mail[1].line, /also watched/);
  assert.match(newMailSection(mail), /only when it needs them personally rather than the group/);
  assert.doesNotMatch(newMailSection([mail[1]]), /rather than the group/);
});

// Dev2, 2026-11-26 (the Puttery ask): Tex shared the asker's Gmail and then had no tool to search it that turn, so it
// sent them to a one-to-one chat. A share made in a turn grants its reads to that same turn.
test("mail shared partway through a turn is searched in that same turn", async () => {
  const below = globalThis.fetch;
  const commands = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).pathname === "/gateway/tex/command") {
      const { command } = JSON.parse(init.body);
      commands.push(command);
      return Response.json({ status: "done", address: command.address });
    }
    return below(input, init);
  };
  try {
    const before = world.controlPlane.mailReadCalls.length;
    world.model.install([
      { toolCalls: [{ name: "send", args: { action: "chat_share_mail", args: { address: "seyi@work.example" } } }] },
      { toolCalls: [{ name: "verdict", args: { allow: true, reason: "they asked to share their mail here" } }] }, // the own-words judge (`privacy/judge.js`)
      { toolCalls: [{ name: "search", args: { query: "invoice", args: { email: true, account: "seyi@work.example" } } }] },
      { text: "Acme's invoice 1042 is overdue." },
    ]);
    const asked = await tagged("Tex share my mail here and check it for the invoice");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(commands.at(-1)?.kind, "share_mail", "the share ran");
    const replies = toolReplies(world.model.requests.at(-1));
    assert.match(replies.at(-1), /Invoice 1042 overdue/, replies.join(" | "));
    assert.equal(world.controlPlane.mailReadCalls.length, before + 1, "the control plane was asked, on the chat's grant");
  } finally {
    globalThis.fetch = below;
  }
});

test("the asker's own connected Gmails are told as facts, and a share made mid-turn moves one into the chat's mail", () => {
  const group = { from: "lena", askerMail: askerMailOf(["Lena@Example.invalid", "seyi@work.example", "bad"], SHARED) };
  assert.deepEqual(group.askerMail, ["lena@example.invalid"], "never one already shared, never a malformed one");
  assert.match(chatMailPrompt(group), /"askers_own_gmail_not_shared_here":\{"asker":"@lena","addresses":\["lena@example\.invalid"\]\}/);
  assert.doesNotMatch(chatMailPrompt({ from: "lena" }), /askers_own_gmail/);
  const later = mailOnShare(group, []);
  assert.equal(later.shared("lena@example.invalid"), true);
  assert.deepEqual(group.mail, [{ handle: "lena", address: "lena@example.invalid", askerSends: true }]);
  assert.deepEqual(group.askerMail, []);
  assert.deepEqual(later.take().map((tool) => tool.name).sort(), ["read_email", "search_email"]);
  assert.deepEqual(later.take(), [], "taken once");
  assert.equal(mailOnShare({ from: "" }, []).shared("a@b.example"), false, "no asker handle, nothing named");
});

test("the Worker's askerMail reaches the turn's prompt (`groupTurn.js` `groupOf`)", async () => {
  world.model.install([{ text: "Want me to share seyi@home.example here?" }]);
  const asked = await request(world.env, TOKEN_CHAT, "/agent", { question: "Tex email them from my gmail", group: { key: KEY, members: MEMBERS, from: "seyi", people: ["seyi"], askerMail: ["seyi@home.example"] }, timeZone: "UTC" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.match(JSON.stringify(world.model.requests.at(-1).system), /askers_own_gmail_not_shared_here/);
});
