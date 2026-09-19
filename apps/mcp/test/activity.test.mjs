/**
 * `activity.md` — the feed, as a file.
 *
 * Two halves, for the two things that can be wrong with it.
 *
 * The **pure** half is the format and the filter: what becomes a line, what
 * never does, what merges into a line that is already there, and whether a
 * file written by one version can be read back by the next. That last one is
 * the property a rendering layer over a stored document lives or dies by, so
 * the round trip is asserted on every shape an entry can take — including the
 * two that can close an HTML comment early and take the rest of the history
 * with them.
 *
 * The **wired** half stands up a worker over its own bucket and proves the
 * three claims that are not about formatting at all:
 *
 *  1. Writing a note through the gateway leaves a line in `activity.md`.
 *  2. That file is stored **private**, whatever the folder it sits in says,
 *     because it names paths across the whole context.
 *  3. A team-tier caller reading it through `read_activity` sees the team
 *     lines and nothing else — not a placeholder, not a count, not a gap.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across this
 * suite.
 *
 *   `entryFor` returning an entry for every action                          9
 *   `MIN_REVISION_BYTES` set to 0                                           3
 *   the `isQuietPath` guard dropped from `entryFor`                         4
 *   `applyEntry` always unshifting (never merging)                          6
 *   the `REFRESH_MS` early return removed                                   1
 *   `encodeEntry`'s hyphen escape removed                                   2
 *   `visibleEntries` trusting `vis` without `canSee`                        2
 *   `visibleEntries` trusting `canSee` without `vis`                        1
 *   the private ACL dropped from the gateway's activity write               1
 *   `read_activity` serving the owner's view to a team caller               3
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  ACTIVITY_PATH,
  MAX_ENTRIES,
  MIN_REVISION_BYTES,
  REFRESH_MS,
  applyEntry,
  describeEntry,
  entryFor,
  mayBeReportable,
  nextFile,
  parseFile,
  renderFile,
  unseenCount,
  unseenPaths,
  visibleEntries,
} from "../../../packages/shared/src/activity.cjs";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub.mjs";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const claude = { name: "@sayo", client: "Claude" };
const seyi = { name: "@seyi", client: null };

function change(action, paths, details = {}, actor = claude, at = iso(0)) {
  return { action, paths, details, actor, at };
}

export async function runActivityChecks(check) {
  /* ----------------------------- substance ----------------------------- */

  check(
    "a created note is a line",
    entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true }))
      ?.kind === "added",
  );

  /*
    The cheap half, asked before anything is read. It has to agree with
    `entryFor` on the two things it can see — otherwise the optimisation is a
    filter, and a filter nobody tested is a way to lose changes silently.
  */
  check(
    "the pre-check refuses what entryFor refuses, without reading anything",
    !mayBeReportable("read_note", ["1-projects/alpha.md"]) &&
      !mayBeReportable("create_note", [".context/audit/x.json"]) &&
      !mayBeReportable("create_note", []) &&
      !mayBeReportable("propose_note", ["1-projects/alpha.md"]) &&
      mayBeReportable("create_note", ["1-projects/alpha.md"]),
  );
  check(
    "and it is looser rather than stricter: a trivial edit still gets looked at",
    mayBeReportable("update_note", ["1-projects/alpha.md"]) &&
      entryFor(
        change("update_note", ["1-projects/alpha.md"], {
          team_visible: true,
          previous_bytes: 100,
          content_bytes: 101,
        }),
      ) === null,
  );

  check(
    "a read is not an action this module has ever heard of",
    entryFor(change("read_note", ["1-projects/alpha.md"])) === null,
  );

  for (const quiet of [
    "propose_note",
    "reject_proposal",
    "materialize_move",
    "inbox_capture",
    "inbox_update",
    "calendar_sync",
    "rotate_encryption_keys",
    "export_encryption_keys",
    "encrypt_note",
    "file.delete",
    "folder.create",
    "vault.import",
  ]) {
    check(
      `${quiet} never becomes a line`,
      entryFor(change(quiet, ["1-projects/alpha.md"], { team_visible: true })) === null,
    );
  }

  check(
    "a revision under the threshold is not a line",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 + MIN_REVISION_BYTES - 1,
      }),
    ) === null,
  );

  check(
    "a revision at the threshold is a line",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 + MIN_REVISION_BYTES,
      }),
    )?.kind === "revised",
  );

  check(
    "a deletion of the same size counts, because a cut is a change",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 - MIN_REVISION_BYTES,
      }),
    )?.kind === "revised",
  );

  check(
    "a revision whose sizes are unknown is kept rather than silently dropped",
    entryFor(change("update_note", ["1-projects/alpha.md"], { team_visible: true }))
      ?.kind === "revised",
  );

  check(
    "a form response is a submission, not a line",
    entryFor(
      change("create_note", ["1-projects/poll.responses.md"], {
        team_visible: true,
        form_id: "f1",
      }),
    ) === null,
  );

  check(
    "the activity file's own writes cannot become lines",
    entryFor(change("update_note", [ACTIVITY_PATH], { team_visible: true })) === null,
  );

  check(
    "plumbing under a dot segment is never a line",
    entryFor(change("create_note", [".context/audit/x.json"], { team_visible: true })) ===
      null,
  );

  check(
    "a move is refused when either end is plumbing, not just the first",
    entryFor(
      change("move_note", ["1-projects/alpha.md", ".context/x.md"], { team_visible: true }),
    ) === null,
  );

  check(
    "taking a note back into private is never a line",
    entryFor(
      change("set_visibility", ["1-projects/alpha.md"], { from: "team", to: "private" }),
    ) === null,
  );

  check(
    "giving a note to the team is a line",
    entryFor(
      change("set_visibility", ["1-projects/alpha.md"], {
        from: "private",
        to: "team",
        team_visible: true,
      }),
    )?.kind === "published",
  );

  /* ------------------------------ shaping ------------------------------ */

  const folderMove = entryFor(
    change("move_folder", ["1-projects/triage", "1-projects/backlog/triage"], {
      count: 6,
      team_visible: true,
    }),
  );
  check("a folder move carries its object count", folderMove?.n === 6);
  check(
    "a folder move reads as one sentence about many notes",
    describeEntry(folderMove).includes("6 notes"),
  );

  const bulk = entryFor(
    change(
      "move_notes",
      ["a/one.md", "b/one.md", "a/two.md", "b/two.md"],
      { count: 2, team_visible: true },
    ),
  );
  check(
    "a bulk move keeps the destinations rather than the sources",
    bulk?.paths.join(",") === "b/one.md,b/two.md",
  );

  check(
    "a change with no team flag is recorded as private rather than assumed public",
    entryFor(change("create_note", ["1-projects/alpha.md"], {}))?.vis === "private",
  );

  check(
    "an agent's own sentence rides along when it sent one",
    entryFor(
      change("create_note", ["1-projects/alpha.md"], {
        team_visible: true,
        summary: "  screenshots of   the editor bugs\n",
      }),
    )?.note === "screenshots of the editor bugs",
  );

  check(
    "a person and their client read as a possessive",
    describeEntry(
      entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true })),
    ).startsWith("@sayo's Claude added"),
  );

  check(
    "a person acting in the console is just their name",
    describeEntry(
      entryFor(
        change("file.create", ["1-projects/alpha.md"], { team_visible: true }, seyi),
      ),
    ).startsWith("@seyi added"),
  );

  check(
    "a meeting landing names no actor, because nobody wrote it",
    describeEntry(
      entryFor(
        change("meeting_note", ["0-inbox/meetings/steering.md"], { team_visible: true }, {
          name: null,
          client: null,
        }),
      ),
    ).startsWith("A meeting landed"),
  );

  /* ------------------------------ grouping ----------------------------- */

  const three = ["one", "two", "three"].reduce(
    (entries, name, index) =>
      applyEntry(
        entries,
        entryFor(
          change(
            "create_note",
            [`1-projects/fixes/${name}.md`],
            { team_visible: true },
            claude,
            iso(index * 60_000),
          ),
        ),
      ) || entries,
    [],
  );
  check("three notes in one folder by one hand are one line", three.length === 1);
  check("and the line counts them", three[0].n === 3);

  const twoHands = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/four.md"],
        { team_visible: true },
        seyi,
        iso(4 * 60_000),
      ),
    ),
  );
  check("a second person never merges into the first", twoHands.length === 2);

  const twoClients = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/five.md"],
        { team_visible: true },
        { name: "@sayo", client: "ChatGPT" },
        iso(5 * 60_000),
      ),
    ),
  );
  check(
    "one person's two clients are two hands",
    twoClients.length === 2,
  );

  const later = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/six.md"],
        { team_visible: true },
        claude,
        iso(90 * 60_000),
      ),
    ),
  );
  check("work an hour and a half later is its own line", later.length === 2);

  const justCreated = [
    entryFor(change("create_note", ["1-projects/fixes/one.md"], { team_visible: true })),
  ];
  check(
    "typing into a note you just made writes nothing at all",
    applyEntry(
      justCreated,
      entryFor(
        change(
          "update_note",
          ["1-projects/fixes/one.md"],
          { team_visible: true },
          claude,
          iso(30_000),
        ),
      ),
    ) === null,
  );
  const editedLater = applyEntry(
    justCreated,
    entryFor(
      change(
        "update_note",
        ["1-projects/fixes/one.md"],
        { team_visible: true },
        claude,
        iso(REFRESH_MS + 60_000),
      ),
    ),
  );
  check(
    "and editing it an hour later is still the line that says you made it",
    editedLater.length === 1 && editedLater[0].kind === "added",
  );

  const createdAfterEditing = applyEntry(
    [entryFor(change("update_note", ["1-projects/fixes/two.md"], { team_visible: true }))],
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/two.md"],
        { team_visible: true },
        claude,
        iso(30_000),
      ),
    ),
  );
  check(
    "but a creation after a revision is a different note, and a second line",
    createdAfterEditing.length === 2,
  );

  const mixedKinds = applyEntry(
    three,
    entryFor(
      change(
        "move_note",
        ["1-projects/fixes/one.md", "1-projects/fixes/one-renamed.md"],
        { team_visible: true },
        claude,
        iso(2 * 60_000),
      ),
    ),
  );
  check("a move never merges into a run of creates", mixedKinds.length === 2);

  const publishedPrivate = applyEntry(
    [
      entryFor(
        change("create_note", ["1-projects/fixes/a.md"], { team_visible: true }),
      ),
    ],
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/b.md"],
        {},
        claude,
        iso(60_000),
      ),
    ),
  );
  check(
    "a group holding one private member is private, not team",
    publishedPrivate[0].vis === "private",
  );

  /* --------------------------- the cheap path -------------------------- */

  const firstSave = nextFile(
    "",
    change("update_note", ["3-teams/week-one.md"], { team_visible: true }),
  );
  check("the first save of a session writes a file", Boolean(firstSave));

  const resave = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true },
      claude,
      iso(REFRESH_MS - 1000),
    ),
  );
  check(
    "a re-save inside the refresh window writes nothing at all",
    resave === null,
  );

  const staleResave = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true },
      claude,
      iso(REFRESH_MS + 1000),
    ),
  );
  check(
    "a re-save past the refresh window moves the line's clock",
    staleResave !== null && parseFile(staleResave.text)[0].at === iso(REFRESH_MS + 1000),
  );
  check(
    "and does not add a second line for the same note",
    staleResave !== null && parseFile(staleResave.text).length === 1,
  );

  // Past the refresh window, so the only thing that can stop this write is the
  // substance test itself. Inside it, a re-save writes nothing for a reason
  // that has nothing to do with how much changed.
  const unsubstantial = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true, previous_bytes: 100, content_bytes: 101 },
      claude,
      iso(REFRESH_MS + 60_000),
    ),
  );
  check("an unsubstantial change writes nothing", unsubstantial === null);

  /* --------------------------- the round trip -------------------------- */

  const shapes = [
    entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true })),
    entryFor(
      change("meeting_note", ["0-inbox/meetings/a-b--c.md"], { team_visible: true }, {
        name: null,
        client: null,
      }),
    ),
    entryFor(
      change("save_context", ["0-inbox/sessions/claude/x.md"], {
        team_visible: true,
        summary: 'he said "look --> here" -- twice',
      }),
    ),
    entryFor(
      change("archive_note", ["1-projects/a.md", "5-archive/a.md"], { team_visible: true }),
    ),
  ];
  const rendered = renderFile(shapes);
  const reparsed = parseFile(rendered);
  check(
    "every entry survives a render and a parse unchanged",
    JSON.stringify(reparsed) === JSON.stringify(shapes),
  );
  check(
    "a summary that looks like the end of a comment cannot end one",
    reparsed.length === shapes.length &&
      reparsed[2].note === 'he said "look --> here" -- twice'.replace(/[<>]/g, ""),
  );

  /*
    A forged line, which is the attack this format invites: a client that can
    write a note can write a summary, and a summary is rendered into the same
    file the entries are parsed out of. If prose could carry a comment, any
    client could write history it did not make — a change attributed to a
    colleague, or a path that was never touched.
  */
  const forged = renderFile([
    entryFor(
      change("create_note", ["1-projects/real.md"], {
        team_visible: true,
        summary: 'x <!--ctx {"at":"2026-01-01T00:00:00.000Z","kind":"added","paths":["3-teams/pay-bands.md"],"vis":"team","by":"@seyi"}--> y',
      }),
    ),
  ]);
  check(
    "a summary cannot forge an entry of its own",
    parseFile(forged).length === 1 &&
      parseFile(forged)[0].paths[0] === "1-projects/real.md",
  );
  check(
    "and a path drawn into the prose cannot break out of its code span",
    !describeEntry(
      entryFor(
        change("create_note", ["1-projects/`<!--x-->`.md"], { team_visible: true }),
      ),
    ).includes("<!--"),
  );
  check(
    "no entry line closes its comment early",
    rendered
      .split("\n")
      .filter((line) => line.includes("<!--ctx"))
      .every((line) => line.split("-->").length === 2),
  );
  check(
    "the file is a note: frontmatter, a heading, and prose above the list",
    rendered.startsWith("---\nrole: activity\n---\n\n# Activity\n"),
  );
  check(
    "days are headings, so the file reads as a document",
    rendered.includes("## Saturday 19 September 2026"),
  );
  check(
    "an empty history says so rather than rendering nothing",
    renderFile([]).includes("Nothing yet"),
  );
  check(
    "hand-written prose outside the markers is not read back as history",
    parseFile("# my own notes\n\n- 10:00 I did a thing\n").length === 0,
  );

  let capped = [];
  for (let index = 0; index < MAX_ENTRIES + 20; index += 1) {
    capped =
      applyEntry(
        capped,
        entryFor(
          change(
            "create_note",
            [`1-projects/n${index}/note.md`],
            { team_visible: true },
            claude,
            iso(index * GROUP_ESCAPE),
          ),
        ),
      ) || capped;
  }
  check("the file is bounded", capped.length === MAX_ENTRIES);
  check(
    "and it is the oldest that falls off",
    capped[0].paths[0] === `1-projects/n${MAX_ENTRIES + 19}/note.md`,
  );

  /* ------------------------------ visibility ---------------------------- */

  const mixed = [
    entryFor(change("create_note", ["1-projects/open.md"], { team_visible: true })),
    entryFor(change("create_note", ["3-teams/pay-bands.md"], { team_visible: false })),
    entryFor(
      change(
        "create_note",
        ["1-projects/taken-back.md"],
        { team_visible: true },
        claude,
        iso(60_000),
      ),
    ),
  ];
  const seesEverythingButOne = (path) => path !== "1-projects/taken-back.md";

  check(
    "the owner sees their own record whole",
    visibleEntries(mixed, { owner: true }).length === 3,
  );
  check(
    "a private change is absent for a member, not greyed out",
    visibleEntries(mixed, { owner: false, canSee: () => true }).length === 2,
  );
  check(
    "a note taken back into private drops out of lines written while it was shared",
    visibleEntries(mixed, { owner: false, canSee: seesEverythingButOne })
      .length === 1,
  );
  check(
    "a member with no privacy engine to ask is shown nothing",
    visibleEntries(mixed, { owner: false }).length === 0,
  );

  /* -------------------------------- unread ------------------------------ */

  check(
    "a first visit has everything unread",
    unseenCount(mixed, 0) === 3,
  );
  check(
    "and a return visit counts only what came after it",
    unseenCount(mixed, T0 + 30_000) === 1,
  );
  check(
    "the tree is told which notes are new",
    unseenPaths(mixed, T0 + 30_000).has("1-projects/taken-back.md") &&
      !unseenPaths(mixed, T0 + 30_000).has("1-projects/open.md"),
  );

  await runWiredChecks(check);
}

