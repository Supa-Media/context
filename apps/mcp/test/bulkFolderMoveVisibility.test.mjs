/**
 * A folder move past the logical threshold must not publish what it moves.
 *
 * ## WHY THIS SUITE EXISTS
 *
 * `move_folder` had two implementations, chosen by size. Under
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
 * depending on how many objects the folder happens to hold: at the threshold
 * the notes stay private, and one above it they land on the destination folder's rule. The
 * owner is told `logical move active` either way.
 *
 * This is the shape the register already knows from the control plane's
 * `movePath`: the exception case was carried and the INHERITED case was not.
 * Fixed there; never checked here, because the comparison that found it read
 * `move_note` and stopped.
 *
 * Since 2026-10-13 the gateway has no logical path: a folder past the
 * threshold moves through the Convex move queue, which decides each moved
 * note's visibility in the control plane (and is tested there), or is
 * refused when the queue cannot take it. A job the old path left in a bucket
 * is still drained (1b), and the drain decides no visibility.
 *
 * What is proved here:
 *
 *  1. a folder of more than `LOGICAL_FOLDER_MOVE_THRESHOLD` notes, private only
 *     by inheritance, that the queue cannot take is refused and publishes
 *     nothing;
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
import { approving } from "./egressApproval.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

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

/** The owner's own app, which approves what the gate holds (`egressApproval.mjs`). */
const CONSOLE_OWNER = `cat_bulkvis_console_${"0".repeat(21)}`;

async function callTool(env, tokenValue, name, args = {}) {
  return approving(() => callToolOnce(env, tokenValue, name, args), {
    env,
    consoleToken: tokenValue === TOKEN_OWNER ? CONSOLE_OWNER : null,
  });
}

