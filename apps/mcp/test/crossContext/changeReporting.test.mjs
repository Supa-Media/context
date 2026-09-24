/**
 * A write routed into another context tells THAT context's consoles.
 *
 * An agent connected to its person's own context and passing
 * `context: "@theirs"` writes into a shared workspace, and the people watching
 * that workspace are the ones whose tree and activity dot must move. The store
 * `openContext` builds had neither reporter, so every cross-context write was
 * announced to nobody: the new file appeared at the next periodic walk and no
 * dot lit, while the same write made from a connection to `@theirs` itself
 * did both. Sabotage-checked: dropping the reporters from `openContext` fails
 * the first two checks; binding them to the connection's own workspace fails
 * the last.
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import { callTool, textOf, TOKEN_EDITOR } from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextChangeReportingChecks(check, harness) {
  const { controlPlane, env } = harness;
  const sent = (path) => controlPlane.calls.filter((call) => call.path === path).map((call) => call.body);

  controlPlane.calls.length = 0;
  const written = await callTool(env, TOKEN_EDITOR, "write_note", {
    context: "@theirs",
    path: "1-projects/made-by-an-agent.md",
    content: "# Made by an agent\n",
  });
  check("a cross-context create still succeeds", /written:/.test(textOf(written)));

  const trees = sent("/gateway/tree");
  check(
    "a cross-context create tells the context it landed in that its tree changed",
    trees.length === 1 && trees[0].workspaceId === "ws_shared" && trees[0].audiences.includes("team"),
  );
  const activity = sent("/gateway/activity");
  check(
    "and lights that context's activity dot, never the connection's own",
    activity.length === 1 &&
      activity[0].workspaceId === "ws_shared" &&
      [...trees, ...activity].every((body) => body.workspaceId !== "ws_own"),
  );
}
