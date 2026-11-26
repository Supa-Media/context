// A Lab test chat of a group answers the chat object's group question itself (`controlSwitch.js`), and until 2026-11-26
// that answer carried no shared mail: a copy of a chat whose mailbox was shared read "Nobody's mail is shared", so no
// test chat could show what Tex does with it (a reply from a shared mailbox the asker has connected too, PR #4284).
// Sabotage: drop the `mail` line from the "ready" answer → the first test fails; drop `mailFor`'s asker check → the
// second does.
import { test } from "node:test";
import assert from "node:assert/strict";

import { controlPlaneSwitch, mailFor } from "../../../packages/lab/gateway/labSandbox/controlSwitch.js";

const about = { kind: "group", people: [{ handle: "ana", name: "You" }, { handle: "ben", name: "ben" }] };
const phones = new Map([["ana", "+15550000001"], ["ben", "+15550000002"]]);
const chat = { slug: "family", mail: [{ handle: "ben", address: "office@example.com", senders: ["ana", "ben"] }, { handle: "ben", address: "ben@example.com", senders: ["ben"] }], calendar: [{ handle: "ben", address: "ben@example.com" }] };
const gate = { record: () => {} };

test("a group test chat is told the chat's shared mail and calendars, as a real turn is", async () => {
  const ask = controlPlaneSwitch({ about, chat, phones, gate, token: "t" });
  const ready = await ask("/agent-texts/group", { sender: "+15550000001" });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.mail?.map((m) => m.address), ["office@example.com", "ben@example.com"]);
  assert.deepEqual(ready.calendar, chat.calendar);
  assert.ok(ready.mail.every((m) => !("senders" in m)), "who else has it connected stays in the Lab");
});

test("askerSends marks only the mailboxes this text's asker has connected themselves", async () => {
  const ask = controlPlaneSwitch({ about, chat, phones, gate, token: "t" });
  const ana = await ask("/agent-texts/group", { sender: "+15550000001" });
  assert.deepEqual(ana.mail.map((m) => m.askerSends === true), [true, false]);
  const stranger = await ask("/agent-texts/group", { sender: "+15550009999" });
  assert.deepEqual(stranger.mail.map((m) => m.askerSends === true), [false, false]);
  assert.deepEqual(mailFor([{ handle: "ben", address: "a@example.com" }], "ana"), [{ handle: "ben", address: "a@example.com" }]);
});

test("a chat with nothing shared says nothing about mail", async () => {
  const ready = await controlPlaneSwitch({ about, chat: { slug: "family" }, phones, gate, token: "t" })("/agent-texts/group", { sender: "+15550000001" });
  assert.equal("mail" in ready, false);
  assert.equal("calendar" in ready, false);
});
