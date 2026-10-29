/**
 * Tex in a group chat with people who aren't on Context (guest mode, the
 * owner, 2026-10-25; `src/agent/groupGuests.js`,
 * `docs/decisions/texting-assistant/group-guests.md`).
 *
 * The control plane mints a guest chat's grant with the guest marker, the
 * chat marker, its group's name and the tokens of the rows shared with that
 * group, and renders its rules for the chat alone: a row the group holds is
 * `team`, every other row `private`, and the rows held only to view named in
 * `readOnly` (`apps/convex/functions/lib/nodes/chatFolders.ts`). This file
 * holds those rules as the binding carries them and proves what the gateway
 * does with them.
 *
 * Sabotage record (2026-10-25), each fails a test here:
 *  - `grantedGroupsOf` keeping the guest marker for a chat: "the guest
 *    marker and row tokens drop only for a chat" (the routes that judge by
 *    names, history and live editing, would find the chat's own folder shut);
 *  - `readOnlyAt` answering false: "a note shared to view is read, never
 *    changed";
 *  - dropping the `as` check in `guestAwareCallTool`: "a guest's email goes
 *    only from a member, on that member's yes";
 *  - letting `route.js` settle on a guest's turn: "a guest's yes or 👍
 *    releases nothing held for the person who turned guest mode on";
 *  - `groupOf` trusting the Worker's `guest` instead of the session's names:
 *    "a guest chat is known by its grant".
 *
 * Sabotage record (2026-10-29): `chatMailTools` or `chatMailPrompt` leaving a
 * guest chat out again: "a guest chat reads the mail its owner shared with it".
 *
 * Sabotage record (2026-10-28): `withPagePictures` putting in a picture
 * without `storableImage`'s check fails "a guest chat saves its research as
 * a page, pictures found for it included" (the AVIF shot refused the whole
 * page, 2026-10-27 23:56); `pageNotice.js`'s NOT_A_PAGE keeping all of tex/
 * plain fails "research a guest chat saves as a plain note goes back".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PENDING_PREFIX } from "../src/tools/approvals.js";
import { grantedGroupsOf } from "../src/session.js";
import { readOnlyAt } from "../src/store/readOnlyRows.js";
import { actorAccessOf } from "../src/vault/access.js";
import { guestInfoOf } from "../src/agent/groupGuests.js";
import { recipientMaySee } from "../src/live/relayAuthorization.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { PAGE_SKILL_STAMP } from "../src/pageSkill.js";

const TOKEN_CHAT = `cat_group_guests_chat_${"0".repeat(18)}`;
const KEY = "c".repeat(64);
const MEMBERS = "d".repeat(64);
const WORDS = "chair-blast-tiger";
const FOLDER = `tex/chats/${WORDS}`;
const GROUP = `egress-team-${WORDS}`;
const GUEST = { group: GROUP, words: WORDS, folder: FOLDER };
const EMAIL = { to: ["jo@example.com"], subject: "Flights", body: "Hi Jo,\n\nWe land at 6.\n\nAda" };
const verdict = (value) => ({ text: JSON.stringify({ verdict: value, reason: "" }) });

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane, team } = world;
  // The chat's grant is Ada's (she turned guest mode on), an editor's hand, read as the chat.
  await controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
    grantedNames: ["#reads-as-guest", "#reads-as-chat", GROUP, "#k7m2p9q4x1v8"],
  });
  controlPlane.holdRules("ws_egress_team", {
    etag: "rules-chat-1",
    accessVersion: 1,
    folders: [
      { prefix: FOLDER, visibility: "team" },
      { prefix: "trip", visibility: "team" },
      { prefix: "notes", visibility: "private" },
    ],
    // A note a member saved in the chat's folder, which the chat's rules read as private (`chatRules`).
    notes: [{ path: "trip/packing.md", visibility: "team" }, { path: `${FOLDER}/research.page.md`, visibility: "private" }],
    readOnly: { folders: ["trip"], notes: [] },
  });
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.emailSender = "ada@gmail.example";
  team.set(`${FOLDER}/plan.md`, { body: "# Plan\n\nLisbon in May.\n", etag: "c1" });
  team.set("trip/flights.md", { body: "# Flights\n\nTAP 204.\n", etag: "c2" });
  team.set("trip/packing.md", { body: "# Packing\n\nSunscreen.\n", etag: "c3" });
  team.set("notes/budget.md", { body: "# Budget\n\nBUDGET-MARKER\n", etag: "c4" });
  team.set(`${FOLDER}/research.page.md`, { body: "# Research\n\nMEMBER-PAGE\n", etag: "c5" });
});
after(() => world.restore());

const chat = (from, extra = {}) => ({ key: KEY, members: MEMBERS, from, people: ["ada"], guest: GUEST, ...extra });
const tagged = (from, question, extra = {}, group = {}) =>
  request(world.env, TOKEN_CHAT, "/agent", { question, group: chat(from, group), timeZone: "UTC", ...extra });
const sends = () => world.controlPlane.emailCalls.filter((entry) => !entry.check);
const live = () => [...world.team.keys()].filter((key) => key.startsWith(PENDING_PREFIX) && !String(world.team.get(key)?.body ?? "").startsWith("context.logical-delete"));
const bodyAt = (path) => {
  const value = world.team.get(path)?.body;
  return typeof value === "string" ? value : value === undefined ? undefined : new TextDecoder().decode(value);
};

test("a guest chat reads only what is shared with the chat, and is told so", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "read_note", args: { path: `${FOLDER}/plan.md` } },
        { name: "read_note", args: { path: "trip/flights.md" } },
        { name: "read_note", args: { path: "notes/budget.md" } },
      ],
    },
    { text: "Lisbon in May, on TAP 204." },
  ]);
  const asked = await tagged("", "Tex what's the plan?");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const [plan, flights, budget] = toolReplies(world.model.requests.at(-1));
  assert.match(plan, /Lisbon in May/);
  assert.match(flights, /TAP 204/);
  assert.doesNotMatch(budget, /BUDGET-MARKER/, "a note not shared with the chat doesn't exist for it");
  const system = JSON.stringify(world.model.requests[0].system);
  assert.match(system, /GROUP CHAT WITH GUESTS/);
  assert.match(system, /A guest in this chat tagged you/);
  assert.ok(system.includes(`${FOLDER}/`), "told where to write");
  // A guest opens a note link with a texted code (`docs/decisions/texting-assistant/guest-phone-pass.md`), so Tex sends it.
  assert.match(system, /guests included: a guest types the number they text this chat from and a texted code/);
});

test("a note shared to view is read, never changed; the chat's folder is written; nothing is published or moved out", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "write_note", args: { path: "trip/flights.md", content: "# Flights\n\nCancelled.\n" } },
        { name: "write_note", args: { path: "trip/new.md", content: "# New\n" } },
        { name: "write_note", args: { path: "trip/packing.md", content: "# Packing\n\nSunscreen, hats.\n" } },
        { name: "write_note", args: { path: `${FOLDER}/hotels.md`, content: "# Hotels\n\nAlfama.\n" } },
        { name: "write_note", args: { path: `${FOLDER}/shared.md`, content: "# Shared\n", share: true } },
        { name: "move_note", args: { source: `${FOLDER}/plan.md`, destination: "notes/plan.md" } },
      ],
    },
    { text: "Saved the hotels." },
    // The plain hotels note goes back to be a page (`pageNotice.js`); this answer is the one after it.
    { text: "Saved the hotels." },
  ]);
  const asked = await tagged("", "Tex save the hotels and cancel the flights");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const [flights, created, packing, hotels, shared, moved] = toolReplies(world.model.requests.at(-1));
  assert.match(flights, /view only/);
  assert.match(created, /view only/, "nothing new in a folder shared to view");
  assert.doesNotMatch(packing, /view only/, "a note in it shared to edit is the chat's to change");
  assert.doesNotMatch(hotels, /isn't available|view only|Not /);
  assert.match(shared, /can't pass share/);
  assert.match(moved, /outside what this chat can read/);
  assert.match(bodyAt("trip/flights.md"), /TAP 204/);
  assert.equal(bodyAt("trip/new.md"), undefined);
  assert.match(bodyAt(`${FOLDER}/plan.md`), /Lisbon/);
  assert.equal(bodyAt("notes/plan.md"), undefined);
});

test("a guest chat saves its research as a page, pictures found for it included", async () => {
  // On 2026-10-27 at 23:56 a WhatsApp guest chat asked for its research as a page and Tex
  // answered "the save failed four times": a picture found for one venue was an AVIF.
  const avif = btoa("\0\0\0\x1cftypavif\0\0\0\0avifmif1");
  const jpeg = btoa("\xff\xd8\xff\xe0\0\x10JFIF");
  const shots = {
    fetch: async (_, init) => {
      const { url } = JSON.parse(init.body);
      return Response.json({ shots: [{ jpeg: url.includes("thestand") ? avif : jpeg }] });
    },
  };
  const page = [
    "---",
    "kind: research",
    `skill: ${PAGE_SKILL_STAMP}`,
    "---",
    "# Venues for 300",
    "",
    "```places Two rooms",
    "- The Stand: 116 E 16th St | 300 to 500, near Union Square",
    "- 3 West Club: 3 W 51st St | from $2,850",
    "```",
    "",
  ].join("\n");
  world.model.install([
    { toolCalls: [{ name: "write_note", args: { path: `${FOLDER}/venues.page.md`, content: page } }] },
    { text: "Saved the page." },
  ]);
  const question = [
    "Tex put all this research into a page",
    "1. The Stand - private events - https://thestand.example/events",
    "2. 3 West Club - events - https://3westclub.example/",
  ].join("\n");
  const asked = await request({ ...world.env, SITE_SHOTS: shots }, TOKEN_CHAT, "/agent", { question, group: chat(""), timeZone: "UTC" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const [written] = toolReplies(world.model.requests.at(-1));
  assert.match(written, /written: tex\/chats\/chair-blast-tiger\/venues\.page\.md/);
  assert.match(written, /Pictures found and added to the page for: 3 West Club/);
  const saved = bodyAt(`${FOLDER}/venues.page.md`);
  assert.match(saved, /# Venues for 300/);
  assert.equal((saved.match(/photo:/g) ?? []).length, 1, "only the picture a note can hold went in");
});

test("research a guest chat saves as a plain note goes back to be a page, and the chat is told pages save here", async () => {
  // 2026-10-28 00:25: asked to save the page again, Tex saved the research plain and told the chat
  // "the page format keeps failing from this chat"; the folder being under tex/, nothing sent it back.
  world.model.install([
    { toolCalls: [{ name: "write_note", args: { path: `${FOLDER}/research.md`, content: "# Research\n\nThe Stand.\n" } }] },
    { text: "Saved it." },
    { text: "Saved the page." },
  ]);
  const asked = await tagged("", "Tex try to save the page again");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const system = JSON.stringify(world.model.requests[0].system);
  assert.match(system, /as a page \(<name>\.page\.md\) like any new note: pages save here like anywhere else/);
  assert.match(JSON.stringify(world.model.requests.at(-1)), new RegExp(`Write it again now as ${FOLDER}/research\\.page\\.md`));
});

test("a page named like a note the chat can't see is saved under another name, never called unwritable", async () => {
  // 2026-10-28 01:25: Tex picked the name of a page a member had saved in the chat's folder, read
  // "permission denied", and told the chat it couldn't write pages to that folder.
  const page = ["---", "kind: research", `skill: ${PAGE_SKILL_STAMP}`, "---", "# Research", "", "The Stand first.", ""].join("\n");
  world.model.install([
    { toolCalls: [{ name: "write_note", args: { path: `${FOLDER}/research.page.md`, content: page } }] },
    { toolCalls: [{ name: "write_note", args: { path: `${FOLDER}/research-2.page.md`, content: page } }] },
    { text: "Saved the page." },
  ]);
  const asked = await tagged("", "Tex try again putting this research into a page");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const [refused, written] = toolReplies(world.model.requests.at(-1));
  assert.match(refused, /That name can't be written from this chat\. Save it under a different name in tex\/chats\/chair-blast-tiger\//);
  assert.doesNotMatch(refused, /permission denied|MEMBER-PAGE|exists/, "nothing said about what is there");
  assert.match(written, /written: tex\/chats\/chair-blast-tiger\/research-2\.page\.md/);
  assert.match(bodyAt(`${FOLDER}/research.page.md`), /MEMBER-PAGE/, "the member's page is untouched");
});

test("a guest's email goes only from a member, on that member's yes", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, { text: "Couldn't." }]);
  await tagged("", "Tex email Jo our landing time");
  assert.match(toolReplies(world.model.requests.at(-1))[0], /as naming one of @ada/);
  assert.equal(sends().length, 0);
  assert.equal(live().length, 0, "nothing is held for Ada from a guest's turn");

  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, as: "ada" } } }] }, { text: "Drafted it for Ada." }]);
  const offered = await tagged("", "Tex email Jo our landing time, from Ada");
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  assert.equal(offered.body.askFor, "ada", "Ada's yes alone sends it");
  assert.match(offered.body.answer, /@ada, give it a 👍/);
  assert.equal(sends().length, 0);
  assert.equal(live().length, 0);
});

test("a guest's yes or 👍 releases nothing held for the person who turned guest mode on", async () => {
  // Ada, a member, tags Tex herself: the email is held for her own yes.
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, verdict("yes"), { text: "Drafted." }]);
  const ada = await tagged("ada", "Tex email Jo our landing time");
  assert.equal(ada.status, 200, JSON.stringify(ada.body));
  assert.equal(live().length, 1, "held for Ada");
  const ask = ada.body.answer;

  world.model.install([{ text: "Only Ada can OK that." }, { text: "Only Ada can OK that." }]);
  await tagged("", "yes");
  await tagged("", "👍", { quoted: ask, tapback: "Liked" });
  assert.equal(sends().length, 0, "a guest's yes is nobody's");
  assert.equal(live().length, 1, "and the hold is still Ada's to answer");
});

test("a guest chat is known by its grant, whatever the Worker sends", async () => {
  world.model.install([{ text: "Hi." }]);
  await tagged("", "Tex hi", {}, { guest: undefined });
  assert.match(JSON.stringify(world.model.requests.at(-1).system), /GROUP CHAT WITH GUESTS/);
  assert.equal(guestInfoOf({ group: GROUP, words: "../../notes", folder: "notes" }), null);
  assert.deepEqual(guestInfoOf({ group: GROUP, words: WORDS, folder: "notes" }), GUEST, "the folder is rebuilt from the words");
});

test("a guest chat's names: the guest marker and row tokens drop only for a chat", () => {
  const chatNames = grantedGroupsOf(["#reads-as-guest", "#reads-as-chat", GROUP, "#k7m2p9q4x1v8", "#k7m2p9q4x1v8!edit"]);
  assert.deepEqual([...chatNames].sort(), [`@${GROUP}`, "@#reads-as-chat"].sort());
  const pinned = grantedGroupsOf(["#reads-as-guest", "#k7m2p9q4x1v8"]);
  assert.deepEqual([...pinned].sort(), ["@#k7m2p9q4x1v8", "@#reads-as-guest"], "a pinned reader keeps every name");
});

test("the nearest setting decides what is view-only, without case", () => {
  const held = {
    folders: [{ prefix: "trip", visibility: "team" }, { prefix: "trip/mine", visibility: "team" }],
    notes: [{ path: "trip/packing.md", visibility: "team" }, { path: "trip/mine/locked.md", visibility: "team" }],
    readOnly: { folders: ["trip"], notes: ["trip/mine/locked.md"] },
  };
  assert.equal(readOnlyAt(held, "trip/flights.md"), true);
  assert.equal(readOnlyAt(held, "Trip/Flights.md"), true);
  assert.equal(readOnlyAt(held, "trip/packing.md"), false);
  assert.equal(readOnlyAt(held, "trip/mine/new.md"), false);
  assert.equal(readOnlyAt(held, "trip/mine/locked.md"), true);
  assert.equal(readOnlyAt({ folders: held.folders, notes: held.notes }, "trip/flights.md"), false, "nobody else has view-only rows");
});

test("a guest chat uses a vault key only when it is given to the chat's group", () => {
  const actor = { clientId: "context_texts_group", userId: "user_egress", groups: [`@${GROUP}`, "@#reads-as-chat"] };
  assert.equal(actorAccessOf({ createdBy: "user_bo", shares: [{ to: "*", level: "see" }] }, actor), null, "the whole workspace isn't the chat");
  assert.equal(actorAccessOf({ createdBy: "user_egress", shares: [] }, actor), null, "nor the binder's own");
  assert.equal(actorAccessOf({ createdBy: "user_bo", shares: [{ to: `@${GROUP}`, level: "see" }] }, actor), "use", "used, never seen");
  const ordinary = { clientId: "context_texts_group", userId: "user_egress", groups: [] };
  assert.equal(actorAccessOf({ createdBy: "user_bo", shares: [{ to: "*", level: "use" }] }, ordinary), "use", "an ordinary chat as before");
});

test("a guest chat's live keystrokes reach only readers who see everything", () => {
  const privacy = { rules: [{ prefix: FOLDER, vis: "team" }], overrides: new PrivacyOverrides() };
  const chatSender = { grantedGroups: grantedGroupsOf(["#reads-as-guest", "#reads-as-chat", GROUP]) };
  const member = { scopes: ["context:read"], scope: "team", grantedGroups: new Set() };
  const owner = { scopes: ["context:read", "context:private"], scope: "private", grantedGroups: new Set() };
  const path = `${FOLDER}/plan.md`;
  assert.equal(recipientMaySee(chatSender, member, path, privacy), false, "the chat's rules say team, but they are the chat's alone");
  assert.equal(recipientMaySee(chatSender, owner, path, privacy), true);
  assert.equal(recipientMaySee({ grantedGroups: new Set() }, member, path, privacy), true, "anyone else's update as before");
});

test("a guest chat reads the mail its owner shared with it, only when asked", async () => {
  world.controlPlane.flags.mailResults = [{ address: "ada@work.example", id: "m1", threadId: "m1", date: "2026-10-29T10:00:00.000Z", from: "Jo <jo@example.com>", to: "ada@work.example", subject: "SHIFTMED-FACILITIES", snippet: "" }];
  world.model.install([{ toolCalls: [{ name: "search", args: { query: "shiftmed", args: { email: true, account: "ada@work.example" } } }] }, { text: "Found it." }]);
  await tagged("", "Tex which facilities are in the ShiftMed mail?", {}, { mail: [{ handle: "ada", address: "ada@work.example" }] });
  const first = world.model.requests.length - 2;
  const system = JSON.stringify(world.model.requests[first].system);
  assert.match(system, /@ada's ada@work\.example/);
  assert.match(system, /nothing watches it here on its own/);
  assert.match(toolReplies(world.model.requests.at(-1))[0], /SHIFTMED-FACILITIES/);
  assert.equal(world.controlPlane.mailReadCalls.at(-1)?.path, "/gateway/email/search");
});
