/**
 * Markdown forms: the grammar, the round-trip, and who may write what.
 *
 * Three things are being proved here, and they fail for different reasons.
 *
 * **The grammar fails closed.** A block that does not parse leaves the form
 * inert — no submission lands, and the note stays ordinary Markdown. Every
 * refusal below names the line, because the author is the person who can fix
 * it.
 *
 * **The round-trip is lossless under hostile input.** The gateway rewrites the
 * whole response file on every submission, edit and vote, which means it parses
 * back what it wrote. A submission containing a table row, a heading, a
 * `**Votes:**` line or a trailing backslash must come back as itself — and must
 * not be able to forge a second response, or somebody else's name, by being
 * written into the file verbatim. That is the injection surface here, and it is
 * the same shape as the `privacy.md` newline injection this repo already
 * closed: a renderer interpolating attacker text into a line-oriented format.
 *
 * **A `member` can submit and can do nothing else.** This is the only write in
 * the gateway that does not require `context:write` in the target context, so
 * the gate is two-part and both halves are checked: the *grant* must still have
 * asked for write (a client connected read-only stays read-only), and the
 * *form* must admit that role. Everything else a member could reach through
 * these tools — another person's response, a form that does not take their
 * role, a response file in another tenant — is refused.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/forms.js` and `src/index.js`, and
 * reverted. Numbers are what actually failed, not what was expected to.
 *
 * 1. **`escapeCell` returns its argument unchanged** — 5 checks failed. The
 *    file stopped parsing at all, which is the loud half; the quiet half is
 *    that a submitted `|` had already become a column boundary by then.
 * 2. **`unescapeCell` written as six sequential `.replace()` calls in the same
 *    order as the escape** — 2 checks failed. First attempt: **0**, and the
 *    reason is worth keeping — this escaping is robust to *most* orderings, so
 *    a sequential inverse is usually right. It is wrong for exactly one input:
 *    a literal `<br>`, which `&lt;`-first turns back into a line break. That
 *    string is now in the fixture, and it is the only thing standing between
 *    the single left-to-right scan and a plausible "simplification".
 * 3. **The write gate exempts `FORM_TOOLS` without `participatesInForms`** — 5
 *    checks failed, led by the read-only grant submitting. That is the gate's
 *    whole point: read-only has to mean read-only even for somebody whose
 *    membership would otherwise allow a response.
 * 4. **`mayChangeResponse` always allows** — 5 checks failed: a member edited
 *    another member's response, and `edit_own: false` stopped meaning anything.
 * 5. **The recorded name is a constant rather than `store.actor.name`** — 4
 *    checks failed. The `by` argument is separately refused by the advertised
 *    schema before any handler sees it, so proving the stamp needed two people
 *    submitting to one form, not one person trying to claim a name.
 * 6. **The marker check in `parseResponsesFile` is removed** — 1 check failed.
 *    Only one, and that is correct rather than thin: a form aimed at somebody's
 *    note is stopped a second time by `ensureFormResponseFiles`, which only
 *    ever creates. Two independent guards, one of which this sabotage leaves
 *    standing.
 * 7. **The `onlyIf.etagMatches` is dropped from the response write** — 1 check
 *    failed, and it failed by losing the interleaved response rather than by
 *    erroring. First attempt: **0**, because the test's interleaving write ran
 *    *before* the read took its snapshot, so the caller had already merged the
 *    other response and no conflict was possible. The hook now fires after the
 *    snapshot, which is the only ordering that models the race.
 * 8. **`escapeBlock` returns its argument unchanged** — 6 checks failed,
 *    including a submitted paragraph forging a third response under another
 *    person's username.
 *
 * One test-quality finding came out of the same pass: sabotage 1 originally
 * took the whole suite down rather than failing one check, because the
 * round-trip assertions dereferenced a parse that had just failed. Every check
 * reached by an unparseable file now fails instead of throwing.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  newResponseId,
  parseFormBlocks,
  parseResponsesFile,
  renderResponsesFile,
  responseStamp,
  validateSubmission,
} from "../src/forms.js";

const OWNER_TOKEN = `cat_forms_owner_${"0".repeat(16)}`;
const EDITOR_TOKEN = `cat_forms_editor_${"0".repeat(15)}`;
const MEMBER_TOKEN = `cat_forms_member_${"0".repeat(15)}`;
const READONLY_TOKEN = `cat_forms_readonly_${"0".repeat(13)}`;
const OUTSIDER_TOKEN = `cat_forms_outsider_${"0".repeat(13)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  3-resources: team\n\n" +
  "note_overrides:\n  3-resources/private-notes.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const BUGS_NOTE = [
  "Found something broken? Log it here.",
  "",
  "```form",
  "id: bugs",
  "responses: 3-resources/bugs.responses.md",
  "layout: sections",
  "submit: member",
  "edit_own: true",
  "votes: named",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "  - { name: severity, type: select, options: [blocker, major, minor] }",
  "  - { name: steps, type: text, max: 4000 }",
  "```",
].join("\n");

const REQUESTS_NOTE = [
  "```form",
  "id: requests",
  "responses: 3-resources/requests.responses.md",
  "layout: table",
  "submit: member",
  "edit_own: false",
  "votes: named",
  "fields:",
  "  - { name: title, type: line, max: 120, required: true }",
  "  - { name: area, type: select, options: [mcp, app, search] }",
  "```",
].join("\n");

const STAFF_NOTE = [
  "```form",
  "id: staff",
  "responses: 3-resources/staff.responses.md",
  "layout: table",
  "submit: editor",
  "votes: off",
  "fields:",
  "  - { name: note, type: line, max: 80 }",
  "```",
].join("\n");

/** An in-memory bucket honouring the conditional writes forms require. */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const bucket = {
    objects,
    /** Fires once, on the next get of this key, before the value is returned. */
    interceptGet: null,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      // The snapshot is taken FIRST and the interleaving write runs after it,
      // which is the only ordering that models the race: this caller has read
      // version N, somebody else lands version N+1, and this caller's write is
      // still holding N. Firing the hook before the read would hand this caller
      // the other response already merged in, and the conditional write would
      // never be exercised at all.
      const snapshot = { body: stored.body, etag: stored.etag };
      if (bucket.interceptGet && bucket.interceptGet.key === key) {
        const fire = bucket.interceptGet;
        bucket.interceptGet = null;
        fire.run(bucket);
      }
      return {
        etag: snapshot.etag,
        text: async () => snapshot.body,
        arrayBuffer: async () => new TextEncoder().encode(snapshot.body).buffer,
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
  return bucket;
}

async function rpc(env, token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const body = await response.json();
  await settle();
  return body;
}

async function call(env, token, name, args = {}) {
  const body = await rpc(env, token, "tools/call", { name, arguments: args });
  return {
    text: body?.result?.content?.[0]?.text ?? "",
    isError: body?.result?.isError === true,
  };
}

const pairs = (object) => Object.entries(object).map(([field, value]) => ({ field, value }));

export async function runFormChecks(check) {
  /* ================= the grammar, checked without a worker ================= */

  {
    const blocks = parseFormBlocks(BUGS_NOTE);
    check("a well-formed form block parses to one config", blocks.length === 1 && !!blocks[0].config);
    check("...and keeps its declared layout rather than inferring one", blocks[0].config.layout === "sections");
    check("...and defaults edit_own to true", blocks[0].config.edit_own === true);

    const noVotes = parseFormBlocks(STAFF_NOTE)[0].config;
    check("votes defaults are read, not guessed", noVotes.votes === "off" && noVotes.submit === "editor");
  }

  {
    const broken = (body) => parseFormBlocks(["```form", ...body, "```"].join("\n"))[0];
    check(
      "an unknown key is refused by name",
      /unknown key "colour"/.test(broken(["id: a", "colour: red"]).error || "")
    );
    check(
      "a missing layout is refused rather than defaulted",
      /"layout" is required/.test(
        broken(["id: a", "responses: a.md", "fields:", "  - { name: x, type: line, max: 5 }"]).error || ""
      )
    );
    check(
      "a line field without a cap is refused, because an uncapped cell breaks the table",
      /needs max/.test(
        broken(["id: a", "responses: a.md", "layout: table", "fields:", "  - { name: x, type: line }"]).error || ""
      )
    );
    check(
      "a field may not be named after a column this gateway writes",
      /is a column this gateway writes/.test(
        broken([
          "id: a",
          "responses: a.md",
          "layout: table",
          "fields:",
          "  - { name: votes, type: line, max: 5 }",
        ]).error || ""
      )
    );
    check(
      "two fields with one name are refused",
      /two fields are called/.test(
        broken([
          "id: a",
          "responses: a.md",
          "layout: table",
          "fields:",
          "  - { name: x, type: line, max: 5 }",
          "  - { name: x, type: line, max: 5 }",
        ]).error || ""
      )
    );
    check(
      "a select with no options is refused",
      /needs options/.test(
        broken(["id: a", "responses: a.md", "layout: table", "fields:", "  - { name: x, type: select }"]).error || ""
      )
    );
    const unclosed = parseFormBlocks("```form\nid: a\n");
    check("an unclosed form fence is an error, not a block read to the end of the note", unclosed[0]?.error === "the form block is never closed");
  }

  {
    // A note may legitimately contain other fenced blocks, including one that
    // quotes a form block inside a longer fence. The scanner walks fences in
    // order rather than regexing the note, so only the real one is a form.
    const note = [
      "````markdown",
      "```form",
      "id: quoted",
      "```",
      "````",
      "",
      "```form",
      "id: real",
      "responses: r.md",
      "layout: table",
      "fields:",
      "  - { name: x, type: line, max: 5 }",
      "```",
    ].join("\n");
    const blocks = parseFormBlocks(note);
    check("a form block quoted inside a longer fence is not a form", blocks.length === 1);
    check("...and the real one after it still parses", blocks[0].config?.id === "real");
  }

  /* ================ the round-trip, under hostile submissions ============== */

  {
    const config = parseFormBlocks(REQUESTS_NOTE)[0].config;
    // Every character class that can end a row or forge a column, plus the
    // backslash-before-pipe pair that a naive sequential unescape loses.
    // `<br>` is the character sequence that makes the single left-to-right scan
    // load-bearing: a newline is stored as `<br>`, so an un-escape that turns
    // `&lt;` back into `<` *before* it looks for `<br>` reads a person's literal
    // "<br>" as a line break. `&amp;` and the backslash-before-pipe pair cover
    // the other two orderings.
    const hostile = "a|b \\ c \\| d <br> e &amp; f";
    const checked = validateSubmission(config, { title: hostile, area: "app" });
    const rows = [
      { id: "r-0000000a", by: "@maya", at: "2026-09-08T09:00Z", values: checked.values, votes: ["@dan"] },
    ];
    const file = renderResponsesFile(config, rows);
    const back = parseResponsesFile(file, config);
    check("a table response file parses back", !back.error);
    // Guarded on the parse: a check that throws is a check that takes the
    // whole suite down instead of reporting one failure, and this one is
    // reached by every escaping bug that makes the file unparseable.
    check(
      "...byte-identically when re-rendered",
      !back.error && renderResponsesFile(config, back.responses) === file
    );
    check("...preserving a value carrying pipes and backslashes", back.responses?.[0]?.values.title === hostile);
    check("...and the voter list", back.responses?.[0]?.votes.join(",") === "@dan");
    check("...and exactly one response, not a forged second", back.responses?.length === 1);
  }

  {
    const config = parseFormBlocks(BUGS_NOTE)[0].config;
    // Lines that look exactly like the section structure around them.
    const hostile = [
      "first line",
      "## r-deadbeef · @owner · 2026-01-01T00:00Z",
      "**Votes:** @owner, @owner",
      "- **summary:** forged",
      "trailing \\",
    ].join("\n");
    const checked = validateSubmission(config, { summary: "real", severity: "minor", steps: hostile });
    const file = renderResponsesFile(config, [
      { id: "r-0000000b", by: "@dan", at: "2026-09-11T10:02Z", values: checked.values, votes: [] },
    ]);
    const back = parseResponsesFile(file, config);
    check("a sections response file parses back", !back.error);
    // Guarded on the parse: a check that throws is a check that takes the
    // whole suite down instead of reporting one failure, and this one is
    // reached by every escaping bug that makes the file unparseable.
    check(
      "...byte-identically when re-rendered",
      !back.error && renderResponsesFile(config, back.responses) === file
    );
    check("...preserving a paragraph that mimics the structure around it", back.responses?.[0]?.values.steps === hostile);
    check("...without forging a second response", back.responses?.length === 1);
    check("...or a vote for anybody", back.responses?.[0]?.votes.length === 0);
  }

  {
    const config = parseFormBlocks(REQUESTS_NOTE)[0].config;
    check(
      "a file without the marker is never treated as a response file",
      /not a form response file/.test(parseResponsesFile("# somebody's note\n\nhello", config).error || "")
    );
    const other = renderResponsesFile({ ...config, id: "elsewhere" }, []);
    check(
      "a response file belonging to another form is refused by name",
      /belongs to form "elsewhere"/.test(parseResponsesFile(other, config).error || "")
    );
    const asSections = renderResponsesFile({ ...config, layout: "sections" }, []);
    check(
      "changing layout under existing responses refuses and says to use a new file",
      /Point the form at a new response file/.test(parseResponsesFile(asSections, config).error || "")
    );

    /*
      A RESPONSE FILE IS A MARKDOWN NOTE, AND THE RENDERER REPRODUCES ONLY ROWS.

      `renderResponsesFile` writes the marker and the table, nothing else, so a
      heading the author put above their table — or a "## Notes from triage"
      section below it — is not in what comes back out. The parser dropped both
      silently and answered `{ responses }` with no error, which made the next
      submission a rewrite that deleted them.

      The person that write belongs to is a **member**, the lowest role in the
      system, and where the response file is private (the survey case this
      package's own decision document describes) they cannot see what they
      destroyed and cannot read it back afterwards.

      So the file is inert rather than half-working — the rule `forms.md`
      already states for a form block, applied to the file it names.
    */
    const authored = [
      renderResponsesFile(config, []).split("\n")[0],
      "",
      "# Feature requests",
      "",
      "Keep these short. Triage is on Fridays.",
      "",
      ...renderResponsesFile(config, []).split("\n").slice(1),
      "## Notes from triage",
      "",
      "- 2026-09-01: closed three duplicates.",
    ].join("\n");
    check(
      "prose the author keeps around the table refuses rather than being silently dropped",
      /cannot be reproduced|only the table/.test(parseResponsesFile(authored, config).error || "")
    );
    check(
      "...and a file holding only the marker, the table and blank lines still parses",
      parseResponsesFile(renderResponsesFile(config, []), config).error === undefined
    );

    const sectionsConfig = { ...config, layout: "sections" };
    const authoredSections = [
      renderResponsesFile(sectionsConfig, []).split("\n")[0],
      "",
      "Answers are collected below. Please do not edit anybody else's.",
      "",
      "## r-0000000a · @maya · 2026-09-08T09:00Z",
      "",
      "### title",
      "",
      "a request",
    ].join("\n");
    check(
      "the same is true of a sections file with a note before the first response",
      /cannot be reproduced|only the responses/.test(parseResponsesFile(authoredSections, sectionsConfig).error || "")
    );
    check(
      "...and an empty sections file still parses",
      parseResponsesFile(renderResponsesFile(sectionsConfig, []), sectionsConfig).error === undefined
    );
  }

  {
    const config = parseFormBlocks(REQUESTS_NOTE)[0].config;
    check(
      "a value outside the declared options is refused",
      /must be one of/.test(validateSubmission(config, { title: "x", area: "nope" }).error || "")
    );
    check(
      "a required field left out is refused",
      /"title" is required/.test(validateSubmission(config, { area: "app" }).error || "")
    );
    check(
      "an answer longer than the cap is refused",
      /longer than 120/.test(validateSubmission(config, { title: "x".repeat(121) }).error || "")
    );
    check(
      "an answer to a field that does not exist is refused",
      /no field called "colour"/.test(validateSubmission(config, { title: "x", colour: "red" }).error || "")
    );
    check(
      "a single-line field refuses a newline rather than silently flattening it",
      /must be a single line/.test(validateSubmission(config, { title: "a\nb" }).error || "")
    );
  }

  /* ===================== permissions, through the worker =================== */

  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const otherBucket = createBucket();

    controlPlane.addWorkspace(
      "ws_forms",
      "forms",
      {
        provider: "r2-binding",
        bindingName: "FORMS_BUCKET",
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      },
      { kind: "shared" }
    );
    controlPlane.addWorkspace(
      "ws_other",
      "other",
      {
        provider: "r2-binding",
        bindingName: "OTHER_BUCKET",
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      },
      { kind: "shared" }
    );
    // Personal brains, so every caller has a username to be recorded under.
    for (const [id, slug] of [
      ["ws_seyi", "seyi"],
      ["ws_ed", "ed"],
      ["ws_dan", "dan"],
      ["ws_ro", "ro"],
      ["ws_out", "out"],
    ]) {
      controlPlane.addWorkspace(id, slug, {
        provider: "r2-binding",
        bindingName: "FORMS_BUCKET",
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      });
    }

    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_forms",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_forms_owner",
      userId: "user_seyi",
      alsoMemberOf: [{ workspaceId: "ws_seyi", role: "owner" }],
    });
    await controlPlane.addGrant({
      accessToken: EDITOR_TOKEN,
      workspaceId: "ws_forms",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_forms_editor",
      userId: "user_ed",
      alsoMemberOf: [{ workspaceId: "ws_ed", role: "owner" }],
    });
    await controlPlane.addGrant({
      accessToken: MEMBER_TOKEN,
      workspaceId: "ws_forms",
      role: "member",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_forms_member",
      userId: "user_dan",
      alsoMemberOf: [{ workspaceId: "ws_dan", role: "owner" }],
    });
    // The same membership, through a client its person connected read-only.
    await controlPlane.addGrant({
      accessToken: READONLY_TOKEN,
      workspaceId: "ws_forms",
      role: "member",
      scopes: ["context:read"],
      clientId: "mcp_client_forms_readonly",
      userId: "user_ro",
      alsoMemberOf: [{ workspaceId: "ws_ro", role: "owner" }],
    });
    await controlPlane.addGrant({
      accessToken: OUTSIDER_TOKEN,
      workspaceId: "ws_other",
      role: "owner",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_forms_outsider",
      userId: "user_out",
      alsoMemberOf: [{ workspaceId: "ws_out", role: "owner" }],
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "FORMS_BUCKET,OTHER_BUCKET",
      FORMS_BUCKET: bucket,
      OTHER_BUCKET: otherBucket,
    };

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# the forms workspace");
    otherBucket.seed("privacy.md", MANIFEST);

    /* -- (1) an editor creates the forms, and their response files ---------- */

    const wrote = await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/bugs.md",
      content: BUGS_NOTE,
      visibility: "team",
    });
    check("an editor can write a note carrying a form", !wrote.isError);
    check(
      "...and its response file is created for them",
      /response file created: 3-resources\/bugs\.responses\.md/.test(wrote.text)
    );
    check(
      "...as an empty response file, not a guess at one",
      (bucket.text("3-resources/bugs.responses.md") || "").startsWith(
        "<!-- context:form responses id=bugs layout=sections -->"
      )
    );

    for (const [path, content] of [
      ["3-resources/requests.md", REQUESTS_NOTE],
      ["3-resources/staff.md", STAFF_NOTE],
    ]) {
      await call(env, EDITOR_TOKEN, "write_note", { path, content, visibility: "team" });
    }
    check(
      "each form gets its own response file",
      !!bucket.text("3-resources/requests.responses.md") && !!bucket.text("3-resources/staff.responses.md")
    );

    const brokenWrite = await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/broken.md",
      content: "```form\nid: broken\ncolour: red\n```",
      visibility: "team",
    });
    check("a note carrying a form that does not parse is refused at the write", brokenWrite.isError);
    check("...naming the line and the reason", /line 1 is not valid: unknown key "colour"/.test(brokenWrite.text));
    check("...and nothing is stored at that path", bucket.text("3-resources/broken.md") === undefined);

    /* -- (2) the tool listing a member is given ----------------------------- */

    const memberTools = (await rpc(env, MEMBER_TOKEN, "tools/list", {})).result?.tools || [];
    const names = new Set(memberTools.map((tool) => tool.name));
    check("a member is offered submit_form", names.has("submit_form"));
    check("...and vote_form", names.has("vote_form"));
    // `write_note` is listed too, and that is correct rather than a hole: this
    // connection covers its person's own brain, which they own and may write.
    // The listing has never been the control — the per-call gate below is, and
    // it reads the role in the context the call was routed to.
    check("...alongside write_note, which they may use in their own brain", names.has("write_note"));

    const readonlyTools = (await rpc(env, READONLY_TOKEN, "tools/list", {})).result?.tools || [];
    check(
      "a connection granted read-only is offered no form tools at all",
      !readonlyTools.some((tool) => tool.name.startsWith("submit_") || tool.name === "vote_form")
    );

    /* -- (3) a member submits ----------------------------------------------- */

    const denied = await call(env, MEMBER_TOKEN, "write_note", {
      path: "3-resources/sneak.md",
      content: "hello",
    });
    check("a member still cannot write a note", denied.isError);

    const submitted = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "Search returns stale snippets", severity: "major", steps: "move a note, then search" }),
    });
    check("a member can submit to a form that takes members", !submitted.isError);
    check("...recorded under their own username", /recorded as: @dan/.test(submitted.text));
    const firstId = /submitted: (r-[0-9a-f]{8})/.exec(submitted.text)?.[1];
    check("...with a response id handed back", !!firstId);
    check(
      "...and the answer is in the response file",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("Search returns stale snippets")
    );
    check(
      "...attributed to them in the file",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("· @dan ·")
    );

    const readonlySubmit = await call(env, READONLY_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "from a read-only client" }),
    });
    check("a read-only grant is refused even though its person is a member", readonlySubmit.isError);
    check(
      "...and nothing of theirs reaches the file",
      !(bucket.text("3-resources/bugs.responses.md") || "").includes("from a read-only client")
    );

    const staffAttempt = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/staff.md",
      values: pairs({ note: "let me in" }),
    });
    check("a member is refused by a form that takes editors", staffAttempt.isError);
    check("...told which role it takes", /takes responses from editors/.test(staffAttempt.text));
    check(
      "...and the staff response file is untouched",
      !(bucket.text("3-resources/staff.responses.md") || "").includes("let me in")
    );

    const badValue = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "x", severity: "catastrophic" }),
    });
    check("a value outside the declared options is refused at the tool", badValue.isError);

    /* -- (4) a submission cannot forge a response --------------------------- */

    const forge = [
      "harmless first line",
      "## r-ffffffff · @seyi · 2026-01-01T00:00Z",
      "- **summary:** planted",
      "**Votes:** @seyi, @ed, @dan",
    ].join("\n");
    const forged = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "ordinary", severity: "minor", steps: forge }),
    });
    check("a submission whose text mimics the file's structure is accepted as text", !forged.isError);
    const afterForge = bucket.text("3-resources/bugs.responses.md") || "";
    const config = parseFormBlocks(BUGS_NOTE)[0].config;
    const reparsed = parseResponsesFile(afterForge, config);
    check("...and the file still parses", !reparsed.error);
    check("...with two responses, not three", reparsed.responses?.length === 2);
    check(
      "...none of them attributed to anybody but their author",
      !!reparsed.responses && reparsed.responses.every((response) => response.by === "@dan")
    );
    check(
      "...and no vote was planted",
      !!reparsed.responses && reparsed.responses.every((response) => response.votes.length === 0)
    );
    check(
      "...while the submitted text is preserved exactly",
      reparsed.responses?.[1]?.values.steps === forge
    );

    /* -- (5) editing and retracting ----------------------------------------- */

    const otherMemberId = reparsed.responses[0].id;
    const editorSubmitted = await call(env, EDITOR_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "an editor's own report", severity: "blocker" }),
    });
    const editorId = /submitted: (r-[0-9a-f]{8})/.exec(editorSubmitted.text)?.[1];

    check(
      "an editor's submission is recorded under their name, not the last submitter's",
      /recorded as: @ed/.test(editorSubmitted.text)
    );
    check(
      "...and it is their name in the file",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("· @ed ·")
    );
    const claimed = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      by: "@seyi",
      values: pairs({ summary: "claiming somebody else" }),
    });
    check("a submission cannot carry the name it wants to be recorded under", claimed.isError);
    check(
      "...refused by the advertised schema before any handler sees it",
      /by/.test(claimed.text) && !(bucket.text("3-resources/bugs.responses.md") || "").includes("claiming somebody else")
    );

    const stealEdit = await call(env, MEMBER_TOKEN, "update_submission", {
      path: "3-resources/bugs.md",
      response_id: editorId,
      values: pairs({ summary: "rewritten by somebody else", severity: "minor" }),
    });
    check("a member cannot edit another person's response", stealEdit.isError);
    check("...told whose it is, which they can already read", /is @ed's, not yours/.test(stealEdit.text));
    check(
      "...and the response is unchanged",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("an editor's own report")
    );

    const ownEdit = await call(env, MEMBER_TOKEN, "update_submission", {
      path: "3-resources/bugs.md",
      response_id: otherMemberId,
      values: pairs({ summary: "corrected summary", severity: "minor" }),
    });
    check("a member can edit their own response where the form allows it", !ownEdit.isError);
    check(
      "...and the correction is in the file",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("corrected summary")
    );
    const afterEdit = parseResponsesFile(bucket.text("3-resources/bugs.responses.md"), config);
    check(
      "...while the author and time are not the submitter's to rewrite",
      afterEdit.responses?.[0]?.by === "@dan" && afterEdit.responses?.[0]?.id === otherMemberId
    );

    const requestSubmit = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/requests.md",
      values: pairs({ title: "Bulk re-tag notes", area: "app" }),
    });
    const requestId = /submitted: (r-[0-9a-f]{8})/.exec(requestSubmit.text)?.[1];
    const blockedEdit = await call(env, MEMBER_TOKEN, "update_submission", {
      path: "3-resources/requests.md",
      response_id: requestId,
      values: pairs({ title: "changed my mind", area: "mcp" }),
    });
    check("edit_own: false stops a submitter editing even their own response", blockedEdit.isError);
    check("...saying so rather than claiming it is not theirs", /does not let people edit/.test(blockedEdit.text));

    const editorRetract = await call(env, EDITOR_TOKEN, "retract_submission", {
      path: "3-resources/requests.md",
      response_id: requestId,
    });
    check("an editor can retract anybody's response", !editorRetract.isError);
    check(
      "...and it is gone from the file",
      !(bucket.text("3-resources/requests.responses.md") || "").includes("Bulk re-tag notes")
    );

    /* -- (6) votes ----------------------------------------------------------- */

    const voted = await call(env, MEMBER_TOKEN, "vote_form", {
      path: "3-resources/bugs.md",
      response_id: editorId,
      vote: "up",
    });
    check("a member can vote on a response they can see", !voted.isError);
    check("...counted once", /votes: 1/.test(voted.text));
    const votedTwice = await call(env, MEMBER_TOKEN, "vote_form", {
      path: "3-resources/bugs.md",
      response_id: editorId,
      vote: "up",
    });
    check("voting twice is still one vote", /votes: 1/.test(votedTwice.text));
    check(
      "...and the voter is named so it can be taken back",
      (bucket.text("3-resources/bugs.responses.md") || "").includes("**Votes:** @dan")
    );
    const withdrawn = await call(env, MEMBER_TOKEN, "vote_form", {
      path: "3-resources/bugs.md",
      response_id: editorId,
      vote: "none",
    });
    check("a vote can be withdrawn", !withdrawn.isError && /votes: 0/.test(withdrawn.text));
    const withdrawnAgain = await call(env, MEMBER_TOKEN, "vote_form", {
      path: "3-resources/bugs.md",
      response_id: editorId,
      vote: "none",
    });
    check("withdrawing a vote never cast is the state you asked for, not an error", !withdrawnAgain.isError);

    const noVotes = await call(env, EDITOR_TOKEN, "vote_form", {
      path: "3-resources/staff.md",
      response_id: "r-00000000",
      vote: "up",
    });
    check("a form with votes off refuses a vote", noVotes.isError && /does not collect votes/.test(noVotes.text));

    /* -- (7) what a form may not be pointed at ------------------------------ */

    await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/notes.md",
      content: "somebody's ordinary note, not a response file",
      visibility: "team",
    });
    const aimed = await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/aimed.md",
      content: [
        "```form",
        "id: aimed",
        "responses: 3-resources/notes.md",
        "layout: table",
        "fields:",
        "  - { name: x, type: line, max: 10 }",
        "```",
      ].join("\n"),
      visibility: "team",
    });
    check("a form aimed at an existing note does not overwrite it", !aimed.isError);
    check(
      "...the note is left exactly as it was",
      bucket.text("3-resources/notes.md") === "somebody's ordinary note, not a response file"
    );
    check("...and the author is told the form is not collecting", /form not collecting yet: aimed/.test(aimed.text));
    const aimedSubmit = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/aimed.md",
      values: pairs({ x: "hello" }),
    });
    check("...so a submission to it is refused", aimedSubmit.isError);
    check(
      "...and that note is still untouched",
      bucket.text("3-resources/notes.md") === "somebody's ordinary note, not a response file"
    );

    const atPrivacy = await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/plumbing.md",
      content: [
        "```form",
        "id: plumbing",
        "responses: privacy.md",
        "layout: table",
        "fields:",
        "  - { name: x, type: line, max: 10 }",
        "```",
      ].join("\n"),
      visibility: "team",
    });
    check("a form aimed at privacy.md is reported as unwritable", /not a writable note path/.test(atPrivacy.text));
    check(
      "...and the manifest is still a manifest, not a response file",
      (bucket.text("privacy.md") || "").includes("BEGIN BRAIN PRIVACY RULES") &&
        !(bucket.text("privacy.md") || "").includes("context:form responses")
    );

    /* -- (8) a form nobody may see, and another tenant's ---------------------- */

    bucket.seed(
      "3-resources/private-notes.md",
      [
        "```form",
        "id: secret",
        "responses: 3-resources/secret.responses.md",
        "layout: table",
        "fields:",
        "  - { name: x, type: line, max: 10 }",
        "```",
      ].join("\n")
    );
    const hidden = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/private-notes.md",
      values: pairs({ x: "hello" }),
    });
    check("a form on a note the caller cannot see is not found", hidden.isError && hidden.text === "not found");
    check(
      "...with the same three bytes a missing note gets",
      (await call(env, MEMBER_TOKEN, "submit_form", { path: "3-resources/nope.md", values: pairs({ x: "y" }) })).text ===
        "not found"
    );

    const crossTenant = await call(env, OUTSIDER_TOKEN, "submit_form", {
      path: "3-resources/bugs.md",
      values: pairs({ summary: "from another tenant" }),
    });
    check("a member of another workspace reaches nothing here", crossTenant.isError);
    check(
      "...and nothing of theirs is in this bucket",
      !(bucket.text("3-resources/bugs.responses.md") || "").includes("from another tenant")
    );
    check("...nor did a response file appear in theirs", otherBucket.text("3-resources/bugs.responses.md") === undefined);

    /* -- (9) two responses landing together ---------------------------------- */

    {
      const path = "3-resources/requests.responses.md";
      // Between this call's read of the response file and its conditional
      // write, somebody else's response lands. The write must be refused and
      // re-applied over theirs rather than replacing it.
      bucket.interceptGet = {
        key: path,
        run(store) {
          const current = store.text(path);
          const cfg = parseFormBlocks(REQUESTS_NOTE)[0].config;
          const parsed = parseResponsesFile(current, cfg);
          parsed.responses.push({
            id: newResponseId(),
            by: "@ed",
            at: responseStamp(),
            values: { title: "landed in between", area: "mcp" },
            votes: [],
          });
          store.seed(path, renderResponsesFile(cfg, parsed.responses));
        },
      };
      const raced = await call(env, MEMBER_TOKEN, "submit_form", {
        path: "3-resources/requests.md",
        values: pairs({ title: "mine, written over theirs", area: "app" }),
      });
      const after = bucket.text(path) || "";
      check("a submission racing another one still succeeds", !raced.isError);
      check("...keeping the response that landed in between", after.includes("landed in between"));
      check("...and its own", after.includes("mine, written over theirs"));
      const cfg = parseFormBlocks(REQUESTS_NOTE)[0].config;
      check("...in a file that still parses", !parseResponsesFile(after, cfg).error);
    }

    /* -- (10) a store that cannot do conditional writes ---------------------- */

    {
      const weakBucket = createBucket();
      controlPlane.addWorkspace(
        "ws_weak",
        "weak",
        {
          provider: "r2-binding",
          bindingName: "WEAK_BUCKET",
          capabilities: { conditionalWrite: false, conditionalCreate: false, conditionalDelete: false },
          status: "active",
        },
        { kind: "shared" }
      );
      const WEAK_TOKEN = `cat_forms_weak_${"0".repeat(17)}`;
      await controlPlane.addGrant({
        accessToken: WEAK_TOKEN,
        workspaceId: "ws_weak",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId: "mcp_client_forms_weak",
        userId: "user_weak",
        alsoMemberOf: [{ workspaceId: "ws_seyi", role: "owner" }],
      });
      const weakEnv = {
        ...env,
        NATIVE_BINDINGS: "FORMS_BUCKET,OTHER_BUCKET,WEAK_BUCKET",
        WEAK_BUCKET: weakBucket,
      };
      weakBucket.seed("privacy.md", MANIFEST);
      await call(weakEnv, WEAK_TOKEN, "write_note", {
        path: "3-resources/bugs.md",
        content: BUGS_NOTE,
        visibility: "team",
        confirm_team_publish: true,
      });
      const refused = await call(weakEnv, WEAK_TOKEN, "submit_form", {
        path: "3-resources/bugs.md",
        values: pairs({ summary: "would be lost" }),
      });
      check("a store without conditional writes refuses the submission", refused.isError);
      check("...saying why, rather than taking it and losing it", /cannot do conditional writes/.test(refused.text));
      check(
        "...and writes nothing",
        !(weakBucket.text("3-resources/bugs.responses.md") || "").includes("would be lost")
      );
    }
  } finally {
    restore?.();
  }
}
