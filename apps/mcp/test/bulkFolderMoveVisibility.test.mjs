/**
 * A folder move past the logical threshold must not publish what it moves.
 *
 * ## WHY THIS SUITE EXISTS
 *
 * `move_folder` has two implementations, chosen by size. Under
 * `LOGICAL_FOLDER_MOVE_THRESHOLD` objects it builds one `moves` entry per note
 * and writes, for each, the NARROWER of what the note was and what the
 * destination folder grants — the rule that stops a move widening, argued in
 * `toolMoveNote`'s own comment. Over the threshold it returns earlier, into
 * `createLogicalFolderMove`, which never computes that value: it calls
 * `persistPrivacyFolderMove`, which re-prefixes the manifest's RULES and
 * OVERRIDES from the source tree to the destination tree.
 *
 * That is complete for a folder holding its own rule, and for a note holding
 * its own exception. **It carries nothing for a note that is private only
 * because an ancestor that is not moving says so** — which is the ordinary
 * case, since `visibilityOf` is longest-prefix and a note under a private
 * folder needs no line in `privacy.md` at all.
 *
 * So the same operation, on the same notes, gives two different answers
 * depending on how many objects the folder happens to hold: at 500 the notes
 * stay private, and at 501 they land on the destination folder's rule. The
 * owner is told `logical move active` either way.
 *
 * This is the shape the register already knows from the control plane's
 * `movePath`: the exception case was carried and the INHERITED case was not.
 * Fixed there; never checked here, because the comparison that found it read
 * `move_note` and stopped.
 *
 * What is proved here:
 *
 *  1. a folder of more than `LOGICAL_FOLDER_MOVE_THRESHOLD` notes, private only
 *     by inheritance, moved into a `team` folder, is still private to a team
 *     connection — before and after materialization;
 *  2. the same move under the threshold already behaved that way, so the two
 *     paths agree rather than one being dragged to the other's answer;
 *  3. a note's own `team` exception still survives the bulk move, so the fix
 *     narrows nothing the owner deliberately widened.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-bulk-visibility.test";

const TOKEN_OWNER = `cat_bulkvis_owner_${"0".repeat(23)}`;
const TOKEN_TEAM = `cat_bulkvis_team_${"0".repeat(24)}`;

/*
  `2-areas` is private and `1-projects` is team. Neither `2-areas/deep` nor any
  note under it is named anywhere — that absence is the whole point: the notes
  are private by the longest matching prefix and by nothing else.
*/
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  2-areas: private\n  2-areas/circle: @bulkvis-circle\n\n" +
  "note_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: false,
      serverSideCopy: false,
    },
    status: "active",
  };
}

async function callTool(env, tokenValue, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return body?.result;
}

const textOf = (result) => result?.content?.[0]?.text || "";

export async function runBulkFolderMoveVisibilityChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_bulkvis", "bulkvis", binding("bulk-visibility", "AA"));
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_bulkvis",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_bulkvis",
    userId: "user_bulkvis",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_TEAM,
    workspaceId: "ws_bulkvis",
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_bulkvis_team",
    userId: "user_bulkvis_team",
  });

  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

  const primary = s3.bucketFor("bulk-visibility");
  primary.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "pm1" });

  /* ---------- 1. over the threshold, private only by inheritance ---------- */

  // 600 > LOGICAL_FOLDER_MOVE_THRESHOLD (500), so this takes the logical path.
  const BULK = 600;
  for (let n = 0; n < BULK; n += 1) {
    primary.set(`2-areas/deep/note-${String(n).padStart(4, "0")}.md`, {
      body: `SECRET-${n}`,
      etag: `d${n}`,
    });
  }
  const witness = "2-areas/deep/note-0000.md";
  const moved = "1-projects/deep/note-0000.md";

  const beforeTeam = await callTool(env, TOKEN_TEAM, "read_note", { path: witness });
  check(
    "a note private only by its folder's rule is not readable by a team connection",
    textOf(beforeTeam).includes("not found")
  );

  const bulk = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/deep",
    destination: "1-projects/deep",
  });
  check(
    "a folder past the threshold cuts over logically",
    !bulk?.isError && /logical move active/.test(textOf(bulk))
  );

  const afterTeam = await callTool(env, TOKEN_TEAM, "read_note", { path: moved });
  check(
    "THE ROW: a bulk move into a team folder does not publish a note that was private by inheritance",
    textOf(afterTeam).includes("not found")
  );

  const moveId = /move_id: (\S+)/.exec(textOf(bulk))?.[1];
  let passes = 0;
  let last = "";
  while (passes < 40 && moveId) {
    const pass = await callTool(env, TOKEN_OWNER, "materialize_move", { id: moveId });
    last = textOf(pass);
    passes += 1;
    if (pass?.isError || /complete|no active work/.test(last)) break;
  }
  // The background `defer` often finishes the job before this loop runs, in
  // which case `materialize_move` answers "not found" for an id that no longer
  // exists. Either way the claim is about the BYTES, so assert those rather
  // than the driver that moved them.
  check(
    "...and the move still materializes: the bytes are at the destination",
    primary.get(moved)?.body === "SECRET-0"
  );
  check("...and the source path is gone", primary.get(witness) === undefined);

  const afterMaterialized = await callTool(env, TOKEN_TEAM, "read_note", {
    path: moved,
  });
  check(
    "...and it is still private once the bytes have physically landed",
    textOf(afterMaterialized).includes("not found")
  );

  const ownerReads = await callTool(env, TOKEN_OWNER, "read_note", { path: moved });
  check(
    "...while the owner still reads their own note at its new path",
    textOf(ownerReads).includes("SECRET-0")
  );

  /* ---------------- 2. the small path, for the same shape ----------------- */

  for (let n = 0; n < 3; n += 1) {
    primary.set(`2-areas/small/note-${n}.md`, { body: `SMALL-${n}`, etag: `s${n}` });
  }
  const small = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/small",
    destination: "1-projects/small",
  });
  check("a folder under the threshold moves directly", !small?.isError);
  const smallTeam = await callTool(env, TOKEN_TEAM, "read_note", {
    path: "1-projects/small/note-0.md",
  });
  check(
    "...and the two paths agree: under the threshold it was already private",
    textOf(smallTeam).includes("not found")
  );

  /* ------------- 3. a deliberate team exception still survives ------------ */

  primary.set("2-areas/shared/note-0.md", { body: "SHARED-0", etag: "x0" });
  // `confirm_team_publish` is required, and that refusal is the product
  // working: publishing a private note is a decision, not a parameter. The
  // first draft of this fixture left it out, read the refusal as a move
  // defect, and would have filed a second row against correct code.
  const setVis = await callTool(env, TOKEN_OWNER, "set_visibility", {
    path: "2-areas/shared/note-0.md",
    visibility: "team",
    confirm_team_publish: true,
  });
  check("the owner can deliberately publish one note", !setVis?.isError);
  const sharedMove = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/shared",
    destination: "1-projects/shared",
  });
  check("a folder holding a deliberately shared note moves", !sharedMove?.isError);
  const sharedTeam = await callTool(env, TOKEN_TEAM, "read_note", {
    path: "1-projects/shared/note-0.md",
  });

  check(
    "...and the owner's own team exception is NOT narrowed by the fix",
    textOf(sharedTeam).includes("SHARED-0")
  );

  /* --------------- 4. a group folder keeps its group, not private -------- */

  /*
    A folder held to a GROUP, moved into a team folder. The narrowing is real —
    team is wider than one group — but the value that must land is the group,
    not `private`. Writing the literal here would silently retier the owner's
    own rule and hide the tree from the people they named, which `toolMoveNote`
    already warns about in as many words for the small path.

    The folder moved is `2-areas/circle/inner`, which declares NOTHING — it is
    the group's by inheritance from `2-areas/circle`. That matters: a folder
    holding its own group rule is carried by the re-prefix loop above and never
    reaches the new branch at all, so the first draft of this case moved the
    declaring folder and measured a **0** against a line it never executed.
    Hazard #7 — the sabotage has to reach the shape the code matches — read
    from the fixture's side.

    Without this case, replacing the computed value with `"private"` fails
    NOTHING: on two tiers the only branch that pushes always computes
    `private`, so the literal is indistinguishable there.
  */
  const GROUP_BULK = 600;
  for (let n = 0; n < GROUP_BULK; n += 1) {
    primary.set(`2-areas/circle/inner/note-${String(n).padStart(4, "0")}.md`, {
      body: `CIRCLE-${n}`,
      etag: `c${n}`,
    });
  }
  const groupMove = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/circle/inner",
    destination: "1-projects/circle",
  });
  check("a group-held folder past the threshold moves", !groupMove?.isError);
  const manifest = primary.get("privacy.md")?.body || "";
  check(
    "...and the destination rule carries the GROUP, not a retiering to private",
    /1-projects\/circle: @bulkvis-circle/.test(manifest)
  );
  check(
    "...and a team connection still cannot read it",
    textOf(
      await callTool(env, TOKEN_TEAM, "read_note", { path: "1-projects/circle/note-0000.md" })
    ).includes("not found")
  );

  restoreS3();
  restoreControlPlane();
}
