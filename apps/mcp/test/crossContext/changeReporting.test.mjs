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

  /*
    A note moved between two contexts is reported to the control plane, which
    is where the console map reads "notes moving between your workspaces"
    from: both buckets' audit rows are where no request can afford to look.
    Sabotage-checked: dropping the `reportContextMove` call from
    `acrossContexts.js` fails the first check; binding the reporter to the
    destination's store fails the second.
  */
  harness.mine.set("1-projects/leaving-for-theirs.md", {
    body: "# Leaving\n",
    etag: "m-report-move-1",
  });
  controlPlane.calls.length = 0;
  const moved = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "1-projects/leaving-for-theirs.md",
    destination: "1-projects/arrived-from-mine.md",
    source_context: "@mine",
    destination_context: "@theirs",
  });
  check("a cross-context move still succeeds", /moved:/.test(textOf(moved)));
  const moves = sent("/gateway/moves");
  check(
    "a cross-context move tells the control plane both ends, the paths and who",
    moves.length === 1 &&
      moves[0].fromWorkspaceId === "ws_own" &&
      moves[0].toWorkspaceId === "ws_shared" &&
      moves[0].fromPath === "1-projects/leaving-for-theirs.md" &&
      moves[0].toPath === "1-projects/arrived-from-mine.md" &&
      moves[0].actorUserId === "user_cross_editor",
  );
  check(
    "and carries no note content",
    !JSON.stringify(moves).includes("# Leaving"),
  );
  controlPlane.calls.length = 0;
  await callTool(env, TOKEN_EDITOR, "write_note", {
    context: "@theirs",
    path: "1-projects/not-a-move.md",
    content: "# Not a move\n",
  });
  check("a write in another context is not reported as a move", sent("/gateway/moves").length === 0);
}
