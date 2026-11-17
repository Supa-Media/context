// End to end through a real texted turn (the replay harness), kept as a unit test: the pipeline replay area is at
// its 20-case cap (Dev2, 2026-11-15). Fails with the wrapper removed from runTheModel.js (checked, 2026-11-17).
import assert from "node:assert/strict";
import { test } from "node:test";
import { oneToOne } from "./replay/chats.mjs";
import { call, textOf, TOKEN_MCP } from "./agentEgressFixtures.mjs";

const CASE = {
  id: "reads-workspace-rules",
  incident: "2026-11-16: in a 1:1 chat Tex made a project in a shared workspace with a layout of its own, tasks as checkboxes in the overview, where that workspace's index.md says one note per task. It never read the index.",
  cause: "Nothing loaded another workspace's index.md, about.md or README.md before Tex worked there; the prompt only said to follow them.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      const seeded = await call(chat.world.env, TOKEN_MCP, "write_note", { path: "notes/README.md", content: "# Notes\n\nEvery project gets overview.md plus one task-<name>.md note per task.\n", context: "@egress-team" });
      assert.match(textOf(seeded), /written: notes\/README\.md/, textOf(seeded));
      const { shown } = await chat.text("what projects does the team have?", [
        { toolCalls: [{ name: "fetch", args: { id: "notes/", context: "@egress-team" } }] },
        { text: "None yet." },
      ]);
      assert.match(shown, /How @egress-team is kept/, "the first call into the team workspace comes back with its rules");
      assert.match(shown, /one task-<name>\.md note per task/, "read from its own README.md");
    } finally {
      chat.restore();
    }
  },
};

test(CASE.incident, () => CASE.run());
