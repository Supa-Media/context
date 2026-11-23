/**
 * NO PROMPT TEX IS GIVEN NAMES A TOOL IT ISN'T GIVEN (Dev2, 2026-11-06, the context review).
 *
 * The review found the production prompt and lines written by code telling Haiku to call `find_tools`,
 * `read_note`, `send_email`, `calendar_event` and about twenty more names retired when Tex moved to six tools
 * (2026-10-16). These checks run a 1:1 text, a group tag and a background job through `/agent` and read every
 * word the model was sent (system, tools, the person's turn) for a retired name (`promptNames.js`).
 *
 * Sabotage record (local edits, reverted): putting "calendar_event adds" back in `ACTIONS_LINE` (`prompt.js`) fails
 * the 1:1 and group checks; "read all of it with earlier_chat" back in `groupTurn.js` fails the group check;
 * "updated with write_note" back in `personVoice.js` fails the 1:1 check.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { TOKEN_TEXTS, createEgressWorld, request } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { parseSetup } from "../../../packages/tex/gateway/agent/production.js";
import { staleToolNames } from "../../../packages/tex/gateway/agent/promptNames.js";

const TOKEN_CHAT = `cat_prompt_names_chat_${"0".repeat(17)}`;
const KEY = "c3".repeat(32);
const MEMBERS = "d4".repeat(32);
const JOB = { id: "job-names-00001", title: "Find a venue", brief: "Find three venues.", doneWhen: "three venues with prices", attempt: 1, followUps: [] };

let world;

before(async () => {
  world = await createEgressWorld();
  await world.controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  world.controlPlane.setBuiltinVerdict("ws_egress", BUILTIN_ALLOWED);
  world.controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
});
after(() => world.restore());

/** Every word of the first request the last turn sent: system, the tools' descriptions and the messages. */
let from = 0;
const mark = () => { from = world.model.requests.length; };
function sent() {
  const body = world.model.requests[from];
  assert.ok(body, "the turn asked the model");
  return JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages });
}

test("a 1:1 text names no retired tool", async () => {
  mark();
  world.model.install([{ text: "Done." }]);
  const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "what's on tomorrow", conversation: "texts" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(staleToolNames(sent()), []);
});

test("a group tag names no retired tool", async () => {
  mark();
  world.model.install([{ text: "On it." }]);
  const asked = await request(world.env, TOKEN_CHAT, "/agent", { question: "Tex what's the plan", group: { key: KEY, members: MEMBERS, from: "seyi", people: ["seyi"] }, timeZone: "UTC" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(staleToolNames(sent()), []);
});

test("a background job's turn names no retired tool", async () => {
  mark();
  world.model.install([{ text: "Found three." }]);
  const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "find a venue", conversation: "texts", job: JOB });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(staleToolNames(sent()), []);
});

test("the production setup carries the retired names its body names, so the gateway logs them", async () => {
  const setup = await parseSetup("---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nLoad send_email with find_tools; keep tex/about-me.md current.\n");
  assert.deepEqual(setup.staleNames, ["send_email", "find_tools", "about-me.md"]);
  const clean = await parseSetup("---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nDraft it, then send action email.\n");
  assert.deepEqual(clean.staleNames, []);
});

/*
  THE LINES ONLY A CONNECTED MAILBOX, A SHARED CALENDAR OR A LONG CHAT ADDS (Dev2, 2026-11-23: "remove all the mentions of
  the old tools"). The three turns above have no Gmail, no shared calendar and a short history, so the mail module
  ("search_email with no account searches every one"), the group's mail and calendar lines, a check-in's mail and
  calendar sections, the long-history line and the email manual's words never reached them. Each is rendered here.
  Sabotage record (local edits, reverted): "search_email with no account" back in `mailAccounts.js` fails this test.
*/
test("the lines a mailbox, a shared calendar, a check-in or a long chat adds name no retired tool", async () => {
  const { mailAccountsPrompt } = await import("../../../packages/tex/gateway/agent/mailAccounts.js");
  const { chatMailPrompt } = await import("../../../packages/tex/gateway/agent/groupMail.js");
  const { chatCalendarPrompt } = await import("../../../packages/tex/gateway/agent/groupCalendar.js");
  const { newMailSection } = await import("../../../packages/tex/gateway/agent/newMail.js");
  const { calendarSection } = await import("../../../packages/tex/gateway/agent/checkInSources.js");
  const { HANDBACK_NOTICE } = await import("../../../packages/tex/gateway/agent/claimCheck.js");
  const { threadsPrompt } = await import("../../../packages/tex/gateway/agent/conversationThreads.js");
  const { sixToolsOver } = await import("../../../packages/tex/gateway/agent/sixTools.js");
  const { fixedCarriers } = await import("../../../packages/tex/gateway/agent/sixToolsFixed.js");
  const { readEmail } = await import("../src/tools/email.js");
  const said = {
    mailboxes: mailAccountsPrompt([{ address: "me@example.com", state: "ok" }]),
    groupMail: chatMailPrompt({ mail: [{ handle: "ada", address: "ada@example.com" }] }),
    groupCalendar: chatCalendarPrompt({ calendar: [{ handle: "ada", address: "ada@example.com" }] }),
    noCalendar: chatCalendarPrompt({}),
    newMail: newMailSection([{ line: "- email:me@example.com/abc · from Jo · Hello" }]),
    calendar: calendarSection({ text: "9:00 Standup" }, Date.parse("2026-11-23T12:00:00Z"), "UTC"),
    handback: HANDBACK_NOTICE,
    threads: threadsPrompt({ threads: [{ id: "t1", title: "Lisbon", status: "open", last: 0 }], when: () => "today" }),
    replyId: readEmail({ to: ["jo@example.com"], subject: "Re: hi", body: "Yes", in_reply_to: "abc123" }).error,
  };
  const shown = fixedCarriers("one");
  const six = sixToolsOver([...shown.values()], null, { shown });
  for (const action of ["email", "email_draft", "calendar", "browse", "save"]) said[`manual ${action}`] = six.manualOnFailure(action === "save" ? "write" : "send", { action }) ?? "";
  for (const [where, words] of Object.entries(said)) assert.deepEqual(staleToolNames(String(words ?? "")), [], `${where}: ${words}`);
  assert.match(said["manual email"], /The manual for email/, "the manuals were rendered");
});
