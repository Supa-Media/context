/**
 * A privacy rule that names a group, and the four ways it could leak.
 *
 * `privacy.md` may now carry `@supa-owners` where it used to carry only
 * `private` or `team`. The engine-level proof that a group is narrower than
 * `team` lives in `apps/convex/__tests__/privacyEngine.test.ts`, which runs
 * this gateway's *actual* functions beside the control plane's port. What
 * cannot be proven there is what the **tools** do with such a rule, and that is
 * this file: every check below failed before the change that added it.
 *
 * The invariant under all of them: **nothing here can create a group rule.**
 * `set_visibility` still takes two words, `write_note` still takes two, and a
 * group reaches the manifest only from the console or a person's own editor.
 * So every tool has one job — preserve a group rule it meets, or refuse — and
 * never to guess what a group means.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/index.js` and reverted. The first pass
 * is recorded too, because two of these checks passed against the very bug
 * they were written for and the reason is worth keeping: a check that names an
 * invariant is not a check that reaches it.
 *
 * 1. **`canSee` returns true for any group at team scope** — 5 checks failed,
 *    including the team connection reading `2-areas/feedback/q3.md` outright
 *    and its terms surfacing in that connection's search.
 * 2. **The write guard restored to `=== "private"`** — 3 checks failed. First
 *    attempt: **0**. The check wrote to a path that already had a note, so the
 *    "existing note is not team" check refused it and the guard under test was
 *    never reached. It now writes to `1-projects/reserved.md`, which carries a
 *    rule and no object — the only arrangement where this guard is the thing
 *    standing in the way, and the arrangement the escalation used.
 * 3. **Folder compaction restored to `if (visibility === "private") continue`**
 *    — 1 check failed. First attempt: **0**, because the override it used had
 *    a value the new folder default did not equal, so the compaction loop
 *    never considered it either way. It now uses a group override sitting
 *    under a folder rule of the same group, which is the shape that actually
 *    looks redundant to that loop.
 * 4. **`futureTeamExposure` restored to `beforeDefault === "private"`** — 2
 *    checks failed: widening a group folder to team asked for no confirmation
 *    and reported `newly_team_visible_notes: 0` while publishing one.
 * 5. **Moves restored to "private if either side is private, else team"** — 2
 *    checks failed: a group-scoped note moved into a team folder came out
 *    `team`, and the team connection could then read it at its new path.
 *
 * A sixth was found by these checks rather than by sabotage: with the move
 * computing a group destination correctly, *neither* persistence branch fired
 * — both tested a literal — so the note landed on its new folder's default and
 * was published anyway. That is why the branches are `!== "team"` over the
 * computed value rather than `=== "private"` over a literal.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER_TOKEN = `cat_groups_owner_${"0".repeat(16)}`;
const TEAM_TOKEN = `cat_groups_team_${"0".repeat(17)}`;

/**
 * A team folder with one group-scoped subfolder and one group-scoped note.
 *
 * `1-projects` is team so that every refusal below is the group rule doing the
 * work rather than a private folder the caller could never reach anyway — the
 * non-vacuity the checks lean on.
 */
const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
  "  2-areas/feedback: @supa-owners\n  3-resources: team\n  3-resources/board: @supa-owners\n\n" +
  "note_overrides:\n  1-projects/rates.md: @supa-leads\n" +
  "  1-projects/reserved.md: @supa-leads\n" +
  "  3-resources/board/Minutes.md: @supa-owners\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/** An in-memory bucket that honours the conditional writes the manifest needs. */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

