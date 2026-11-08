/**
 * TEX SETS UP A PERSON'S COMPUTER ITSELF (`src/machines/texActions.js`;
 * decided by the owner, 2026-11-08; `docs/decisions/texting-assistant/computer-setup.md`).
 *
 * "Tex add my computer for community compute" got "Connect it on your own Tex
 * page first", because every step was a button in the app. Here: the tool is
 * offered where it belongs, does what the app's routes do on the person's own
 * computers, and never acts for anyone else or from words that aren't theirs.
 *
 * Sabotage (applied by hand, the named test observed failing, reverted):
 *  - `pair` without `codeInWords` → "a pairing code is approved only when it is in their own words, in their own texts";
 *  - `owned()` without the `ownerId` re-check → "somebody else's computer is never theirs, even in a shared workspace";
 *  - `lend` without the own-words check → "another member's words, a quote or an email lend nothing";
 *  - `computerTools` offering a guest's tag → "the tool is offered to their own texts and a group's turn, never a guest's tag".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { codeInWords, computerTools, COMPUTER_SEND_ACTIONS, signInCodeInWords } from "../src/machines/texActions.js";
import { setupPrompt } from "../src/machines/setupPrompt.js";
import { ASSISTANT_SEND_ACTIONS } from "../src/agent/sixTools.js";
import { FACTS, machineWorld } from "./machineWorld.mjs";

const CHAT = "c".repeat(64);
const KEY = `group-${CHAT.slice(0, 58)}`;

function setupWorld() {
  const w = machineWorld({ workspaceId: "ws_team" });
  const namespace = {
    idFromName: (name) => name,
    get: () => ({
      async fetch(request) {
        return await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text()));
      },
    }),
  };
  const lent = [];
  const approved = [];
  const revoked = [];
  const controlPlane = {
    lent,
    approved,
    revoked,
    // Mirrors `texMachinesOwnedBy`: by the owner the control plane holds. Somebody else's is listed here on purpose
    // under user_ade, so the gateway's own re-check against the object's ownerId is what keeps it out.
    async texMachinesOwned(userId) {
      if (userId === "user_owner") return [{ machineId: "mch_1", workspaceId: "ws_team" }];
      if (userId === "user_ade") return [{ machineId: "mch_1", workspaceId: "ws_team" }];
      return [];
    },
    async texMachinePairApproveFromTexts(accessToken, code) {
      approved.push({ accessToken, code });
      return code.replace(/[^A-Z0-9]/gi, "").toUpperCase() === "KQ74MP" ? { approved: { name: "MacBook Air", os: "macos", workspaceId: "ws_personal" } } : { refused: "PAIRING_NOT_FOUND" };
    },
    async texMachineChatAttach(userId, machineId, groupKey) {
      if (userId !== "user_owner") return { refused: 404 };
      if (!lent.some((entry) => entry.machineId === machineId && entry.groupKey === groupKey)) lent.push({ userId, machineId, groupKey });
      return { attached: true, workspaceId: "ws_team" };
    },
    async texMachineChatDetach(userId, machineId, groupKey) {
      const at = lent.findIndex((entry) => entry.userId === userId && entry.machineId === machineId && entry.groupKey === groupKey);
      if (at >= 0) lent.splice(at, 1);
      return { detached: at >= 0 };
    },
    async texMachineChatPeople(userId, groupKey) {
      const people = [{ userId: "user_owner", handle: "seyi" }, { userId: "user_ade", handle: "ade" }];
      return groupKey === CHAT && people.some((person) => person.userId === userId) ? people : null;
    },
    async texMachinesForChat() {
      return lent.map(({ machineId, userId }) => ({ machineId, workspaceId: "ws_team", ownerId: userId }));
    },
    async texMachineRevoke(machineId, userId) {
      if (userId !== "user_owner") return null;
      revoked.push({ machineId, userId });
      return { revoked: true, workspaceId: "ws_team" };
    },
  };
  return { w, env: { WORKSPACE_STORE: namespace }, controlPlane };
}

const ownTexts = (userId = "user_owner") => ({ actorClientId: "context_texts", actorUserId: userId, accessToken: "cat_fake_texts", workspaceId: "ws_personal", workspaces: [] });
const groupTurn = (userId = "user_owner") => ({ actorClientId: "context_texts_group", actorUserId: userId, accessToken: "cat_fake_group", texChatId: CHAT, workspaceId: "ws_team", workspaces: [] });

async function setup() {
  const world = setupWorld();
  const machine = await world.w.add("mch_1", { name: "Studio Mac" });
  const server = await world.w.connect(machine, { hello: { facts: { ...FACTS, signIn: ["claude", "codex"], install: ["claude", "codex"] } } });
  const tool = (session, words, group = session.actorClientId === "context_texts" ? null : { key: CHAT }, judge = null) =>
    computerTools({ env: world.env, session, controlPlane: world.controlPlane, group, words, judge })[0];
  const run = async (session, words, args, group) => {
    const result = await tool(session, words, group).call(args);
    return { error: result.isError === true, said: result.content[0].text };
  };
  return { ...world, server, tool, run };
}

test("the tool is offered to their own texts and a group's turn, never a guest's tag", async () => {
  const { tool, env, controlPlane } = await setup();
  assert.ok(tool(ownTexts(), ""));
  assert.ok(tool(groupTurn(), ""));
  assert.equal(computerTools({ env, session: groupTurn(), controlPlane, group: { key: CHAT, guestTagger: true }, words: "" }).length, 0);
  assert.equal(computerTools({ env, session: { ...ownTexts(), actorClientId: "some_ai_client" }, controlPlane, group: null, words: "" }).length, 0);
  assert.equal(computerTools({ env: {}, session: ownTexts(), controlPlane, group: null, words: "" }).length, 0);
  // Shown to the model as a send action.
  assert.equal(ASSISTANT_SEND_ACTIONS.computers.tool, COMPUTER_SEND_ACTIONS.computers.tool);
});

test("the setup prompt is the download page's, and tells the agent never to approve the code", async () => {
  const { run } = await setup();
  const own = await run(ownTexts(), "help me set up my laptop", { do: "setup_prompt", system: "mac" });
  assert.equal(own.error, false);
  assert.ok(own.said.includes(setupPrompt("mac")));
  assert.match(own.said, /never approve it yourself/);
  assert.match(own.said, /do pair/);
  const group = await run(groupTurn(), "Tex help me setup community compute", { do: "setup_prompt", system: "linux" });
  assert.match(group.said, /in your own texts with Tex, not here/);
});

test("a pairing code is approved only when it is in their own words, in their own texts", async () => {
  const { run, controlPlane } = await setup();
  // Not in their words: an email or another message put it there.
  assert.equal((await run(ownTexts(), "pair the code from that email", { do: "pair", code: "KQ7-4MP" })).error, true);
  // In a group, never: anyone there could approve it into their own account.
  assert.equal((await run(groupTurn(), "Tex pair KQ7-4MP", { do: "pair", code: "KQ7-4MP" })).error, true);
  assert.equal(controlPlane.approved.length, 0);
  const paired = await run(ownTexts(), "here's the code kq7 4mp", { do: "pair", code: "KQ7-4MP" });
  assert.equal(paired.error, false);
  assert.match(paired.said, /^Paired: "MacBook Air"/);
  // With their own texting token, never one from the arguments.
  assert.deepEqual(controlPlane.approved, [{ accessToken: "cat_fake_texts", code: "KQ7-4MP" }]);
  const refused = await run(ownTexts(), "code ZZZ-ZZZ", { do: "pair", code: "ZZZ-ZZZ" });
  assert.equal(refused.error, true);
  assert.match(refused.said, /^Not paired: no computer is showing that code/);
});

test("lending to this group, from its owner's own words, with who and Ask me first", async () => {
  const { run, controlPlane, w } = await setup();
  const said = await run(groupTurn(), "Tex add my computer for community compute, anyone can use it", { do: "lend", who: "everyone", ask_first: false });
  assert.equal(said.error, false);
  assert.deepEqual(controlPlane.lent, [{ userId: "user_owner", machineId: "mch_1", groupKey: CHAT }]);
  assert.deepEqual({ who: w.machines.get("mch_1").chats[KEY].who, askFirst: w.machines.get("mch_1").chats[KEY].askFirst }, { who: "everyone", askFirst: false });
  // By handle: the owner and the people named.
  await run(groupTurn(), "Tex lend my mac to @ade only", { do: "lend", who: "@ade" });
  assert.deepEqual(w.machines.get("mch_1").chats[KEY].who, ["user_owner", "user_ade"]);
  assert.equal(w.machines.get("mch_1").chats[KEY].askFirst, true);
  const listed = await run(groupTurn(), "which computers do I have", { do: "list" });
  assert.match(listed.said, /lent here: named people may use it, Ask me first on/);
  assert.equal((await run(groupTurn(), "Tex take my computer back", { do: "unlend" })).error, false);
  assert.deepEqual(controlPlane.lent, []);
  assert.equal(w.machines.get("mch_1").chats[KEY], undefined);
  // In their own texts there is no group to lend to.
  assert.equal((await run(ownTexts(), "lend my computer", { do: "lend" })).error, true);
});

test("another member's words, a quote or an email lend nothing", async () => {
  const { tool, controlPlane, w } = await setup();
  // No computer words at all: the code check stops it before the judge.
  assert.equal((await tool(groupTurn(), "sounds good", { key: CHAT }).call({ do: "lend", who: "everyone" })).isError, true);
  // The judge says no.
  const judged = computerTools({ env: setupWorld().env, session: groupTurn(), controlPlane, group: { key: CHAT }, words: "my computer is slow", judge: async () => ({ allow: false }) })[0];
  assert.equal((await judged.call({ do: "lend", who: "everyone" })).isError, true);
  assert.deepEqual(controlPlane.lent, []);
  assert.equal(w.machines.get("mch_1").chats?.[KEY], undefined);
});

test("somebody else's computer is never theirs, even in a shared workspace", async () => {
  const { run, controlPlane, w } = await setup();
  const ade = await run(groupTurn("user_ade"), "Tex lend the studio mac here", { do: "lend", computer: "Studio Mac", who: "everyone" });
  assert.equal(ade.error, true);
  assert.match(ade.said, /no computer paired/);
  assert.equal((await run(ownTexts("user_ade"), "disconnect the studio mac", { do: "disconnect", computer: "Studio Mac" })).error, true);
  assert.deepEqual(controlPlane.lent, []);
  assert.deepEqual(controlPlane.revoked, []);
  assert.ok(w.machines.get("mch_1"));
});

test("rename, limits, more time and install change the computer as the app does", async () => {
  const { run, w } = await setup();
  assert.equal((await run(ownTexts(), "rename my computer to Dev Box", { do: "rename", name: "Dev Box" })).error, false);
  assert.equal(w.machines.get("mch_1").name, "Dev Box");
  assert.equal((await run(ownTexts(), "let Tex use my computer 3 hours a day with 2 slots", { do: "limits", day_hours: 3, slots: 2 })).error, false);
  assert.equal(w.machines.get("mch_1").limits.dayMs, 3 * 3600000);
  assert.equal(w.machines.get("mch_1").limits.slots, 2);
  assert.equal((await run(ownTexts(), "give my computer 2 more hours today", { do: "more_time", hours: 2 })).error, false);
  assert.equal(w.machines.get("mch_1").raise.extraMs, 2 * 3600000);
  assert.equal((await run(ownTexts(), "install codex on my computer", { do: "install", tool: "codex" })).error, false);
  assert.equal(w.machines.get("mch_1").install.tool, "codex");
});

test("signing in is from their own texts only: Tex texts the link, and the code that comes back must be theirs", async () => {
  const { run, tool, w, server } = await setup();
  const LINK = "https://claude.com/cai/oauth/authorize?code=true&fake=1";
  const pending = tool(ownTexts(), "sign claude code in on my computer").call({ do: "sign_in", tool: "claude" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frame = server.sent.find((sent) => sent.type === "signIn");
  await w.frame(server, { type: "signInState", signInId: frame.signInId, tool: "claude", state: "link", url: LINK });
  const started = (await pending).content[0].text;
  assert.match(started, new RegExp(LINK.replace(/[?.]/g, "\\$&")));
  assert.match(started, /they text it to you/);
  const handed = await run(ownTexts(), "the code is abc123#xyz", { do: "sign_in_code", code: "abc123#xyz" });
  assert.equal(handed.error, false);
  assert.deepEqual(server.last(), { type: "signIn", signInId: frame.signInId, tool: "claude", code: "abc123#xyz" });
  assert.equal((await run(groupTurn(), "sign claude in on my computer", { do: "sign_in", tool: "claude" })).error, true);
  assert.equal((await run(ownTexts(), "sign it in", { do: "sign_in_code", code: "abc123#xyz" })).error, true);
  assert.equal(signInCodeInWords("abc123#xyz", "here: abc123#xyz"), true);
  assert.equal(signInCodeInWords("abc123#xyz", "here: abc123"), false);
});

test("disconnect revokes the grant, and the computer is gone", async () => {
  const { run, controlPlane, w } = await setup();
  assert.equal((await run(ownTexts(), "disconnect my computer from Tex", { do: "disconnect" })).error, false);
  assert.deepEqual(controlPlane.revoked, [{ machineId: "mch_1", userId: "user_owner" }]);
  assert.equal(w.machines.get("mch_1"), null);
});

test("with no computer yet, the answer is to set one up, never to go to the app", async () => {
  const { run, controlPlane } = await setup();
  controlPlane.texMachinesOwned = async () => [];
  const none = await run(groupTurn(), "Tex add my computer for community compute", { do: "lend" });
  assert.equal(none.error, true);
  assert.match(none.said, /do setup_prompt/);
  assert.doesNotMatch(none.said, /Tex page|machines page|settings/i);
});

test("a code counts however they spaced it, and only a whole code", () => {
  assert.equal(codeInWords("KQ7-4MP", "it says kq74mp"), true);
  assert.equal(codeInWords("KQ7-4MP", "KQ7 4MP"), true);
  assert.equal(codeInWords("KQ7-4MP", "KQ7-4MPX"), false);
  assert.equal(codeInWords("KQ7", "KQ7"), false);
});
