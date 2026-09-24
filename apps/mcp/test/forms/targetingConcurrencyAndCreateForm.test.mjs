/**
 * Markdown forms: what a form may not be pointed at — an existing ordinary
 * note is left untouched and reported "not collecting", `privacy.md` is
 * reported unwritable (§7); a form nobody may see, and another tenant's
 * reach nothing here (§8); a form aimed at a file a team connection may not
 * see answers identically whether that file exists, is private, or is
 * somebody else's response file — through both the write path and the
 * submit path (§8b); the drop-box the design chose — an owner may point a
 * form at a response file only they can read, and a member who cannot read
 * it can still submit into it (§8c); two responses landing together under a
 * conditional-write race (§9); `create_form`, which makes a note and its
 * response file from fields rather than markdown, never overwrites, and
 * never leaks a folder's privacy rule or a group's name to a connection
 * that could not have established it another way (§10); and a store without
 * conditional writes refuses a submission rather than risking losing it
 * (§10, store capability).
 *
 * Split out of forms.test.mjs; see fixtures.mjs for `createFormsHarness` and
 * the shared note fixtures. Independent of submissionsEditsAndVotes.test.mjs
 * beyond the shared `harness.bucket`/`env`/`controlPlane` — confirmed by
 * grepping this range for every variable the earlier sections define
 * (`config`, `reparsed`, `editorId`, `otherMemberId`, `requestId`) and
 * finding none of them read here; every local this section needs it builds
 * fresh.
 */

import {
  BUGS_NOTE,
  EDITOR_TOKEN,
  MEMBER_TOKEN,
  OUTSIDER_TOKEN,
  OWNER_TOKEN,
  READONLY_TOKEN,
  REQUESTS_NOTE,
  MANIFEST,
  call,
  createBucket,
  newResponseId,
  pairs,
  parseFormBlocks,
  parseResponsesFile,
  readDocument,
  renderResponsesFile,
  replaceText,
  responseStamp,
} from "./fixtures.mjs";

