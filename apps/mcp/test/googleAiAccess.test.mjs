/**
 * When AI may not use a Google account until its owner allows AI access
 * (`ai_access_needed`, `aiAccessNeeded` in the control plane), every Google
 * tool sends the person to Allow AI access (`manage connect_google` with kind
 * ai), never to reconnect: a reconnect gives the person's own client a new
 * grant AI never reads, and the person would go round in a loop.
 *
 * ## Sabotage record
 *
 *   `ai_access_needed` missing from the calendar client's refusals
 *     → "the calendar client keeps the refusal and the accounts" fails
 *   the calendar refusal answered with the reconnect copy
 *     → "a calendar that waits for AI access says so, by name, and never reconnect" fails
 *   the read-alongside line dropped
 *     → "a calendar read beside one that waits names the waiting one" fails
 *   kind ai refused by connect_google
 *     → "connect_google kind ai gives the Connected apps page and the Allow AI access steps" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolReadCalendar } from "../src/tools/calendarRead.js";
import { createCalendarMethods } from "../src/controlPlane/calendar.js";
import { createEmailMethods } from "../src/controlPlane/email.js";
import { toolSearchEmail } from "../src/tools/emailRead.js";
import { toolSendEmail, toolSaveEmailDraft } from "../src/tools/email.js";
import { toolGoogleChat } from "../src/tools/googleChat.js";
import { toolConnectGoogle } from "../src/tools/workspaces.js";

const text = (result) => result.content.map((part) => part.text).join("\n");
const ADDRESS = "synthetic@example.invalid";

function calendarStore(answer) {
  return {
    async list() {
      return { objects: [], truncated: false };
    },
    async get(key) {
      throw new Error(`a note was read: ${key}`);
    },
    calendar: { days: async () => answer },
  };
}

function assertAllowNotReconnect(out) {
  assert.match(out, /connect_google with kind ai/);
  assert.match(out, /Allow AI access/);
  assert.match(out, /Reconnecting won't fix this/);
  assert.doesNotMatch(out, /reconnect it with manage connect_google/);
}

test("a calendar that waits for AI access says so, by name, and never reconnect", async () => {
  const result = await toolReadCalendar(calendarStore({ ok: false, refused: "ai_access_needed", aiAccess: [ADDRESS] }), "private", [], new Map(), { date: "2026-10-29" });
  assert.equal(result.isError, true);
  const out = text(result);
  assert.match(out, new RegExp(`AI access isn't allowed yet for ${ADDRESS}`));
  assertAllowNotReconnect(out);
});

test("a calendar read beside one that waits names the waiting one", async () => {
  const result = await toolReadCalendar(
    calendarStore({ ok: true, days: [], reconnect: [], aiAccess: [ADDRESS] }),
    "private",
    [],
    new Map(),
    { date: "2026-10-29" },
  );
  const out = text(result);
  assert.match(out, new RegExp(`AI access isn't allowed yet for ${ADDRESS}`));
  assertAllowNotReconnect(out);
});

test("the calendar client keeps the refusal and the accounts", async () => {
  const methods = createCalendarMethods({ post: async () => ({ ok: false, refused: "ai_access_needed", aiAccess: [ADDRESS, 7] }) });
  assert.deepEqual(await methods.personCalendarDays("token", "ws", { date: "2026-10-29", days: 1 }), {
    ok: false,
    refused: "ai_access_needed",
    reconnect: [],
    aiAccess: [ADDRESS],
  });
});

test("the mail client keeps the refusal and the mailboxes", async () => {
  const methods = createEmailMethods({ post: async () => ({ ok: false, refused: "ai_access_needed", aiAccess: [ADDRESS] }) });
  const answer = await methods.personMailSearch("token", "ws", { query: "invoice" });
  assert.equal(answer.refused, "ai_access_needed");
  assert.deepEqual(answer.aiAccess, [ADDRESS]);
});

test("a mail search that waits for AI access says so, and never reconnect", async () => {
  const store = {
    async list() {
      return { objects: [], truncated: false };
    },
    async get() {
      return null;
    },
    email: { search: async () => ({ ok: false, refused: "ai_access_needed", mailboxes: [], reconnect: [], aiAccess: [ADDRESS] }) },
  };
  const out = text(await toolSearchEmail(store, "private", [], new Map(), { query: "invoice" }));
  assert.match(out, new RegExp(`AI access isn't allowed yet for ${ADDRESS}`));
  assertAllowNotReconnect(out);
});

test("a send, a draft and a Chat message that wait for AI access say so, and never reconnect", async () => {
  const email = { to: ["friend@example.invalid"], subject: "Hello", body: "Hi" };
  const refused = async () => ({ ok: false, refused: "ai_access_needed" });
  const sent = text(await toolSendEmail({ email: { send: refused } }, email));
  assert.match(sent, /^Not sent: AI access isn't allowed yet/);
  assertAllowNotReconnect(sent);
  const drafted = text(await toolSaveEmailDraft({ email: { draft: refused } }, email));
  assert.match(drafted, /^Not saved: AI access isn't allowed yet/);
  assertAllowNotReconnect(drafted);
  const chat = text(await toolGoogleChat({ googleChat: { send: refused } }, { to: "friend@example.invalid", text: "Hi" }));
  assert.match(chat, /^Not sent: AI access isn't allowed yet/);
  assertAllowNotReconnect(chat);
});

test("connect_google kind ai gives the Connected apps page and the Allow AI access steps", async () => {
  const asked = [];
  const store = {
    workspaceSetup: {
      connectGoogle: async (kind) => {
        asked.push(kind);
        return { ok: true, url: "https://app.context.invalid/console/@person?settings=integrations" };
      },
    },
  };
  const out = text(await toolConnectGoogle(store, { kind: "ai" }));
  assert.deepEqual(asked, ["ai"]);
  assert.match(out, /Link to allow AI access: https:\/\/app\.context\.invalid\/console\/@person\?settings=integrations/);
  assert.match(out, /Allow AI access beside the Google account/);
  assert.match(out, /It is not a reconnect/);
  assert.equal((await toolConnectGoogle(store, { kind: "everything" })).isError, true);
});
