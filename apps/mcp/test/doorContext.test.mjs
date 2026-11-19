/**
 * The context a specialist door reads (`src/agent/doorContext.js`, `doorTurn.js`): each context part its config node's
 * `ctx` names is kept, the rest are dropped to their empty values, the history keeps `recent:<n>`, and a door whose
 * ctx names no context part (or none at all) reads the front door's whole context.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *   `doorArgs` returning `{ ...args }` for every ctx (no trim)   -> the quick and read trim cases fail.
 *   `runWithDoors` spreading `...args` instead of `doorArgs`      -> "the specialist reads its own context" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOOR_PARTS, doorArgs, doorContextParts, doorCtxOf } from "../src/agent/doorContext.js";
import { runWithDoors } from "../src/agent/doorTurn.js";

const turns = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` }));

/** The runTurn options a front door builds, with every context part filled in. */
function fullArgs() {
  return {
    question: "do it",
    tools: [],
    local: [],
    web: null,
    aboutMe: "about me",
    identity: "identity",
    voice: "voice",
    jobs: "jobs",
    calendar: "calendar",
    mail: "mail",
    groups: "groups",
    workspaces: "workspaces",
    devShare: "devshare",
    examples: "examples",
    examplesBudgetMs: 900,
    examplesFallback: "fallback",
    threadNote: [["group", "in a group"], ["cross", "cross"], ["hub", "hub words"], ["plan", "plan words"], ["instructions", "rules"]],
    history: turns,
  };
}

const quickCtx = ["p-about-tex", "recent:4", "date"];

test("a quick ctx drops the context parts it does not name, blanks the threads, and keeps the last 4 turns from a user", () => {
  const args = fullArgs();
  const out = doorArgs(args, quickCtx);
  assert.notEqual(out, args);
  for (const key of ["aboutMe", "identity", "voice", "jobs", "calendar", "mail", "examples", "workspaces"]) assert.equal(out[key], null, key);
  assert.equal(out.groups, "");
  assert.equal(out.devShare, "");
  assert.equal(out.examplesFallback, "");
  assert.equal("examplesBudgetMs" in out, false, "the budget key is removed");
  assert.deepEqual(out.history.map((turn) => turn.text), ["turn 6", "turn 7", "turn 8"], "the last 4 turns, from the first user turn among them");
  assert.equal(out.history[0].role, "user");
  assert.equal(out.history.length, 3);
  assert.deepEqual(out.threadNote, [["group", "in a group"], ["cross", "cross"], ["hub", ""], ["plan", ""], ["instructions", "rules"]]);
  assert.equal(out.question, "do it", "a part the door does not touch is kept");
  assert.equal(args.aboutMe, "about me", "the front door's args are not changed");
});

test("a read ctx keeps the parts it names, drops jobs and examples, keeps the whole history, and blanks the hub thread", () => {
  const args = fullArgs();
  const out = doorArgs(args, ["about", "calendar", "mail", "workspaces", "groups", "chat:7:130000"]);
  assert.equal(out.aboutMe, "about me");
  assert.equal(out.identity, "identity");
  assert.equal(out.voice, "voice");
  assert.equal(out.calendar, "calendar");
  assert.equal(out.mail, "mail");
  assert.equal(out.workspaces, "workspaces");
  assert.equal(out.groups, "groups");
  assert.equal(out.jobs, null);
  assert.equal(out.examples, null);
  assert.equal(out.devShare, "");
  assert.equal(out.history, turns, "no recent: entry: the history is whole");
  assert.deepEqual(out.threadNote.map(([name, text]) => [name, text]), [["group", "in a group"], ["cross", "cross"], ["hub", ""], ["plan", ""], ["instructions", "rules"]]);
});

test("an empty ctx and a null ctx hand back the very same args object", () => {
  const args = fullArgs();
  assert.equal(doorArgs(args, []), args);
  assert.equal(doorArgs(args, null), args);
  assert.equal(doorArgs(args, ["p-about-tex", "train:fd:all:60000"]), args, "prompt modules alone are no context");
  assert.equal(doorArgs(args, ["date", "tools"]).aboutMe, null, "unknown entries alone are a context part, so the parts are dropped");
});

test("recent:<n> keeps the last n, drops leading assistant turns, and ignores a value that is not an integer", () => {
  const args = fullArgs();
  assert.equal(doorArgs(args, ["recent:50"]).history.length, 9, "n larger than the history keeps all");
  const trailing = [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "assistant", text: "c" }, { role: "user", text: "d" }, { role: "assistant", text: "e" }];
  assert.deepEqual(doorArgs({ ...args, history: trailing }, ["recent:3"]).history.map((turn) => turn.text), ["d", "e"], "the last 3 start at an assistant: they drop to the user turn");
  assert.deepEqual(doorArgs({ ...args, history: trailing }, ["recent:x"]).history, trailing, "a non-integer is ignored");
  assert.deepEqual(doorArgs({ ...args, history: trailing }, ["recent:0"]).history, trailing, "zero is out of range and ignored");
  assert.deepEqual(doorContextParts(["p-x", "recent:2", "train:y", "date"]), ["recent:2", "date"]);
});

test("doorCtxOf reads the door node's ctx, and is null for a missing node or list", () => {
  const config = { nodes: [{ id: "fdQuick", ctx: quickCtx }, { id: "fdRead" }, { id: "other", ctx: ["about"] }] };
  assert.deepEqual(doorCtxOf(config, "quick"), quickCtx);
  assert.equal(doorCtxOf(config, "read"), null, "a node with no ctx");
  assert.equal(doorCtxOf(config, "act"), null, "a missing node");
  assert.equal(doorCtxOf({}, "quick"), null);
  assert.equal(doorCtxOf(null, "quick"), null);
  assert.ok(Object.isFrozen(DOOR_PARTS));
});

test("runWithDoors: the specialist reads its ctx; a fallback reads the full original args", async () => {
  const args = fullArgs();
  const seen = [];
  const runTurn = async (options) => {
    seen.push(options);
    return seen.length === 1 ? { outside: "asked for more tools" } : { answer: "full" };
  };
  const via = { door: async (route) => ({ door: route }) };
  const turn = await runWithDoors({
    runTurn,
    args,
    eligible: true,
    route: { route: "quick", sure: 0.9 },
    via,
    doorContext: (door) => (door === "quick" ? quickCtx : null),
  });
  assert.equal(seen.length, 2);
  assert.equal("aboutMe" in seen[0] && seen[0].aboutMe, null, "the specialist has no aboutMe");
  assert.equal(seen[0].history.length, 3);
  assert.equal(seen[1].aboutMe, "about me", "the fallback reads the full args");
  assert.equal(seen[1].history, turns);
  assert.equal(turn.answer, "full");
  assert.equal(turn.route.door, "fd");
});

test("runWithDoors: a doorContext that throws reads the full args", async () => {
  const args = fullArgs();
  const seen = [];
  const turn = await runWithDoors({
    runTurn: async (options) => (seen.push(options), { answer: "ok" }),
    args,
    eligible: true,
    route: { route: "quick", sure: 0.9 },
    via: { door: async (route) => ({ door: route }) },
    doorContext: () => { throw new Error("no config"); },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].aboutMe, "about me");
  assert.equal(turn.route.door, "quick");
});