export async function runFormTargetingAndConcurrencyChecks(check, harness) {
  const { bucket, otherBucket, controlPlane, env } = harness;

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

  /* -- (8b) a form aimed at a file this connection may not see ------------- */
  /*
   * A team-tier connection holding `editor` writes notes, and a form's
   * `responses:` is a path it chooses inside one. `write_note` refuses that
   * same connection a create in private space, and refuses it any diagnosis
   * of what is already there — one refusal whether the note exists or not.
   *
   * The form path reaches the same file in the same call, so it has to
   * answer the same way. Otherwise the author's own write is an existence
   * oracle over every private note in the workspace: "not collecting yet"
   * with a parse error for one that exists, "response file created" for one
   * that does not — and in that second case a note written into private
   * space by a connection that may not write there. `docs/decisions/forms.md`
   * names the thing being refused: "a lookup that tells somebody something
   * about a file they may not read".
   */
  const aimedAt = (id, responses) =>
    [
      "```form",
      `id: ${id}`,
      `responses: ${responses}`,
      "layout: table",
      "fields:",
      "  - { name: x, type: line, max: 10 }",
      "```",
    ].join("\n");
  // `2-areas` is under the manifest's `default_visibility: private`, so none
  // of these three paths is visible to a team connection.
  bucket.seed("2-areas/ledger.md", "the owner's private ledger");
  // Named so that the form id inside it appears nowhere in the path: the
  // caller chose the path, so echoing that back leaks nothing, and only the
  // id read out of the file's marker would.
  bucket.seed(
    "2-areas/archive.md",
    "<!-- context:form responses id=payroll layout=table -->\n\n| Id  | By  | At  | x   |\n| --- | --- | --- | --- |\n"
  );
  const probe = async (note, responses) =>
    call(env, EDITOR_TOKEN, "write_note", {
      path: `3-resources/${note}.md`,
      content: aimedAt("probe", responses),
      visibility: "team",
    });
  const atExistingPrivate = await probe("probe-one", "2-areas/ledger.md");
  const atAbsentPrivate = await probe("probe-two", "2-areas/absent.md");
  const atPrivateResponses = await probe("probe-three", "2-areas/archive.md");
  // The written path and its etag differ between the three by construction;
  // what must not differ is the line about the file the form collects into.
  const formLine = (result) =>
    (result.text.split("\n").find((line) => /^(form not collecting yet|response file created):/.test(line)) || "")
      .replace(/2-areas\/[a-z.]+\.md/g, "PATH");
  check(
    "a team connection is told the same thing whether the private file it aims a form at exists",
    formLine(atExistingPrivate) === formLine(atAbsentPrivate) && formLine(atAbsentPrivate) !== ""
  );
  check(
    "...and the same again when that file is somebody else's response file",
    formLine(atPrivateResponses) === formLine(atAbsentPrivate)
  );
  check(
    "...never naming the form that private response file belongs to",
    !/payroll/.test(atPrivateResponses.text)
  );
  check(
    "...never reporting on the contents of a note it may not read",
    !/not a form response file|laid out as/.test(atExistingPrivate.text)
  );
  check(
    "...and no response file is created in private space by a team connection",
    bucket.text("2-areas/absent.md") === undefined
  );
  check(
    "...leaving the private note it aimed at exactly as it was",
    bucket.text("2-areas/ledger.md") === "the owner's private ledger"
  );

  // The same oracle through the other door: submitting reads that file too.
  const blindExisting = await call(env, MEMBER_TOKEN, "submit_form", {
    path: "3-resources/probe-one.md",
    values: pairs({ x: "hello" }),
  });
  const blindAbsent = await call(env, MEMBER_TOKEN, "submit_form", {
    path: "3-resources/probe-two.md",
    values: pairs({ x: "hello" }),
  });
  check(
    "submitting cannot tell those two apart either",
    blindExisting.isError && blindAbsent.isError && blindExisting.text === blindAbsent.text
  );
  check(
    "...and no submission lands in private space",
    bucket.text("2-areas/absent.md") === undefined &&
      bucket.text("2-areas/ledger.md") === "the owner's private ledger"
  );

  /* -- (8c) the drop-box the design chose, which still has to work --------- */
  /*
   * `docs/decisions/forms.md`: "a form whose responses are private is final.
   * A survey respondent cannot retract, because they cannot see their own
   * row." Submitting into a file you may not read is the feature, so the
   * blinding above collapses the *reasons* a response file is unusable and
   * never the submission itself. Untested until now, and it sits directly
   * under the change that could turn it into a refusal.
   */
  const dropBox = await call(env, OWNER_TOKEN, "write_note", {
    path: "3-resources/survey.md",
    content: aimedAt("survey", "2-areas/survey.responses.md"),
    visibility: "team",
    confirm_team_publish: true,
  });
  check(
    "an owner may point a form at a response file only they can read",
    /response file created: 2-areas\/survey\.responses\.md/.test(dropBox.text)
  );
  const intoDropBox = await call(env, MEMBER_TOKEN, "submit_form", {
    path: "3-resources/survey.md",
    values: pairs({ x: "anonymous" }),
  });
  check("...and a member who cannot read it can still submit into it", !intoDropBox.isError);
  check(
    "...with the answer really in the file",
    (bucket.text("2-areas/survey.responses.md") || "").includes("anonymous")
  );
  check(
    "...while that file stays unreadable to them",
    (await call(env, MEMBER_TOKEN, "read_note", { path: "2-areas/survey.responses.md" })).text === "not found"
  );

  /* -- (9) two responses landing together ---------------------------------- */

  {
    const path = "3-resources/requests.responses.md";
    // Between this call's read of the response file and its conditional
    // write, somebody else's response lands. The write must be refused and
    // re-applied over theirs rather than replacing it.
    bucket.interceptGet = {
      key: path,
      async run(store) {
        // Every writer now uses the same document authority. Land the other
        // response through that engine rather than mutating raw Markdown
        // behind it, which would model an unsupported writer and be repaired
        // from durable collaboration state by design.
        const base = await readDocument(store, path);
        const current = base.text;
        const cfg = parseFormBlocks(REQUESTS_NOTE)[0].config;
        const parsed = parseResponsesFile(current, cfg);
        parsed.responses.push({
          id: newResponseId(),
          by: "@ed",
          at: responseStamp(),
          values: { title: "landed in between", area: "mcp" },
          votes: [],
        });
        await replaceText(store, path, {
          documentId: base.documentId,
          expectedEtag: base.etag,
          text: renderResponsesFile(cfg, parsed.responses),
        });
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

  /* -- (10) create_form, which makes one from fields rather than markdown -- */
  //
  // The authority is unchanged: this is `write_note` with a block it rendered
  // itself, so an editor may call it and nobody below may. What is new is the
  // refusal to overwrite, and it is the one that would hurt — a tool called
  // "create" that replaced somebody's note would take their answers with it.

  {
    const made = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/intake.md",
      title: "New project intake",
      intro: "Everything I need before a first call.",
      fields: [
        { name: "who", type: "line", max: 120, required: true },
        { name: "kind", type: "select", options: ["Brand film", "Event coverage"] },
        { name: "brief", type: "text", max: 4000 },
      ],
    });
    check("create_form writes the note", !made.isError);
    check(
      "...and the answers note beside it, in the same call",
      typeof bucket.text("3-resources/intake-responses.md") === "string"
    );
    check(
      "...and says where the answers land and who can read them",
      /answers go to: 3-resources\/intake-responses\.md \(team\)/.test(made.text)
    );
    const note = bucket.text("3-resources/intake.md") || "";
    check("...with the author's own prose above the block", note.startsWith("# New project intake"));
    const block = parseFormBlocks(note)[0];
    check("...and a block this gateway parses back", block?.config?.id === "intake");
    check(
      "...whose id came from the note's own filename rather than being asked for",
      block?.config?.responses === "3-resources/intake-responses.md"
    );
    check(
      "...and points the agent at the link a form without accounts needs",
      /create_link with mode=collect/.test(made.text)
    );
    const editorsOnly = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/staff-only.md",
      submit: "editor",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check(
      "a form only editors may answer is not offered a link, because one would not work",
      !editorsOnly.isError && !/create_link with mode=collect/.test(editorsOnly.text)
    );

    const named = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/named.md",
      id: "client-intake",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check(
      "...and an id the caller does name is honoured rather than silently ignored",
      !named.isError && parseFormBlocks(bucket.text("3-resources/named.md") || "")[0]?.config?.id === "client-intake"
    );

    const answered = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/intake.md",
      values: pairs({ who: "Jordan", kind: "Brand film" }),
    });
    check("a member can answer the form it made", !answered.isError);

    const again = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/intake.md",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check("create_form never overwrites a note that exists", again.isError && /already exists/.test(again.text));
    check(
      "...so the note it would have replaced still carries the form it was made with",
      parseFormBlocks(bucket.text("3-resources/intake.md") || "")[0]?.config?.fields?.length === 3
    );
    check(
      "...and the answer already filed is still there",
      (bucket.text("3-resources/intake-responses.md") || "").includes("Jordan")
    );

    const onItself = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/self.md",
      responses: "3-resources/self.md",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check(
      "a form may not collect into its own page, which is where the whole design starts",
      onItself.isError && /note of their own/.test(onItself.text)
    );

    const reserved = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/reserved.md",
      fields: [{ name: "votes", type: "line", max: 5 }],
    });
    check(
      "a field named after a column this gateway writes is refused by the same parser as ever",
      reserved.isError && /is a column this gateway writes/.test(reserved.text)
    );
    check(
      "...and a refused form writes nothing at all",
      bucket.text("3-resources/reserved.md") === undefined
    );

    const uncapped = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/uncapped.md",
      fields: [{ name: "x", type: "line" }],
    });
    check("a line field with no cap is refused, naming the fix", uncapped.isError && /needs max/.test(uncapped.text));

    const byMember = await call(env, MEMBER_TOKEN, "create_form", {
      path: "3-resources/by-member.md",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check(
      "a member may answer a form and may not make one: this is a note write",
      byMember.isError && bucket.text("3-resources/by-member.md") === undefined
    );
    const byReadOnly = await call(env, READONLY_TOKEN, "create_form", {
      path: "3-resources/by-readonly.md",
      fields: [{ name: "x", type: "line", max: 5 }],
    });
    check("and a read-only grant may not either", byReadOnly.isError);

    /*
      THE ANSWERS LINE IS A READ OF `privacy.md`, SO IT ANSWERS AT THE
      CALLER'S TIER.

      `create_form` closes by naming where answers land and who can read
      them, which is right and is the reason the tool is safe to offer: an
      agent that assumed "private because the form is private" would tell
      somebody their client intake is confidential when the folder default
      says otherwise.

      But `responses` is a path the CALLER names, and the line is printed
      whether or not the collection was permitted. `mayCollectResponsesAt`
      already refuses a team connection every destination that is not
      `team` — and the refusal was followed by a sentence stating the rule
      that did the refusing. A team connection cannot read `privacy.md`
      (`read_note` answers `not found`), and no other tool at that tier
      names a folder's rule or a group: `scope_info`, `orient` and
      `list_notes` were each checked and name neither.

      So the line answered, one path per call, a question the manifest is
      closed to — and in the third branch it read back the group's own name.
      It is now printed only where the caller could have established it
      anyway, which is exactly where the collection is allowed.
    */
    const intoPrivate = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/probe-private.md",
      fields: [{ name: "x", type: "line", max: 5 }],
      responses: "2-areas/answers.md",
    });
    check(
      "a team connection is not told the privacy rule of a path it cannot collect into",
      !intoPrivate.isError &&
        !/\(private\)/.test(intoPrivate.text) &&
        !/only this context's owner/i.test(intoPrivate.text)
    );
    check(
      "...and is still told plainly that nothing is collecting",
      /cannot collect responses there/.test(intoPrivate.text)
    );

    const intoGroup = await call(env, EDITOR_TOKEN, "create_form", {
      path: "3-resources/probe-group.md",
      fields: [{ name: "x", type: "line", max: 5 }],
      responses: "2-areas/leads-answers.md",
    });
    check(
      "...and never reads back the name of a group it cannot see",
      !intoGroup.isError && !/@supa-leads/.test(intoGroup.text)
    );

    /*
      Non-vacuity, and the half that must survive: the sentence exists for
      the person who is about to collect answers somewhere, and an owner is
      still told where that is and who can read it.
    */
    const ownerForm = await call(env, OWNER_TOKEN, "create_form", {
      path: "2-areas/owner-form.md",
      fields: [{ name: "x", type: "line", max: 5 }],
      responses: "2-areas/owner-answers.md",
      visibility: "private",
    });
    check(
      "a personal connection is still told where the answers land and who reads them",
      !ownerForm.isError &&
        /answers go to: 2-areas\/owner-answers\.md \(private\)/.test(ownerForm.text) &&
        /only this context's owner/i.test(ownerForm.text)
    );
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
}