async function callTool(env, token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

export async function runPrivacyGroupChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    controlPlane.addWorkspace("ws_groups", "groups", {
      provider: "r2-binding",
      bindingName: "GROUPS_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_groups",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_groups_owner",
      userId: "user_groups_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_groups",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_groups_team",
      userId: "user_groups_team",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "GROUPS_BUCKET",
      GROUPS_BUCKET: bucket,
    };

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/roadmap.md", "the roadmap, for everyone here");
    bucket.seed("1-projects/rates.md", "RATESECRET what we charge");
    bucket.seed("2-areas/feedback/q3.md", "FEEDBACKSECRET the q3 review");

    /* -- (1) a group is not team, to a team connection --------------------- */

    // Non-vacuity: the same connection reads the team note beside it. Without
    // this every refusal below is satisfied by a manifest that failed to parse.
    const teamReadsTeam = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "1-projects/roadmap.md",
    });
    check(
      "a team connection reads a team note in the same folder",
      teamReadsTeam.includes("the roadmap")
    );

    const teamReadsGroupFolder = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "2-areas/feedback/q3.md",
    });
    check(
      "a team connection cannot read a note in a group-scoped folder",
      !teamReadsGroupFolder.includes("FEEDBACKSECRET") && /not found/i.test(teamReadsGroupFolder)
    );

    const teamReadsGroupNote = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "1-projects/rates.md",
    });
    check(
      "a team connection cannot read a note held back to a group by name",
      !teamReadsGroupNote.includes("RATESECRET") && /not found/i.test(teamReadsGroupNote)
    );

    // The refusal is the one a missing note gets, so the rule does not confirm
    // that the note exists — the idiom `canSee` already follows everywhere.
    const teamReadsAbsent = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "1-projects/no-such-note.md",
    });
    check(
      "the refusal is byte-identical to the one a note that does not exist gets",
      teamReadsGroupNote === teamReadsAbsent
    );

    const teamSearch = await callTool(env, TEAM_TOKEN, "search_notes", { query: "FEEDBACKSECRET" });
    check(
      "a group-scoped note's terms do not reach a team connection's search",
      !teamSearch.includes("FEEDBACKSECRET") && !teamSearch.includes("2-areas/feedback/q3.md")
    );

    const ownerReadsGroupNote = await callTool(env, OWNER_TOKEN, "read_note", {
      path: "2-areas/feedback/q3.md",
    });
    check(
      "the owner's own connection still reads it",
      ownerReadsGroupNote.includes("FEEDBACKSECRET")
    );

    /* -- (2) the escalation: writing a note reserved for a group ------------ */

    // `1-projects` is `team`, so the FOLDER check waves this through; the note
    // does not exist, so the "existing note" check never runs. The only thing
    // standing between a team connection and the owner's group rule is the
    // override guard, and while it tested `=== "private"` there was nothing
    // there at all.
    // `1-projects/reserved.md` has a rule and NO object. That matters: with a
    // note present, the "existing note is not team" check further down refuses
    // anyway and this guard is never the thing that saves it — which made the
    // first version of this check pass against the bug it was written for.
    const escalation = await callTool(env, TEAM_TOKEN, "write_note", {
      path: "1-projects/reserved.md",
      content: "# created by a team connection",
    });
    check(
      "a team connection cannot write a note the owner reserved for a group",
      /permission denied/i.test(escalation)
    );
    check(
      "...and the owner's group rule is still in the manifest afterwards",
      bucket.text("privacy.md").includes("1-projects/reserved.md: @supa-leads")
    );
    check(
      "...and no note was created at the reserved path",
      bucket.text("1-projects/reserved.md") === undefined
    );
    // The same connection CAN create a note elsewhere in the same team folder,
    // so the refusal above is the reserved path and not a write it could never
    // have made.
    const allowed = await callTool(env, TEAM_TOKEN, "write_note", {
      path: "1-projects/notes.md",
      content: "# an ordinary team note",
    });
    check("...while an ordinary write in the same team folder still succeeds", /written/i.test(allowed));

    /* -- (3) no tool can mint a group rule --------------------------------- */

    const mint = await callTool(env, OWNER_TOKEN, "set_visibility", {
      path: "1-projects/roadmap.md",
      visibility: "@supa-leads",
    });
    // Refused by the argument schema, before the tool body runs at all — which
    // is a stronger guarantee than a check inside it, and the reason this
    // asserts the enum's own wording rather than a message a tool composes.
    check(
      "even an owner's AI client cannot set a group through set_visibility",
      /must be one of: private, team/.test(mint)
    );
    check(
      "...and the manifest gained no rule from the attempt",
      !bucket.text("privacy.md").includes("1-projects/roadmap.md")
    );

    /* -- (4) a folder change may not quietly drop or publish a group -------- */

    // `3-resources/board/Minutes.md: @supa-owners` sits under
    // `3-resources/board`, itself `@supa-owners`, so it *looks* redundant:
    // its value equals
    // what the longest-prefix rule already gives it. The compaction loop
    // therefore reaches it, and while that loop skipped only `private` it
    // deleted it. A narrowing override is never redundant — it is also the only
    // thing narrowing every path that folds onto it, and this loop cannot see
    // who those are — which is the reasoning the `private` case was already
    // written with, applied to a group.
    const dryRun = await callTool(env, OWNER_TOKEN, "set_folder_visibility", {
      path: "3-resources",
      visibility: "team",
      dry_run: true,
    });
    check(
      "a group override that looks redundant is still never compacted away",
      /redundant_note_overrides_to_remove: 0/.test(dryRun)
    );

    const widen = await callTool(env, OWNER_TOKEN, "set_folder_visibility", {
      path: "2-areas/feedback",
      visibility: "team",
      dry_run: true,
    });
    check(
      "widening a group folder to team counts the notes it would publish",
      /newly_team_visible_notes: 1/.test(widen)
    );
    check(
      "...and asks for the same confirmation publishing a private folder asks for",
      /team_publication_confirmation_required: true/.test(widen)
    );

    /* -- (5) a move carries the narrower of the two, never the wider -------- */

    const move = await callTool(env, OWNER_TOKEN, "move_note", {
      source: "2-areas/feedback/q3.md",
      destination: "1-projects/q3.md",
    });
    check("the owner's move succeeded", /moved/i.test(move) && !/error/i.test(move));
    check(
      "a group-scoped note moved into a team folder keeps its group",
      bucket.text("privacy.md").includes("1-projects/q3.md: @supa-owners")
    );
    const teamReadsMoved = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "1-projects/q3.md",
    });
    check(
      "...so the team connection still cannot read it at its new path",
      !teamReadsMoved.includes("FEEDBACKSECRET")
    );
  } finally {
    restore?.();
  }
}
