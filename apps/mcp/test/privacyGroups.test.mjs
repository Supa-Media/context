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
import { FTS_TABLE, upsertStatements } from "../src/search/d1/project.js";

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

async function meetingRequest(env, token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
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

    /* -- (3b) publishing a group note is a publication ---------------------- */

    // `write_note` decided "is this a publication?" with
    // `existingVisibility === "private"`. A note held back to a group is not
    // that string, so `@supa-leads` -> `team` was treated as an ordinary write
    // and asked for nothing — while `set_visibility` gated the same transition
    // unconditionally. Two tools disagreeing about one publication, and the
    // ungated one is the default an agent reaches.
    const unconfirmed = await callTool(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/rates.md",
      content: "# rates\n\nRATESECRET what we charge",
      visibility: "team",
    });
    check(
      "publishing a group-held note to team requires the same confirmation a private one does",
      /confirmation required/i.test(unconfirmed)
    );
    check(
      "...and the group rule is untouched while it is refused",
      bucket.text("privacy.md").includes("1-projects/rates.md: @supa-leads")
    );
    // The positive control: the confirmation is a real gate, not a refusal.
    const confirmed = await callTool(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/rates.md",
      content: "# rates\n\nRATESECRET what we charge",
      visibility: "team",
      confirm_team_publish: true,
    });
    check("...and it goes through once the owner confirms", /written/i.test(confirmed));

    /* -- (3c) a group name is not a team connection's to learn --------------- */

    // Names live in one global namespace with usernames, so `@kola` on a folder
    // would tell a team connection that a named individual has access to
    // something it cannot read — the oracle this branch already refuses to be
    // about note existence.
    const probe = await callTool(env, TEAM_TOKEN, "scope_info", { path: "2-areas/feedback" });
    check(
      "scope_info never hands a group's name to a team connection",
      !probe.includes("@supa-owners") && /folder default: not team/.test(probe)
    );
    const ownerProbe = await callTool(env, OWNER_TOKEN, "scope_info", { path: "2-areas/feedback" });
    check(
      "...while the owner is told exactly which group it is",
      ownerProbe.includes("@supa-owners")
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

    // `publicationConfirmationRequired` is `futureTeamExposure || newlyTeamVisible.length`,
    // and the check above rides entirely on the right-hand side: `2-areas/feedback`
    // has a note in it, so reverting `futureTeamExposure` alone failed NOTHING.
    // `3-resources/board` is a group folder with no objects under it, which is
    // the only arrangement where the left-hand side is load-bearing — the
    // folder's own DEFAULT would start governing whatever lands there next,
    // and that is a publication with no note to count yet.
    const widenEmpty = await callTool(env, OWNER_TOKEN, "set_folder_visibility", {
      path: "3-resources/board",
      visibility: "team",
      dry_run: true,
    });
    check(
      "widening an empty group folder still asks for confirmation, with nothing to count",
      /newly_team_visible_notes: 0/.test(widenEmpty) &&
        /team_publication_confirmation_required: true/.test(widenEmpty)
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
    /* -- (5b) the projection puts a group note where no team caller reads --- */

    // Pure, so it runs here rather than needing a D1. Two things are asserted
    // because the bug was two bugs: the note must reach `upsertStatements` at
    // all (the backfill used to `skip` it, which returns BEFORE the deletes and
    // strands its old team-tier rows forever, and never counts it as indexed so
    // the workspace sits at "Preparing" for good), and its chunks must land in
    // the PRIVATE table — a private-tier caller reads both, a team-tier caller
    // reads only the team one, which is the split's whole purpose.
    const projected = upsertStatements("2-areas/feedback/q3.md", {
      note: {
        path: "2-areas/feedback/q3.md",
        version: "e1",
        visibility: "@supa-owners",
        title: "q3",
        uploaded: 0,
        chunks: 1,
        indexed_at: 0,
      },
      chunks: [{ path: "2-areas/feedback/q3.md", ord: 0, title: "q3", headings: "", tags: "", body: "FEEDBACKSECRET" }],
    });
    const sql = projected.map((statement) => statement.sql).join("\n");
    check(
      "a group note's old team-tier rows are deleted like any other note's",
      sql.includes(`DELETE FROM ${FTS_TABLE.team}`) && sql.includes(`DELETE FROM ${FTS_TABLE.private}`)
    );
    check(
      "...and its body is indexed in the private table, never the team one",
      sql.includes(`INSERT INTO ${FTS_TABLE.private}`) && !sql.includes(`INSERT INTO ${FTS_TABLE.team}`)
    );
    // The control: a team note still goes in the team table, so the assertion
    // above is the group's routing and not a function that never inserts.
    const teamProjected = upsertStatements("1-projects/roadmap.md", {
      note: { path: "1-projects/roadmap.md", version: "e2", visibility: "team", title: "r", uploaded: 0, chunks: 1, indexed_at: 0 },
      chunks: [{ path: "1-projects/roadmap.md", ord: 0, title: "r", headings: "", tags: "", body: "roadmap" }],
    });
    check(
      "...while a team note is still indexed in the team table",
      teamProjected.map((statement) => statement.sql).join("\n").includes(`INSERT INTO ${FTS_TABLE.team}`)
    );

    /* -- (6) the same escalation through the meetings surface --------------- */

    // `write_note` is not the only writer with a destination guard, and fixing
    // one is how the other survives. `publishMeetingNote` had the identical
    // `=== "private"` test, reachable with a CLIENT-SUPPLIED `notePath`: a
    // team-tier meetings connection names the note the owner reserved for a
    // group, finalizes, and the body is overwritten while
    // `persistExactVisibility` deletes the group rule and publishes the path.
    const SESSION = `mtg_${"g".repeat(20)}`;
    const opened = await meetingRequest(env, TEAM_TOKEN, "/meetings/sessions", {
      id: SESSION,
      title: "Rates",
      notePath: "1-projects/reserved.md",
      startedAt: "2026-09-02T10:00:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-02T10:00:00.000Z" }],
    });
    check("a team connection may open a meeting session", opened.status === 200);

    const finalized = await meetingRequest(
      env,
      TEAM_TOKEN,
      `/meetings/sessions/${SESSION}/finalize`,
      { endedAt: "2026-09-02T10:30:00.000Z" }
    );
    check(
      "a team connection cannot file a meeting over a note reserved for a group",
      finalized.status === 403
    );
    check(
      "...and the owner's group rule survives the attempt",
      bucket.text("privacy.md").includes("1-projects/reserved.md: @supa-leads")
    );
    check(
      "...and nothing was written at the reserved path",
      bucket.text("1-projects/reserved.md") === undefined
    );
  } finally {
    restore?.();
  }
}
