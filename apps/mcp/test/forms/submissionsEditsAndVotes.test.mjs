/**
 * Markdown forms: permissions, through the worker — an editor creates forms
 * and their response files are created for them, and a note carrying a form
 * that does not parse is refused at the write (§1); a member is offered the
 * submission tools and a read-only connection is offered none (§2); a
 * member submits (the refusal cost for a hidden note equals the cost for an
 * absent one, and a submission lands attributed under the submitter's own
 * username) and a form that names somebody tells the control plane exactly
 * once, with identifiers only (§3-3b); a submission cannot forge a second
 * response, a vote, or an attribution by mimicking the file's own structure
 * (§4); editing and retracting (a submission cannot name the identity it is
 * recorded under, a member cannot edit another person's response, `edit_own:
 * false` stops even the author, an editor can retract anybody's) (§5); and
 * votes (idempotent, withdrawable, refused where a form turned them off)
 * (§6).
 *
 * Split out of forms.test.mjs; see fixtures.mjs for `createFormsHarness` and
 * the shared note fixtures. This is one continuous scenario — later checks
 * read state (a response's id, the file's accumulated responses) that
 * earlier ones left in `harness.bucket` — confirmed by tracing every
 * `reparsed`/`config`/`editorId`/`otherMemberId` reference before splitting,
 * not assumed from the section comments.
 */

import {
  BUGS_NOTE,
  EDITOR_TOKEN,
  GUEST_TOKEN,
  MEMBER_TOKEN,
  NAMELESS_TOKEN,
  READONLY_TOKEN,
  REQUESTS_NOTE,
  STAFF_NOTE,
  call,
  pairs,
  parseFormBlocks,
  parseResponsesFile,
  rpc,
} from "./fixtures.mjs";

