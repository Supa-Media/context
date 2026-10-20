/**
 * TEX KNOWS WHICH WORKSPACES THERE ARE, AND WRITES WHERE THE PROJECT IS
 * (owner, 2026-10-14, relaying a friend: "it was writing v2l notes into my
 * personal workspace").
 *
 * A call with no `context:` lands in the connection's default, the personal
 * workspace for a text. Every turn is now told the workspaces the person can
 * reach, which one is the default, and to write a project's note beside that
 * project's notes.
 *
 * ## Sabotage record
 *
 *   `runTurn` dropping `workspaces` from the system prompt
 *     → "a turn is told the workspaces it can write in" fails
 *   `describe` leaving out "read only"
 *     → "names each workspace, its kind, and the default" fails
 *   `workspacesPrompt` saying nothing for one workspace
 *     → "one workspace ... is still offered a shared one" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { MAX_LISTED_WORKSPACES, workspacesPrompt } from "../src/agent/workspaces.js";
import { contextsFor } from "../src/context/identity.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

// A texting session: the personal workspace is the default, and two shared ones are reachable.
const session = {
  workspaceId: "ws_ada",
  scopes: ["context:read", "context:write"],
  workspaces: [
    { workspaceId: "ws_ada", slug: "ada", role: "owner", kind: "personal" },
    { workspaceId: "ws_v2l", slug: "v2l", role: "editor", kind: "shared" },
    { workspaceId: "ws_club", slug: "club", role: "member", kind: "shared" },
  ],
};

test("names each workspace, its kind, and the default", () => {
  const prompt = workspacesPrompt(contextsFor(session));
  assert.match(prompt, /@ada \(their personal workspace, the default\)/);
  assert.match(prompt, /@v2l \(shared\)/);
  assert.match(prompt, /A tool call with no context: goes to @ada\./);
  assert.match(prompt, /write beside them with context: "@name"/);
  assert.match(prompt, /Tell them which workspace you wrote in/);
});

test("a workspace they can only read says so", () => {
  const prompt = workspacesPrompt([
    { name: "@ada", kind: "personal", role: "owner", current: true, canWrite: true },
    { name: "@club", kind: "shared", role: "member", current: false, canWrite: false },
  ]);
  assert.match(prompt, /@club \(shared, read only\)/);
});

test("one workspace is no choice of where to write, but is still offered a shared one", () => {
  const prompt = workspacesPrompt([{ name: "@ada", kind: "personal", role: "owner", current: true, canWrite: true }]);
  assert.doesNotMatch(prompt, /They can reach these workspaces/);
  assert.match(prompt, /done with at least one other person/);
  assert.equal(workspacesPrompt(null), "");
});

test("work with another person is offered a shared workspace, made and invited under one yes", () => {
  const prompt = workspacesPrompt(contextsFor(session));
  assert.match(prompt, /a business, a ministry, a nonprofit/);
  assert.match(prompt, /create_workspace with slug, name and invite: \[\{ who \}\]/);
  assert.match(prompt, /Never create a workspace or invite anyone without that yes/);
  assert.match(prompt, /if they say no, remember that/);
  assert.match(prompt, /manage action invite and context: "@name"/);
});

test("a long list is capped and points at orient", () => {
  const many = Array.from({ length: MAX_LISTED_WORKSPACES + 3 }, (_, i) => ({
    name: `@w${i}`,
    kind: "shared",
    role: "member",
    current: i === 0,
    canWrite: true,
  }));
  const prompt = workspacesPrompt(many);
  assert.match(prompt, /and 3 more \(orient lists them all\)/);
  assert.doesNotMatch(prompt, new RegExp(`@w${MAX_LISTED_WORKSPACES}\\b`));
});

test("a turn is told the workspaces it can write in", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(input);
      return { choices: [{ message: { content: "Done." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  await runTurn({
    question: "add a v2l note about the launch",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    callTool: async () => ({ content: [] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    workspaces: contextsFor(session),
  });
  const system = calls[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.match(system, /They can reach these workspaces: @ada .*@v2l \(shared\)/);
});