/** Far enough apart that nothing merges: one entry per iteration. */
const GROUP_ESCAPE = 60 * 60 * 1000;

/* --------------------------------- wired --------------------------------- */

/**
 * The gateway writing the file, and the two tiers reading it.
 *
 * Its own bucket and its own control plane, for the reason `links.test.mjs`
 * gives: `test.mjs`'s fixture is a privacy fixture and this one writes to the
 * root of the bucket on every call.
 */
async function runWiredChecks(check) {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  const bucket = {
    async get(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return {
        etag,
        size: bytes.length,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    /*
      Honours `onlyIf`, unlike the flat stub the rest of the suite uses. The
      activity write is a read-modify-write against a file every other write
      also touches, so its conditional put is the whole of its concurrency
      story: a stub that ignored the precondition would make the retry path
      untestable and would pass whether or not it existed.
    */
    async put(key, value, options = {}) {
      const current = objects.get(key);
      const wanted = options.onlyIf;
      if (wanted?.etagMatches && current?.etag !== wanted.etagMatches) return null;
      if (wanted?.absent && current) return null;
      const bytes =
        typeof value === "string"
          ? encoder.encode(value)
          : value instanceof Uint8Array
            ? new Uint8Array(value)
            : new Uint8Array(value);
      const etag = `e${++etagCounter}`;
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix } = {}) {
      const listed = [...objects.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({
          key,
          size: objects.get(key).bytes.length,
          uploaded: new Date(),
          etag: objects.get(key).etag,
        }));
      return { objects: listed, truncated: false };
    },
  };

  const store = new R2Store(bucket);
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_activity", "activity", {
    provider: "r2-binding",
    bindingName: "CONTEXT_BUCKET",
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
    },
    status: "active",
  });
  const OWNER = "cat_test_activity_owner_000000000000";
  const TEAM = "cat_test_activity_team_0000000000000";
  await controlPlane.addGrant({
    accessToken: OWNER,
    workspaceId: "ws_activity",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_activity_owner",
    clientName: "Claude Code",
    userId: "user_activity_owner",
  });
  await controlPlane.addGrant({
    accessToken: TEAM,
    workspaceId: "ws_activity",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_activity_team",
    clientName: "ChatGPT",
    userId: "user_activity_team",
  });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "CONTEXT_BUCKET",
    CONTEXT_BUCKET: bucket,
  };

  let id = 0;
  async function call(token, name, args = {}) {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
      { waitUntil() {} },
    );
    return (await res.json()).result;
  }
  const textOf = (result) => result?.content?.[0]?.text ?? "";
  const read = (key) => {
    const entry = objects.get(key);
    return entry ? new TextDecoder().decode(entry.bytes) : undefined;
  };

  await store.put(
    "privacy.md",
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n" +
      "```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  1-projects: team\n" +
      "  3-teams: private\n\nnote_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n",
  );
  await store.put("index.md", "# manifest\n");

  const written = await call(OWNER, "write_note", {
    path: "1-projects/alpha.md",
    content: `# Alpha\n\n${"a".repeat(400)}\n`,
    visibility: "team",
    confirm_team_publish: true,
    summary: "opened the alpha project",
  });
  check("a note write still succeeds", !written?.isError);

  const file = read(ACTIVITY_PATH);
  check("writing a note leaves a line in activity.md", Boolean(file));
  const entries = parseFile(file || "");
  check("and the line names the note", entries[0]?.paths[0] === "1-projects/alpha.md");
  check(
    "and names the person and the client they used",
    entries[0]?.by === "@activity" && entries[0]?.via === "Claude Code",
  );
  check(
    "and carries the sentence the client sent with the write",
    entries[0]?.note === "opened the alpha project",
  );

  await call(OWNER, "write_note", {
    path: "3-teams/pay-bands.md",
    content: `# Pay bands\n\n${"b".repeat(400)}\n`,
  });
  const afterPrivate = parseFile(read(ACTIVITY_PATH) || "");
  check(
    "a private note's change is recorded as private",
    afterPrivate[0]?.paths[0] === "3-teams/pay-bands.md" &&
      afterPrivate[0]?.vis === "private",
  );

  check(
    "the file itself is refused to a team-tier reader",
    Boolean((await call(TEAM, "read_note", { path: ACTIVITY_PATH }))?.isError),
  );

  const teamView = textOf(await call(TEAM, "read_activity", {}));
  check(
    "a team reader sees the team line through the viewing layer",
    teamView.includes("1-projects/alpha.md"),
  );
  check(
    "and never sees the private one, nor a count of what is missing",
    !teamView.includes("pay-bands") && !/\d+ (hidden|private)/.test(teamView),
  );

  const ownerView = textOf(await call(OWNER, "read_activity", {}));
  check(
    "the owner sees both",
    ownerView.includes("1-projects/alpha.md") && ownerView.includes("pay-bands"),
  );

  check(
    "the activity file never becomes an entry about itself",
    parseFile(read(ACTIVITY_PATH) || "").every(
      (entry) => !entry.paths.includes(ACTIVITY_PATH),
    ),
  );

  /*
    A LINE FOLLOWS ITS NOTE.

    The row written before a move has to point at where the note is now, or
    every tidy-up silently breaks the list. `#735`'s forwarding ledger is what
    makes that answerable, and this is the check that the feed asks it.
  */
  await call(OWNER, "move_note", {
    source: "1-projects/alpha.md",
    destination: "1-projects/alpha-renamed.md",
  });
  const afterMove = textOf(await call(OWNER, "read_activity", {}));
  check(
    "a line written before a move points at where the note is now",
    afterMove.includes("1-projects/alpha-renamed.md") &&
      !afterMove.includes("added `1-projects/alpha.md`"),
  );

  const listed = textOf(await call(TEAM, "list_notes", { prefix: "" }));
  check(
    "and it is not offered as a note to a team reader",
    !listed.includes(ACTIVITY_PATH),
  );

  restore();
}