export async function runFormSubmissionsEditsAndVotesChecks(check, harness) {
  const { bucket, controlPlane, env } = harness;

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
  // connection covers its person's own workspace, which they own and may write.
  // The listing has never been the control — the per-call gate below is, and
  // it reads the role in the context the call was routed to.
  check("...alongside write_note, which they may use in their own workspace", names.has("write_note"));

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

  /*
    THE FORM DOOR REFUSES AT ONE PRICE.

    `resolveForm` is the read half of every form mutation, and it carries the
    shape the read tools were equalised for:

      if (!canSee(path, ...)) return { refusal: toolError("not found") };
      const object = await getWithLegacyFallback(store, path);
      if (!object) return { refusal: toolError("not found") };

    A member is the right caller: `3-resources` is team so the folder is
    theirs to see, and `3-resources/private-notes.md` carries an exact
    override that holds that one note back. An exact override is written only
    when somebody deliberately singled a note out, which is the bit the cost
    would be handing over.

    The wording check beside the cost one is load-bearing, not decoration.
    This measurement was attempted first in the group-privacy suite and was
    VACUOUS three times over — an actor with no username, then two argument
    shapes the schema refuses — each time reporting equal costs for a door
    that never opened.
  */
  const formRefusalCost = async (path) => {
    const before = bucket.trips();
    const answer = await call(env, MEMBER_TOKEN, "submit_form", {
      path,
      values: pairs({ summary: "probe" }),
    });
    return { trips: bucket.trips() - before, text: answer.text };
  };
  const formHidden = await formRefusalCost("3-resources/private-notes.md");
  const formAbsent = await formRefusalCost("3-resources/no-such-note.md");
  check(
    "submit_form: both answers are the same refusal, so only the cost could tell them apart",
    formHidden.text === formAbsent.text && /not found/.test(formHidden.text)
  );
  check(
    `submit_form: refusing a note it may not see costs what refusing an absent one costs `
      + `(hidden: ${formHidden.trips}, absent: ${formAbsent.trips})`,
    formHidden.trips === formAbsent.trips
  );

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

  /* -- (3b) a form that names somebody tells the control plane ------------ */
  //
  // The gateway's half of "anytime there is a submission". The console and a
  // published collect link are both written by `runFileOperation`, which
  // schedules the notification itself; `submit_form` never touches the
  // control plane, so without the call this checks, answering a form through
  // an AI client would be the one way of answering that told nobody.
  {
    const noteBody = [
      "```form",
      "id: told",
      "responses: 3-resources/told.responses.md",
      "layout: table",
      "submit: member",
      "votes: named",
      "notify: owner",
      "fields:",
      "  - { name: summary, type: line, max: 120, required: true }",
      "```",
    ].join("\n");
    await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/told.md",
      content: noteBody,
      visibility: "team",
      confirm_team_publish: true,
    });
    const before = controlPlane.calls.filter((c) => c.path === "/gateway/forms/notify").length;
    const told = await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/told.md",
      values: pairs({ summary: "the thing that broke" }),
    });
    check("a submission to a form that names somebody is accepted", !told.isError);
    const reported = controlPlane.calls.filter((c) => c.path === "/gateway/forms/notify");
    check("...and the gateway tells the control plane exactly once", reported.length === before + 1);

    const body = reported[reported.length - 1]?.body ?? {};
    check("...naming the person the block named", body.to === "owner");
    check("...and the form, the note and the response", body.formId === "told" && body.notePath === "3-resources/told.md" && /^r-[0-9a-f]{8}$/.test(body.responseId || ""));
    /*
      IDENTIFIERS ONLY, AND THIS IS THE CHECK THAT SAYS SO.

      What the submitter typed stays in the customer's bucket; the control
      plane reads it back at delivery, as the recipient. Sending it here
      would put note content in a scheduled job's arguments, which Convex
      persists until the job runs — the one thing non-negotiable #1 is
      absolute about. Asserted on the serialised body rather than on a field
      list, because the failure to catch is a value arriving *somewhere* in
      it, under whatever name a future edit gives it.
    */
    check(
      "...and no answer of theirs is in what was sent",
      !JSON.stringify(body).includes("the thing that broke")
    );

    const voteId = /submitted: (r-[0-9a-f]{8})/.exec(told.text)?.[1];
    await call(env, MEMBER_TOKEN, "vote_form", { path: "3-resources/told.md", response_id: voteId });
    await call(env, MEMBER_TOKEN, "update_submission", {
      path: "3-resources/told.md",
      response_id: voteId,
      values: pairs({ summary: "the thing that broke, again" }),
    });
    await call(env, MEMBER_TOKEN, "retract_submission", {
      path: "3-resources/told.md",
      response_id: voteId,
    });
    check(
      "a vote, an edit and a retraction tell nobody — each is a change to an answer already announced",
      controlPlane.calls.filter((c) => c.path === "/gateway/forms/notify").length === before + 1
    );

    const quiet = controlPlane.calls.filter((c) => c.path === "/gateway/forms/notify").length;
    // Its own note rather than a submission to `bugs.md`: the fixtures that
    // follow count the responses in that file, and a control that changed
    // them would be this test breaking another one to prove itself.
    await call(env, EDITOR_TOKEN, "write_note", {
      path: "3-resources/untold.md",
      content: noteBody.replace("id: told", "id: untold")
        .replace("3-resources/told.responses.md", "3-resources/untold.responses.md")
        .replace("notify: owner\n", ""),
      visibility: "team",
      confirm_team_publish: true,
    });
    await call(env, MEMBER_TOKEN, "submit_form", {
      path: "3-resources/untold.md",
      values: pairs({ summary: "a form that names nobody" }),
    });
    check(
      "...and a form with no notify line reports nothing at all",
      controlPlane.calls.filter((c) => c.path === "/gateway/forms/notify").length === quiet
    );
  }

  const readonlySubmit = await call(env, READONLY_TOKEN, "submit_form", {
    path: "3-resources/bugs.md",
    values: pairs({ summary: "from a read-only client" }),
  });
  check("a read-only grant is refused even though its person is a member", readonlySubmit.isError);
  check(
    "...and nothing of theirs reaches the file",
    !(bucket.text("3-resources/bugs.responses.md") || "").includes("from a read-only client")
  );

  /*
    AND THE SAME PREDICATE, FROM THE SIDE THAT WRITES IT DOWN FOR GOOD.

    `personalNameFor`'s three clauses had exactly one set of guards, all of
    them in `presence.test.mjs`: dropping `role === "owner"` reddens two
    caret checks, dropping `kind === "personal"` two more, dropping the slug
    check one — and **nothing on this side moved**, though this is where the
    name stops being a label on a cursor and becomes `by` in a file in the
    customer's bucket, and the value an ownership test compares when
    somebody edits or withdraws a response.

    One predicate with guards in one suite is one refactor away from having
    none. So the clause the guest-wearing-the-host's-handle defect turned on
    is checked here too, through the door that keeps what it writes.
  */
  const guestSubmit = await call(env, GUEST_TOKEN, "submit_form", {
    // `requests`, not `bugs`: the checks below count `bugs`' responses, and a
    // guard that shifts a neighbour's arithmetic is a guard somebody deletes.
    path: "3-resources/requests.md",
    values: pairs({ title: "a guest of the host answers", area: "mcp" }),
  });
  check("a guest in somebody's personal context can submit", !guestSubmit.isError);
  check(
    "...recorded under their OWN handle, not the host's",
    /recorded as: @guest\b/.test(guestSubmit.text) && !/recorded as: @host\b/.test(guestSubmit.text)
  );
  check(
    "...and the file keeps their handle rather than the host's",
    (bucket.text("3-resources/requests.responses.md") || "").includes("@guest") &&
      !(bucket.text("3-resources/requests.responses.md") || "").includes("@host")
  );

  /*
    THE NAME FLOOR, WHICH NOTHING CHECKED.

    `mutateFormResponses` refuses before anything else when the caller has no
    handle, and `FORM_TOOLS`' own docblock leans on it by name — a listing
    branch is unnecessary, it argues, because such a connection's submissions
    are the ones "`mutateFormResponses` then refuses for want of a name".
    Deleting that refusal reddened **nothing** across the whole gateway suite,
    because every grant in this file was given a personal context of its own.

    What the floor prevents is not a missing byline. A response is stamped
    `by: actor.name`, and `mayChangeResponse` lets a non-editor act on a
    response when `response.by === actor.name`. With the floor gone, two
    different people with no handle would both stamp `by: null` and both match
    each other's rows — one identity for everybody who has none, each able to
    edit and retract the others' answers — a missing identity used as an
    identity, which is the same mistake as reading a name off a context the
    caller does not own.
  */
  const namelessSubmit = await call(env, NAMELESS_TOKEN, "submit_form", {
    path: "3-resources/bugs.md",
    values: pairs({ summary: "from a caller with no handle" }),
  });
  check(
    "a caller with no handle is refused, because a response records who",
    namelessSubmit.isError === true && /username/i.test(namelessSubmit.text)
  );
  check(
    "...and nothing of theirs reaches the file",
    !(bucket.text("3-resources/bugs.responses.md") || "").includes("from a caller with no handle")
  );
  check(
    "...and no row in it is attributed to nobody",
    !/· *(null|undefined) *·/.test(bucket.text("3-resources/bugs.responses.md") || "")
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
}
