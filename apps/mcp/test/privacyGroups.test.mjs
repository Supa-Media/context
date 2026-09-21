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
  "  2-areas/feedback: @supa-owners\n  3-resources: team\n  3-resources/board: @supa-owners\n" +
  "  0-inbox: team\n  4-archive: team\n\n" +
  "note_overrides:\n  1-projects/rates.md: @supa-leads\n" +
  "  0-inbox/contacts/dan.md: @supa-leads\n" +
  "  1-projects/reserved.md: @supa-leads\n" +
  "  3-resources/board/Minutes.md: @supa-owners\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/** An in-memory bucket that honours the conditional writes the manifest needs. */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  /*
    Storage round trips, counted.

    A refusal that reads the same and costs a different number of trips to the
    bucket is still two different answers — the second one is just measured
    with a clock rather than read. Counting them makes that a deterministic
    check instead of a flaky timing one.
  */
  const ops = { get: 0, list: 0, put: 0, delete: 0 };
  /** Every key whose BYTES were fetched, as opposed to probed for. */
  const fetched = [];
  const trips = () => ops.get + ops.list + ops.put + ops.delete;
  return {
    objects,
    ops,
    trips,
    fetched,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    async get(key) {
      ops.get += 1;
      fetched.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      ops.put += 1;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key, options = {}) {
      ops.delete += 1;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      ops.list += 1;
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
    bucket.seed("0-inbox/contacts/dan.md", "CONTACTSECRET dan's page");

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

    /*
      AND THEY MUST COST THE SAME, NOT ONLY READ THE SAME.

      The check above closes the channel a caller READS. This one closes the
      channel a caller MEASURES. `read_note` used to refuse an invisible path
      from `canSee` alone, before touching the bucket, while a path the caller
      could have seen went to storage and missed first: 1 round trip against 4,
      byte-identical answers. The cheap refusal was the one where the manifest
      was holding something back.

      All four shapes are driven, because two of them are the ones that would
      put the leak back one level down if only the first pair were checked: a
      note that EXISTS but is hidden must cost what a note that was never
      written costs, or the bit on offer becomes existence instead of
      visibility.

      Counted rather than timed, so this is deterministic. The number is not
      the invariant; the equality is.
    */
    const tripsFor = async (path) => {
      const before = bucket.trips();
      await callTool(env, TEAM_TOKEN, "read_note", { path });
      return bucket.trips() - before;
    };
    const refusalCosts = {
      "held back by name, and exists": await tripsFor("1-projects/rates.md"),
      "inside a group folder, and exists": await tripsFor("2-areas/feedback/q3.md"),
      "never written, in a folder the caller can see": await tripsFor("1-projects/no-such-note.md"),
      "never written, in a folder it cannot": await tripsFor("2-areas/feedback/no-such.md"),
    };
    /*
      AND A REFUSAL NEVER FETCHES THE NOTE'S BYTES.

      The equality above is blind to HOW the work is done: swapping the
      metadata probe back for a real `get` keeps every count identical and
      measures nothing, which sabotage confirmed. It would also start pulling
      a private note's plaintext into the worker for somebody who may not read
      it — `S3Store.get` and `DropboxStore.get` both buffer the whole object
      before any caller asks for text, so on those backends an "unread" body is
      not a thing that exists.

      So the shape is asserted directly rather than inferred from the cost.
    */
    bucket.fetched.length = 0;
    await callTool(env, TEAM_TOKEN, "read_note", { path: "1-projects/rates.md" });
    check(
      "a refused read never fetches the note's bytes, only its metadata",
      !bucket.fetched.includes("1-projects/rates.md")
    );

    const costs = Object.values(refusalCosts);
    check(
      `every refusal costs the same number of storage trips `
        + `(${Object.entries(refusalCosts).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
      costs.every((cost) => cost === costs[0])
    );

    /*
      AND THE SECOND DOOR TO THE SAME FACT MUST COST WHAT THE FIRST DOES.

      `read_image` is not an image tool for this purpose. It takes a NOTE path,
      runs the same `canSee` on it, and refuses with the same three bytes — so
      it answers the same question `read_note` does, and closing one door while
      the other stands open closes nothing. A caller who cannot read
      `read_note`'s cost can read this one's.

      The four shapes are the four above, driven through the other tool. The
      image argument is well-formed on purpose: a malformed one is refused
      before any path is considered, which would make every count zero and the
      equality vacuous.

      Counted rather than timed, so this is deterministic. The number is not
      the invariant; the equality is.
    */
    const imageTripsFor = async (note) => {
      const before = bucket.trips();
      await callTool(env, TEAM_TOKEN, "read_image", { note, image: "photo.png" });
      return bucket.trips() - before;
    };
    const imageRefusalCosts = {
      "held back by name, and exists": await imageTripsFor("1-projects/rates.md"),
      "inside a group folder, and exists": await imageTripsFor("2-areas/feedback/q3.md"),
      "never written, in a folder the caller can see": await imageTripsFor("1-projects/no-such-note.md"),
      "never written, in a folder it cannot": await imageTripsFor("2-areas/feedback/no-such.md"),
    };
    const imageCosts = Object.values(imageRefusalCosts);
    check(
      `every read_image refusal costs the same number of storage trips `
        + `(${Object.entries(imageRefusalCosts).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
      imageCosts.every((cost) => cost === imageCosts[0])
    );

    /*
      And it never fetches the note's bytes to refuse, for `read_note`'s
      reason: equalising the COUNT with a real `get` would satisfy the check
      above while pulling a private note's plaintext into the worker on
      `S3Store` and `DropboxStore`, which both buffer the whole object.
    */
    bucket.fetched.length = 0;
    await callTool(env, TEAM_TOKEN, "read_image", {
      note: "1-projects/rates.md",
      image: "photo.png",
    });
    check(
      "a refused read_image never fetches the note's bytes, only its metadata",
      !bucket.fetched.includes("1-projects/rates.md")
    );

    /*
      AND EVERY OTHER DOOR THAT REFUSES ON `canSee`.

      `read_note` and `read_image` were found one at a time. That is the wrong
      way to find the third, so this is the list itself: every read tool whose
      refusal is `canSee` saying no, driven through the same two shapes.

      The pair is the whole leak and the rest is decoration:

        A. the caller may NOT see it, and it EXISTS  — the refusal the manifest
           is responsible for
        B. the caller MAY see the folder, and nothing is there — the refusal
           that is simply absence

      Byte-identical to read, both of them. If A is cheaper than B then A is
      distinguishable, and A is exactly "somebody deliberately made this
      private" — which the caller's own listing will never tell them.

      **Adding a tool to this table is the whole cost of covering it**, which is
      the point: a guarantee that lives in a list is only as good as the check
      on the list, and the list is now the check.

      `fetch` earns its row twice over. It is `read_note` wearing OpenAI's
      contract, and its own header says "a second path is a second place for a
      bug" — which is what it turned out to be.
    */
    const REFUSAL_DOORS = [
      { tool: "read_meeting", arg: "path", hidden: "1-projects/rates.md", absent: "1-projects/no-such-note.md" },
      { tool: "read_channel_day", arg: "path", hidden: "1-projects/rates.md", absent: "1-projects/no-such-note.md" },
      { tool: "read_contact", arg: "path", hidden: "0-inbox/contacts/dan.md", absent: "0-inbox/contacts/nobody.md" },
      { tool: "fetch", arg: "id", hidden: "1-projects/rates.md", absent: "1-projects/no-such-note.md" },
    ];
    for (const door of REFUSAL_DOORS) {
      const cost = async (path) => {
        const before = bucket.trips();
        const text = await callTool(env, TEAM_TOKEN, door.tool, { [door.arg]: path });
        return { trips: bucket.trips() - before, text };
      };
      const hidden = await cost(door.hidden);
      const absent = await cost(door.absent);
      // Non-vacuity: a door that refused both on shape before reaching `canSee`
      // would report an equal cost and prove nothing.
      check(
        `${door.tool}: both answers are the same refusal, so only the cost could tell them apart`,
        hidden.text === absent.text && /not found/.test(hidden.text)
      );
      check(
        `${door.tool}: refusing a note it may not see costs what refusing an absent one costs `
          + `(hidden: ${hidden.trips}, absent: ${absent.trips})`,
        hidden.trips === absent.trips
      );
      check(
        `${door.tool}: and refusing never fetches the note's bytes`,
        !bucket.fetched.includes(door.hidden)
      );
      bucket.fetched.length = 0;
    }

    /*
      AND THE WRITE REFUSAL, WHOSE OWN TEXT MAKES THE CLAIM.

      `writePermissionError` ends with "No private-path information is
      disclosed by this error", and the comment above `mustCreate` says the
      three team-scope checks "refuse with the same message whether or not
      anything is there — so a connection that may not write here still learns
      nothing."

      Both sentences are about the WORDS, and the words are identical. The
      three checks are not reached at the same point:

        1. an exact override that is not `team`  — decided from the manifest,
           BEFORE the note is looked up
        2. absent, and the folder is not team    — after the lookup
        3. present, and not team                 — after the lookup

      So the override case is a round trip cheaper, and an exact override is
      written only when somebody deliberately named THAT path in `privacy.md`
      — a file a team-tier caller cannot read. The cheap refusal says "this
      exact note was singled out", which is precisely the sentence the error
      claims not to disclose.
    */
    const writeCost = async (path) => {
      const before = bucket.trips();
      const text = await callTool(env, TEAM_TOKEN, "write_note", {
        path,
        content: "# probe\n",
      });
      return { trips: bucket.trips() - before, text };
    };
    const overridden = await writeCost("1-projects/rates.md");
    const inFolderPresent = await writeCost("2-areas/feedback/q3.md");
    const inFolderAbsent = await writeCost("2-areas/feedback/no-such.md");
    check(
      "every refused write says the same words, so only the cost could tell them apart",
      overridden.text === inFolderPresent.text &&
        overridden.text === inFolderAbsent.text &&
        /permission denied/.test(overridden.text)
    );
    check(
      `a write refused by an exact override costs what one refused by a folder rule costs `
        + `(override: ${overridden.trips}, folder+present: ${inFolderPresent.trips}, `
        + `folder+absent: ${inFolderAbsent.trips})`,
      overridden.trips === inFolderPresent.trips &&
        overridden.trips === inFolderAbsent.trips
    );

    /*
      AND THE WRITE TOOLS' *READ* REFUSAL, WHICH THE READ SWEEP SKIPPED FOR
      THE WRONG REASON.

      The sweep that equalised the read tools left `archive_note`, `move_note`
      and `set_encryption` out, on the grounds that a write tool's refusal is a
      write refusal and belongs to the separate finding about those. That
      classified them by the TOOL being a writer instead of by the REFUSAL
      being a read, and it is wrong: each one's *first* refusal is

          if (!canSee(path, ...)) return toolError("not found");

      — the same three bytes `read_note` says, decided before the bucket is
      touched, while a path the caller could have seen goes to storage and
      misses. `writePermissionError` is a different door further in, and the
      separate write-refusal finding is about that one.

      So these belong with the read doors after all, and they are driven here
      the same way: same words asserted first, then same cost.

      `set_encryption` is NOT here, and measuring it is why: a team connection
      is refused by "only a personal connection can encrypt or decrypt a note"
      before `canSee` is ever consulted, identically and at identical cost for
      both shapes. It never reaches this door, so there is nothing to equalise
      — the hypothesis died on contact and this line is the record of it.
    */
    const WRITE_DOORS = [
      { tool: "archive_note", args: (path) => ({ path }) },
      { tool: "move_note", args: (path) => ({ source: path, destination: "1-projects/moved.md" }) },
    ];
    for (const door of WRITE_DOORS) {
      const cost = async (path) => {
        const before = bucket.trips();
        const text = await callTool(env, TEAM_TOKEN, door.tool, door.args(path));
        return { trips: bucket.trips() - before, text };
      };
      const hidden = await cost("1-projects/rates.md");
      const absent = await cost("1-projects/no-such-note.md");
      check(
        `${door.tool}: both answers are the same refusal, so only the cost could tell them apart`,
        hidden.text === absent.text && /not found/.test(hidden.text)
      );
      check(
        `${door.tool}: refusing a note it may not see costs what refusing an absent one costs `
          + `(hidden: ${hidden.trips}, absent: ${absent.trips})`,
        hidden.trips === absent.trips
      );
    }

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
