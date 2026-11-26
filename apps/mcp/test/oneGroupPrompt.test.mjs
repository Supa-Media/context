/**
 * ONE GROUP TEX (Dev2, 2026-11-25: "there shouldnt be any capability split between the two"). A chat whose people
 * don't all share a workspace once got its own, smaller prompt and fewer tools (`guestPrompt`, `GUEST_NOTE_TOOLS`), so
 * a capability added to the group prompt never reached it: Battle of the Bots was told it could start a poll nowhere,
 * and Tex said "I can't start a native poll" (2026-11-24 9:53 PM ET). Every group now gets the same prompt and tools;
 * only what it may read differs, and that stays the grant's and the dispatcher's.
 *
 * Sabotage (2026-11-25): put `if (group.homeOnly) return <any smaller prompt>` back at the top of `groupPrompt`, or
 * drop any capability line behind a `homeOnly` check, and "every capability line" fails; take a name out of
 * `HOME_ONLY_REFUSED` and the isolation test naming it fails; let the Cross-chat gate pass `guest: true` and "a guest
 * has no personal Tex to reach through" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { groupOf, groupPrompt, groupWriteTools } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { HOME_ONLY_REFUSED, homeOnlyCallTool } from "../../../packages/tex/gateway/agent/groupGuests.js";
import { GROUP_RUN_LINE } from "../../../packages/tex/gateway/agent/groupRunLine.js";
import { crossChatGateNode } from "../../../packages/tex/gateway/agent/graph/nodes/crossChatGate.js";
import { crossAskTool } from "../../../packages/tex/gateway/agent/crossChat.js";
import { toolDefinitions } from "../src/tools/registry.js";

const HEX = "c3".repeat(32);
const MEMBERS = "d4".repeat(32);
const HOME = "tex/groups/cactus-lotus-badge";
const member = { ...groupOf({ group: { key: HEX, members: MEMBERS, from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] } }), home: { folder: HOME } };
const homeOnly = { ...groupOf({ group: { key: HEX, members: MEMBERS, from: "shyoh", people: ["shyoh"], guests: ["guest-66ef", "guest-6ce3"] } }), homeOnly: true, home: { folder: HOME } };

/** What only a chat that reaches a shared workspace is told: which workspace it reads, and how. Everything else is everyone's. */
const READS_ONLY = [/^You can read only @/, /^Name the one you mean/, /^\(or "@/, /^; with none, a tool reaches/, /^where a person here can only read/, /^You can do anything with notes there/, /^When someone asks for a note's link here/];

function sentences(prompt) {
  return prompt.split(/(?<=[.;:!?)])\s+(?=[A-Z"(@])/).map((part) => part.trim()).filter(Boolean);
}

test("a chat that reads only its home is told every capability line a member chat is", () => {
  const told = groupPrompt(homeOnly, "context-lc");
  const missing = sentences(groupPrompt(member, "supa")).filter((line) => !READS_ONLY.some((only) => only.test(line)) && !told.includes(line));
  assert.deepEqual(missing, [], "every capability a group is told reaches a chat with guests too");
  assert.ok(told.includes(GROUP_RUN_LINE), "polls, effects and running the group");
  assert.match(told, /fetch id "chat:"/, "what it remembers, and how to read all of it");
  assert.match(told, /Some people here aren't on Context/);
  assert.match(told, /You can't publish, share or change who sees anything from here/, "privacy is said, not left out");
  assert.doesNotMatch(groupPrompt(member, "supa"), /Some people here aren't on Context/);
});

test("every group gets the same write tools; a chat that reads only its home just has its refusals", () => {
  const offered = toolDefinitions();
  const names = (group) => groupWriteTools(offered, group).map((tool) => tool.name).sort();
  assert.deepEqual(names(homeOnly), names(member));
  assert.ok(names(homeOnly).includes("archive_note"), "more than write_note and move_note");
});

test("isolation: nothing is published, shared or made visible to more people from a chat that reads only its home", async () => {
  const calls = [];
  const dispatch = homeOnlyCallTool(async (name, args) => (calls.push(name), { content: [{ type: "text", text: "ok" }] }), { store: { readOnlyAt: (path) => path === `${HOME}/shared-plan.md` }, group: homeOnly, guestTagger: true });
  for (const name of HOME_ONLY_REFUSED) {
    const refused = await dispatch(name, { path: `${HOME}/notes.md` });
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /nothing is published, shared or made visible/);
  }
  for (const name of ["set_visibility", "create_link", "invite_member", "vault_share_link", "set_encryption"]) assert.ok(HOME_ONLY_REFUSED.includes(name), name);
  assert.equal((await dispatch("write_note", { path: `${HOME}/a.md`, content: "x", share: true })).isError, true, "no share argument");
  assert.equal((await dispatch("write_note", { path: `${HOME}/a.md`, content: "x", context: "@supa" })).isError, true, "no other context");
  assert.equal((await dispatch("archive_note", { path: `${HOME}/shared-plan.md` })).isError, true, "a note shared to view stays as it is");
  assert.equal((await dispatch("move_notes", { moves: [{ source: `${HOME}/shared-plan.md`, destination: `${HOME}/old/plan.md` }] })).isError, true, "nor moved in a batch");
  assert.deepEqual(calls, [], "none of those reached the store");
});

test("isolation: no group reaches anyone's personal Tex, a guest's tag or a member's (Dev2, 2026-11-26)", async () => {
  const counts = { hour: 0, day: 0, open: [] };
  for (const guest of [true, false]) {
    const asked = await crossChatGateNode({ from: "group", to: { kind: "person", who: "shyoh" }, what: "the list I made with you", do: false, guest, counts });
    assert.equal(asked.to, "refuse");
  }
  for (const group of [homeOnly, { ...homeOnly, homeOnly: false }]) assert.equal(crossAskTool({ group, counts, ledger: {}, gate: crossChatGateNode }), null, "a group turn has no ask_chat");
});
