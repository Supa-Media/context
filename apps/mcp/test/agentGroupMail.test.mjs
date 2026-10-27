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
  assert.match(JSON.stringify(world.model.requests[first].system), /Nobody's personal notes, mail/);
  assert.doesNotMatch(toolReplies(world.model.requests.at(-1))[0], /Invoice 1042/);
  assert.equal(world.controlPlane.mailReadCalls.length, before, "the control plane was never asked");
});

test("a chat with shared mail is told it watches that mail itself, with nothing to set up", async () => {
  const { chatMailPrompt } = await import("../src/agent/groupMail.js");
  const prompt = chatMailPrompt({ mail: [{ handle: "seyi", address: "seyi@work.example" }] });
  assert.match(prompt, /You watch this mail for the chat on your own/);
  assert.match(prompt, /Nobody has to set that up/);
});

test("a check-in marks its person's mail a group chat also watches, and is told to leave the group's to it", async () => {
  const { newMailSection, newMailSince } = await import("../src/agent/newMail.js");
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
