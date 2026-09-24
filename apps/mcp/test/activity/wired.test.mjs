/**
 * The gateway writing the file, and the two tiers reading it. See
 * activity.test.mjs for the module overview and the sabotage-testing record.
 *
 * Its own bucket and its own control plane, for the reason `links.test.mjs`
 * gives: `test.mjs`'s fixture is a privacy fixture and this one writes to the
 * root of the bucket on every call.
 */

import {
  ACTIVITY_PATH,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  R2Store,
  createControlPlaneStub,
  parseFile,
  worker,
} from "./fixtures.mjs";

export async function runActivityWiredChecks(check) {
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
      "  2-areas: team\n  3-resources: team\n" +
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

  /*
    THE LIVE RE-DERIVATION, THROUGH THE REAL ENGINE, FOR THE THREE AUDIENCES
    NON-NEGOTIABLE #5 NAMES.

    `visibleEntries` fails closed twice over — the flag recorded when the
    change happened, AND `canSee` re-derived through the live `privacy.md`
    now. Everything above exercises the FIRST half: `pay-bands` is hidden
    because its line was stored `vis: private`, which is decided at write time
    and never re-asked.

    Measured: dropping the live half entirely reddened **1** check across the
    whole gateway suite, and that one is the pure-module check above, which
    passes `canSee: seesEverythingButOne` — a stub of the very thing being
    guarded. So the half that makes a *changed* manifest bite had no wired
    coverage at all.

    Each note below is created while `1-projects` is team, so its line is
    stored `vis: team` and the stored half lets it through. It is then hidden
    by a different mechanism, and the team reader must stop seeing the line
    that was already written. That is the live half, and only the live half.
  */
  /*
    One folder each, and each published to team on the way in.

    Both halves of that matter and both were got wrong first. A line is stored
    `vis: team` only if every path in it is team AT WRITE TIME, so a note left
    at the manifest's `private` default never reaches the live half at all —
    the stored flag drops it and the check proves nothing. And the feed GROUPS
    by parent folder inside a window, so three notes written into `1-projects`
    became one entry whose `every()` went private the moment one of them did,
    taking `alpha` down with it.
  */
  const publish = async (path, letter, summary) =>
    call(OWNER, "write_note", {
      path,
      content: `# ${summary}\n\n${letter.repeat(400)}\n`,
      visibility: "team",
      confirm_team_publish: true,
      summary,
    });
  await publish("2-areas/held-back.md", "c", "a note that will be held back by name");
  await publish("1-projects/vault/plan.md", "d", "a note in what becomes a private subfolder");
  await publish("3-resources/rates.md", "e", "a note that will be pointed at a group");

  const beforeHiding = textOf(await call(TEAM, "read_activity", {}));
  check(
    "all three start visible to a team reader, or the checks below prove nothing",
    beforeHiding.includes("2-areas/held-back.md") &&
      beforeHiding.includes("1-projects/vault/plan.md") &&
      beforeHiding.includes("3-resources/rates.md"),
  );

  // (1) HELD BACK BY NAME — an exact-note override inside a team folder.
  await call(OWNER, "set_visibility", { path: "2-areas/held-back.md", visibility: "private" });
  // (2) A PRIVATE SUBFOLDER under a team one.
  /*
    Two phases, and the first one is a plan rather than a write: this tool
    refuses to apply without the `expected_privacy_etag` its dry run reports,
    so that a folder-wide visibility change is never made against a manifest
    the caller has not seen. The first version of this check called it once,
    read the plan as success, and asserted on a change that had not happened.
  */
  const folderPlan = textOf(
    await call(OWNER, "set_folder_visibility", { path: "1-projects/vault", visibility: "private" }),
  );
  const privacyEtag = /privacy_etag: (\S+)/.exec(folderPlan)?.[1];
  const folderApplied = await call(OWNER, "set_folder_visibility", {
    path: "1-projects/vault",
    visibility: "private",
    expected_privacy_etag: privacyEtag,
  });
  check(
    "the private-subfolder rule actually applied, or the check below proves nothing",
    Boolean(privacyEtag) && !folderApplied?.isError,
  );
  /*
    (3) POINTED AT A GROUP. No gateway tool mints a group rule — `setNoteGroup`
    is the console's — so the manifest is written directly, in exactly the form
    that action produces (`@name`, undecorated in the rule value). What it
    proves is about the reader, not the writer: `read_activity` calls `canSee`
    with four arguments, so `grantedGroups` is `undefined` and a group-pointed
    note is invisible to every team-tier caller. A line already written about
    it must go with it.
  */
  const manifest = await store.get("privacy.md");
  await store.put(
    "privacy.md",
    (await manifest.text()).replace(
      "note_overrides:\n",
      "note_overrides:\n  3-resources/rates.md: @supa-leads\n",
    ),
  );

  const afterHiding = textOf(await call(TEAM, "read_activity", {}));
  check(
    "a note held back by name drops out of the line written while it was shared",
    !afterHiding.includes("held-back"),
  );
  check(
    "a note moved under a private subfolder drops out of its earlier line",
    !afterHiding.includes("vault/plan"),
  );
  check(
    "a note pointed at a group drops out for a team reader who is in no group",
    !afterHiding.includes("rates"),
  );
  check(
    "and the team line that is still team is still there, so nothing was hidden wholesale",
    afterHiding.includes("1-projects/alpha"),
  );
  const ownerAfterHiding = textOf(await call(OWNER, "read_activity", {}));
  check(
    "the owner still sees all three, because none of this is about deletion",
    ownerAfterHiding.includes("held-back") &&
      ownerAfterHiding.includes("vault/plan") &&
      ownerAfterHiding.includes("rates"),
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

  /*
    WHAT THE GATEWAY TELLS THE CONTROL PLANE THAT A LINE LANDED.

    The console draws a dot on another context's mark without opening that
    context's bucket, so something has to cross the boundary. The whole of
    what may cross is one workspace id — the same rule `usageReporting.test.mjs`
    states for the counters, and for the same reason: what changed, who
    changed it and where are in the customer's bucket, and a second copy on
    our side built so a dot can be drawn is the first non-negotiable being
    spent on a pixel.

    Asserted over the serialized body rather than over a field list, so a
    field somebody adds later is caught by the shape rather than by being
    remembered.
  */
  const reports = () =>
    controlPlane.calls.filter((entry) => entry.path === "/gateway/activity");

  controlPlane.calls.length = 0;
  await call(OWNER, "write_note", {
    path: "1-projects/beta.md",
    content: `# Beta\n\n${"c".repeat(400)}\n`,
    summary: "a sentence that must not cross the wire",
  });
  await Promise.resolve();
  {
    const sent = reports();
    check("a line landing reports it to the control plane", sent.length === 1);
    check(
      "with the context it was written into, its tier, and nothing else",
      JSON.stringify(sent[0]?.body) ===
        JSON.stringify({ workspaceId: "ws_activity", teamVisible: false }),
    );
    // Belt and braces on the line above, and the one that would actually be
    // written by accident: a summary, a path, or a name leaking into the body
    // of a request whose only job is to move a boolean.
    const body = JSON.stringify(sent[0]?.body ?? {});
    check(
      "and no path, summary, person or client in it",
      !body.includes("beta") &&
        !body.includes("must not cross") &&
        !body.includes("@activity") &&
        !body.includes("Claude Code"),
    );
  }

  /*
    AND THE TIER, WHICH IS THE ONE FIELD THAT IS ALLOWED TO CROSS.

    Not a fact about the note: it says which of the two stamps on the workspace
    row may move. A member who is not the owner reads `activityTeamAt`, so a
    private line that moved their dot would hand them the exact time of a
    change the file, the tree and `list_changes` all refuse them — the one
    place in the product where a private write would leak its clock.
  */
  controlPlane.calls.length = 0;
  await call(OWNER, "write_note", {
    path: "1-projects/gamma.md",
    content: `# Gamma\n\n${"d".repeat(400)}\n`,
    visibility: "team",
    confirm_team_publish: true,
  });
  await Promise.resolve();
  check(
    "a team line reports its tier as team",
    reports()[0]?.body?.teamVisible === true,
  );

  controlPlane.calls.length = 0;
  await call(OWNER, "write_note", {
    path: "3-teams/salaries.md",
    content: `# Salaries\n\n${"e".repeat(400)}\n`,
  });
  await Promise.resolve();
  check(
    "and a private one reports false, so no member's dot moves for it",
    reports()[0]?.body?.teamVisible === false,
  );

  /*
    And the half that is easy to get backwards: the stamp follows the *line*,
    not the operation. A change the feed declines to mention must not light a
    dot, or the console sends somebody to look for something that was never
    written down — the "workspace can feel dead" problem inverted into a
    workspace that cries wolf.
  */
  controlPlane.calls.length = 0;
  const beta = await call(OWNER, "read_note", { path: "1-projects/beta.md" });
  await call(OWNER, "write_note", {
    path: "1-projects/beta.md",
    content: `# Beta\n\n${"c".repeat(400)}\nx\n`,
    expected_etag: beta?.etag,
  });
  await Promise.resolve();
  check(
    "a change too small to mention reports nothing",
    reports().length === 0,
  );

  restore();
}
