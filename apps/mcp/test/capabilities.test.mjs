import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CAPABILITIES, CAPABILITY_LIST, ONE_TO_ONE_ONLY, capabilitiesFor } from "../src/agent/capabilities.js";
import { ACTIONS } from "../src/tools/v2/actions.js";
import { STAFF_ONLY_TOOLS } from "../src/tools/registry.js";
import { ASSISTANT_SEND_ACTIONS } from "../src/agent/sixTools.js";
import { COMMAND_SEND_ACTIONS } from "../src/agent/commandTools.js";
import { SOMEBODYS_ALONE } from "../src/agent/groupTurn.js";
import { chatMailPrompt } from "../src/agent/groupMail.js";
import { architectureFor } from "../src/agent/texArchitecture.js";

// Dev2, 2026-11-08: "One capability list everywhere", and "how are we making sure these capabilities lists are updated as we build?"
// Every action, chat command and group command word is on a line, or this fails (`capabilities.js`).

/** The group command words the texting Worker answers by code (`apps/agent/src/groupWords.ts`, its `Command` type). */
function groupWordKinds() {
  const source = readFileSync(new URL("../../agent/src/groupWords.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("export type Command ="), source.indexOf(";\n", source.indexOf("export type Command =")));
  return [...block.matchAll(/kind: "([a-z_]+)"/g)].map((match) => match[1]);
}

/** Everything a person can get Tex to do by a tool or a command, each with the tool that carries it (null for words). */
function everything() {
  const all = new Map();
  // A staff tool (`STAFF_ONLY_TOOLS`, the Architecture Lab's `run_model`) is never Tex's (`WITHHELD_TOOLS`), so it is
  // nothing a person can get Tex to do, and a line for it would only add words to every turn's prompt.
  for (const family of ["write", "manage", "send"]) {
    for (const [name, entry] of Object.entries(ACTIONS[family])) if (!STAFF_ONLY_TOOLS.has(entry.tool)) all.set(`${family}.${name}`, entry.tool);
  }
  for (const [name, entry] of Object.entries(ASSISTANT_SEND_ACTIONS)) {
    all.set(Object.hasOwn(COMMAND_SEND_ACTIONS, name) ? `command.${name}` : `send.${name}`, entry.tool);
  }
  for (const kind of groupWordKinds()) all.set(`words.${kind}`, null);
  return all;
}

test("every action, chat command and group command word is on the capability list", () => {
  const listed = new Set(CAPABILITIES.flatMap((entry) => entry.actions));
  const missing = [...everything().keys()].filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `add a line (or an action to a line) in apps/mcp/src/agent/capabilities.js for: ${missing.join(", ")}`);
});

test("the list names nothing that no longer exists, and each action once", () => {
  const known = everything();
  const seen = new Set();
  for (const entry of CAPABILITIES) {
    for (const name of entry.actions) {
      assert.ok(known.has(name), `${entry.name}: ${name} is not an action, command or group word any more`);
      assert.ok(!seen.has(name), `${name} is on two lines`);
      seen.add(name);
    }
  }
});

test("a line offers in a group only what a group turn is given", () => {
  const tools = everything();
  for (const entry of CAPABILITIES) {
    const carried = entry.actions.map((name) => tools.get(name)).filter((tool) => typeof tool === "string");
    if (carried.length === 0) continue;
    const alone = carried.filter((tool) => SOMEBODYS_ALONE.has(tool));
    if (entry.group === null) assert.equal(alone.length, carried.length, `${entry.name}: a group has ${carried.filter((t) => !SOMEBODYS_ALONE.has(t)).join(", ")}, so say what it does there`);
    else assert.deepEqual(alone, [], `${entry.name}: a group never gets ${alone.join(", ")}; move it to a line with group: null`);
  }
});

test("every line says what it is in a 1:1 text and in a group", () => {
  for (const entry of CAPABILITIES) {
    assert.equal(typeof entry.name, "string");
    assert.ok(typeof entry.texts === "string" && entry.texts.length > 0, `${entry.name}: no 1:1 words`);
    assert.ok(entry.group === null || (typeof entry.group === "string" && entry.group.length > 0), `${entry.name}: group is words or null`);
    assert.ok(CAPABILITY_LIST.includes(`- ${entry.name}. 1:1: ${entry.texts}.`), `${entry.name}: drawn into the list`);
  }
  assert.ok(CAPABILITY_LIST.includes(`Group chat: ${ONE_TO_ONE_ONLY}.`), "a 1:1-only line says so in a group");
});

test("sharing mail with a group: 1:1 Tex says where and how, and who sends", () => {
  const line = CAPABILITY_LIST.split("\n").find((text) => text.startsWith("- Sharing someone's mail with a group chat."));
  assert.ok(line, "the line is on the list");
  assert.match(line, /1:1: is done from inside the group/);
  assert.match(line, /Tex, share my mail from <their address> here/);
  assert.match(line, /Only the mailbox's own person can share it/);
  const email = CAPABILITY_LIST.split("\n").find((text) => text.startsWith("- Sending email."));
  assert.match(email, /Anyone can ask for a draft and refine it; only the mailbox's own person sends it/);
});

test("setting up a computer (community compute) is Tex's own job, on the list", () => {
  assert.match(CAPABILITY_LIST, /- Setting up their computers \(community compute\)\. 1:1: do it yourself with send action computers, never send them to the app/);
});

test("a group with no mail shared is told how to share it, never to not offer it", () => {
  const words = chatMailPrompt({ mail: [] });
  assert.doesNotMatch(words, /never offer/);
  assert.match(words, /Tex, share my mail from <address> here/);
  assert.match(words, /chat_share_mail/);
});

test("the roles that talk, guide or check Tex carry the list and where they are; the others don't", () => {
  for (const role of ["texts", "group", "job", "advisor", "reviewer"]) {
    const text = architectureFor(role);
    assert.ok(text.includes(CAPABILITY_LIST), `${role} carries the list`);
    assert.ok(text.includes(capabilitiesFor(role)), `${role} says where it is`);
  }
  assert.match(capabilitiesFor("texts"), /You are in a 1:1 text/);
  assert.match(capabilitiesFor("group"), /You are in a group chat/);
  for (const role of ["cardCheck", "threads", "daySummary"]) {
    assert.equal(capabilitiesFor(role), "");
    assert.ok(!architectureFor(role).includes(CAPABILITY_LIST), `${role} has no use for it`);
  }
  assert.equal(architectureFor("texts"), architectureFor("texts"), "the same bytes every call");
});

// Dev2, 2026-11-08: a list of what Tex can't do, where, and the way around it, kept with the capability it waits on.
test("every can't says where, and hands a way around it of a known kind", async () => {
  const { CANT_WHERE, WORKAROUND_KINDS } = await import("../src/agent/capabilities.js");
  const cants = CAPABILITIES.flatMap((entry) => (entry.cant ?? []).map((cant) => ({ entry, cant })));
  assert.ok(cants.length >= 10, "the list carries the can'ts");
  for (const { entry, cant } of cants) {
    assert.ok(Object.hasOwn(CANT_WHERE, cant.where), `${entry.name}: where is one of ${Object.keys(CANT_WHERE).join(", ")}`);
    assert.ok(typeof cant.what === "string" && cant.what.length > 0, `${entry.name}: what can't be done`);
    assert.ok(WORKAROUND_KINDS.includes(cant.workaround?.kind), `${entry.name}: a workaround kind`);
    assert.ok(typeof cant.workaround.text === "string" && cant.workaround.text.length > 0, `${entry.name}: a workaround`);
    assert.ok(CAPABILITY_LIST.includes(`you can't ${cant.what} (${entry.name}). Instead: ${cant.workaround.text}.`), `${entry.name}: drawn into the list`);
  }
  assert.match(CAPABILITY_LIST, /WHAT YOU CAN'T DO YET, AND THE WAY AROUND IT/);
});

// Dev2, 2026-11-08 ("Tex does it, plus rule and CI"): the computer can'ts that waited on Tex's own tool are gone, and
// what stays is only what's a person's: answering Ask me first from a 1:1, and the Mac app's own switch and folders.
test("community compute: Tex pairs and lends itself, and pair_device is never offered for jobs", () => {
  const lines = CAPABILITY_LIST.split("\n");
  assert.equal(lines.some((text) => text.includes("install the runner on someone's computer")), false, "pairing is no longer a can't");
  assert.equal(lines.some((text) => text.includes("lend or take back a computer for a group chat")), false, "lending is no longer a can't");
  const setup = lines.find((text) => text.startsWith("- Setting up their computers"));
  assert.match(setup, /do setup_prompt/);
  assert.match(setup, /do pair/);
  assert.match(setup, /Tex, lend my computer here/);
  assert.match(CAPABILITY_LIST, /mail only and never runs your jobs/, "pair_device is never offered as pairing for jobs");
});

// Agent-first (Dev2, 2026-11-08; `docs/decisions/texting-assistant/computer-setup.md`): every app route that changes a
// person's computers is on a line Tex can do, or on a can't that hands the way around it. A new route on no line fails here.
test("every computer app route is something Tex can do, or a can't with its way around", async () => {
  const { MACHINE_APP_PATHS } = await import("../src/machines/appRoutes.js");
  const covered = new Map();
  for (const entry of CAPABILITIES) {
    for (const route of entry.appRoutes ?? []) covered.set(route, entry.name);
    for (const cant of entry.cant ?? []) for (const route of cant.appRoutes ?? []) covered.set(route, `${entry.name} (can't)`);
  }
  const missing = [...MACHINE_APP_PATHS].filter((route) => !covered.has(route));
  assert.deepEqual(missing, [], `give Tex these, or add a can't with the way around it, in apps/mcp/src/agent/capabilities.js: ${missing.join(", ")}`);
  for (const route of covered.keys()) assert.ok(MACHINE_APP_PATHS.has(route), `${covered.get(route)}: ${route} is not an app route any more`);
});