async function callToolOnce(env, tokenValue, name, args = {}) {
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
    accessToken: CONSOLE_OWNER,
    workspaceId: "ws_bulkvis",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_console",
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

  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };
  controlPlane.serveTreesFrom(env, { s3 });

  const primary = s3.bucketFor("bulk-visibility");
  primary.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "pm1" });

  /* ---------- 1. over the threshold, private only by inheritance ---------- */

  // 600 > LOGICAL_FOLDER_MOVE_THRESHOLD, so this takes the logical path.
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

  /*
    Past the threshold the gateway no longer moves a folder itself: the
    Convex move queue does, and decides there what each moved note may be
    seen as. With no queue (this harness) the move is refused, so nothing is
    published by it. The checks that drove the gateway's own logical move here
    ("cuts over logically", materialization, forwarding) are gone with it
    (2026-10-13).
  */
  const bulk = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/deep",
    destination: "1-projects/deep",
  });
  check(
    "a folder past the threshold the queue cannot take is refused",
    bulk?.isError === true && /could not queue this move/.test(textOf(bulk))
  );
  check(
    "THE ROW: a refused bulk move publishes nothing it would have moved",
    textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: moved })).includes("not found") &&
      primary.get(moved) === undefined &&
      textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: witness })).includes("not found")
  );

  /* ------- 1b. large materialization preserves collaboration history ----- */

  const ACTIVE_BULK = 501;
  for (let n = 0; n < ACTIVE_BULK; n += 1) {
    primary.set(`2-areas/active/note-${String(n).padStart(4, "0")}.md`, {
      body: `ACTIVE-${n}`,
      etag: `a${n}`,
    });
  }
  const activeWitness = "2-areas/active/note-0000.md";
  check(
    "reading one note in a large folder gives it active collaboration history",
    textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: activeWitness })).includes("ACTIVE-0"),
  );
  for (let n = 0; n < 101; n += 1) {
    primary.set(`2-areas/medium/note-${n}.md`, { body: `MEDIUM-${n}`, etag: `m${n}` });
  }
  const medium = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/medium",
    destination: "1-projects/medium",
  });
  check("a 101-note folder is past the one-go threshold: the queue's, and refused without it",
    medium?.isError === true && /could not queue this move/.test(textOf(medium)) &&
      primary.get("1-projects/medium/note-0.md") === undefined);

  /* ---------------- 2. the small path, for the same shape ----------------- */

  for (let n = 0; n < 3; n += 1) {
    primary.set(`2-areas/small/note-${n}.md`, { body: `SMALL-${n}`, etag: `s${n}` });
  }
  await callTool(env, TOKEN_OWNER, "read_note", { path: "2-areas/small/note-0.md" });
  const small = await callTool(env, TOKEN_OWNER, "move_folder", {
    source: "2-areas/small",
    destination: "1-projects/small",
  });
  check("a folder under the threshold moves directly", !small?.isError);
  check("a small folder also preserves a headed note on conditional-write-only storage",
    [...primary.values()].some((value) => {
      try {
        const head = JSON.parse(value.body);
        return head.path === "2-areas/small/note-0.md" && head.status === "moved" &&
          head.destination === "1-projects/small/note-0.md";
      } catch { return false; }
    }));
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
  // Under the threshold, so the gateway moves it in one go (past it, the
  // Convex move queue carries the group, and is tested there).
  const GROUP_BULK = 60;
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
  check("a group-held folder moves", !groupMove?.isError);
  // In one go, each moved note carries its narrower value as its own row. The owner sees every note, so each
  // one's read names the tier its row gives it.
  const groupNotes = [];
  for (let n = 0; n < GROUP_BULK; n += 1) {
    const read = textOf(
      await callTool(env, TOKEN_OWNER, "read_note", { path: `1-projects/circle/note-${String(n).padStart(4, "0")}.md` }),
    );
    groupNotes.push(read.match(/^visibility: (\S+)$/m)?.[1]);
  }
  check(
    "...and each moved note carries the GROUP, not a retiering to private",
    groupNotes.length === GROUP_BULK && groupNotes.every((value) => value === "@bulkvis-circle")
  );
  check(
    "...and a team connection still cannot read it",
    textOf(
      await callTool(env, TOKEN_TEAM, "read_note", { path: "1-projects/circle/note-0000.md" })
    ).includes("not found")
  );

  /* ---- 4. a move must not publish the PATH of what it moves ------------- */

  /*
    The privacy engine answers `not found` for the moved note. The link sweep
    then writes that note's new path into every note that referenced it — and
    those notes keep their own, wider visibility. So a team reader who is
    refused the note is handed its exact path by a note they may read.

    `rewriteLinks` resolves a link, maps it through `renames`, and writes the
    result back; nothing compares the destination's visibility with the
    referrer's. The owner-only forwarding sweep widens the same write to every
    earlier move in the ledger.

    The third check below is the positive control, and it is not optional: the
    sweep is skipped entirely past `LINK_SCAN_CAP`, and a skipped sweep writes
    no path and would read as "no leak". It has to be proved that a rewrite
    this move SHOULD make still happens.
  */

  primary.set("1-projects/linkhub/hub.md", {
    body: "# Hub\n\nPrivate-bound: [[1-projects/linkhub/secret-topic]]\n" +
      "Group-bound: [[1-projects/linkhub/circle-topic]]\n" +
      "Stays in team: [[1-projects/linkhub/open-topic]]\n",
    etag: "lh1",
  });
  for (const name of ["secret-topic", "circle-topic", "open-topic"]) {
    primary.set(`1-projects/linkhub/${name}.md`, { body: `BODY-${name}`, etag: `lt-${name}` });
  }

  check(
    "the hub and its three targets all start readable by a team connection",
    textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: "1-projects/linkhub/hub.md" })).includes("Hub") &&
      textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: "1-projects/linkhub/secret-topic.md" }))
        .includes("BODY-secret-topic"),
  );

  // Into `2-areas` (private), into `2-areas/circle` (@bulkvis-circle, by its
  // folder rule), and within `1-projects` (team) — one referrer, three fates.
  for (const [from, to] of [
    ["1-projects/linkhub/secret-topic.md", "2-areas/vault/secret-topic.md"],
    ["1-projects/linkhub/circle-topic.md", "2-areas/circle/circle-topic.md"],
    ["1-projects/linkhub/open-topic.md", "1-projects/open/open-topic.md"],
  ]) {
    const moved = await callTool(env, TOKEN_OWNER, "move_note", { source: from, destination: to });
    check(`${from} moves to ${to}`, !moved?.isError);
  }

  const hubAsTeam = textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: "1-projects/linkhub/hub.md" }));

  check(
    "a team reader is refused the moved note itself",
    textOf(await callTool(env, TOKEN_TEAM, "read_note", { path: "2-areas/vault/secret-topic.md" }))
      .includes("not found"),
  );
  check(
    "...and the referring note it CAN read does not name that private path",
    hubAsTeam.includes("# Hub") && !hubAsTeam.includes("2-areas/vault"),
  );
  check(
    "...nor the path of one moved into a group it is not in",
    hubAsTeam.includes("# Hub") && !hubAsTeam.includes("2-areas/circle/circle-topic"),
  );
  check(
    "POSITIVE CONTROL: a move within team visibility still rewrites the link",
    hubAsTeam.includes("1-projects/open/open-topic"),
  );
  restoreS3();
  restoreControlPlane();
}
