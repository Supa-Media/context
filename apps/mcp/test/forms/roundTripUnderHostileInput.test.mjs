/**
 * Markdown forms: the round-trip, under hostile submissions. A table and a
 * sections file both survive an answer carrying every character that could
 * end a row or forge a column (pipes, backslashes, `<br>`, `&amp;`), and a
 * paragraph shaped exactly like the file's own structure (a section header,
 * a votes line, a trailing backslash) does not forge a second response or a
 * vote; a stamp that is not a handle (a published-link attribution carrying
 * a space) still round-trips, in both layouts, while the `·` delimiter
 * itself stays refused inside `by`; a response file with no marker, one
 * belonging to another form, one whose layout changed under it, or one
 * carrying the author's own prose around the table all refuse rather than
 * silently dropping what they hold; field validation (options, required,
 * length, unknown field, single-line); and a checkbox answer's two
 * vocabularies (`yes`/`no` from the file, `true`/`false`/a boolean from the
 * declaration) both round-trip to the same stored word.
 *
 * Split out of forms.test.mjs; see fixtures.mjs for the shared note fixtures.
 */

import {
  BUGS_NOTE,
  REQUESTS_NOTE,
  parseFormBlocks,
  parseResponsesFile,
  renderResponsesFile,
  validateSubmission,
} from "./fixtures.mjs";

export async function runFormRoundTripUnderHostileInputChecks(check) {
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
      // The same forgery wearing the shape `by` was widened for. A submitted
      // paragraph is escaped on the way in and read as content on the way out,
      // and that — not the narrowness of the header expression — is what stops
      // it; widening `by` must not quietly have made the escape the only thing
      // between a stranger's answer and a forged row under somebody's name.
      "## r-deadbeef · via @maya/intake · 2026-01-01T00:00Z",
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
    /*
      A STAMP IS NOT A HANDLE, AND THE SECTION HEADER HAS TO READ ONE BACK.

      Every `by` this suite had ever rendered was a handle: `@dan`, `@maya`,
      `@owner`. Usernames cannot hold a space, so `(\S+)` in the section
      header was a contract nothing violated — until the control plane began
      stamping an answer that arrived through a published link, which is a
      sentence rather than a name ("via @maya/intake"). The renderer writes it
      into the header unescaped; the parser then reads the file as having text
      before its first response, and refuses.

      What that costs is the whole file rather than one row: the response file
      is rewritten in full on every submission, edit, retraction and vote, so
      a single answer stamped this way stops the NEXT one from anybody —
      members and the owner's own console included — and the refusal blames
      prose the author never wrote.

      The layout is the dimension this held constant, which is why one answer
      through a link landed in every test there was and the second never got
      tried. So both layouts are checked here, on the same stamps.
    */
    const sections = parseFormBlocks(BUGS_NOTE)[0].config;
    const table = parseFormBlocks(REQUESTS_NOTE)[0].config;
    const stamps = ["via @maya/intake", "via a link to @maya", "@maya"];

    for (const by of stamps) {
      const response = {
        id: "r-0000000c",
        by,
        at: "2026-09-11T10:02Z",
        values: { summary: "a", severity: "minor", steps: "b" },
        votes: [],
      };
      const file = renderResponsesFile(sections, [response]);
      const back = parseResponsesFile(file, sections);
      check(`a sections response stamped ${by} parses back`, !back.error);
      check(
        `...carrying the stamp it was written with, not a prefix of it`,
        back.responses?.[0]?.by === by
      );
      check(
        `...and re-renders byte for byte`,
        !back.error && renderResponsesFile(sections, back.responses) === file
      );

      const tableFile = renderResponsesFile(table, [
        { ...response, values: { title: "a", area: "mcp" } },
      ]);
      const tableBack = parseResponsesFile(tableFile, table);
      check(`a table response stamped ${by} parses back`, !tableBack.error);
      check(`...carrying the same stamp`, tableBack.responses?.[0]?.by === by);
    }

    // The control: a header whose id is not one is still refused, so the
    // widened field has not turned every `## a · b · c` line into a response.
    const forged = [
      renderResponsesFile(sections, []).split("\n")[0],
      "",
      "## notanid · via @maya/intake · 2026-09-11T10:02Z",
      "",
      "- **summary:** forged",
    ].join("\n");
    check(
      "a section header whose id is not a response id is still refused, widened `by` or not",
      /is not a response id/.test(parseResponsesFile(forged, sections).error || "")
    );

    /*
      `·` IS THE DELIMITER, SO IT IS THE ONE CHARACTER `by` MAY NOT HOLD.

      Nothing this module writes can put one there — a handle is `[a-z0-9-]`
      and a link stamp is built from a handle and a slug — which is exactly why
      the bound needs a check rather than a sentence. Widen `by` to any
      character and this header still parses, silently, with the *timestamp*
      read out of the middle of somebody's name; the file then re-renders
      differently from how it arrived, which is the round-trip law broken
      quietly rather than loudly.
    */
    const ambiguous = [
      renderResponsesFile(sections, []).split("\n")[0],
      "",
      "## r-0000000c · a · b · 2026-09-11T10:02Z",
      "",
      "- **summary:** ambiguous",
    ].join("\n");
    check(
      "a section header with a delimiter inside `by` is refused, not re-split",
      parseResponsesFile(ambiguous, sections).error !== undefined
    );
    check(
      "...while the same header without one parses",
      parseResponsesFile(ambiguous.replace(" · a · b · ", " · a b · "), sections).error === undefined
    );
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

  /*
    A CHECKBOX ANSWER'S WORDS ARE THE ONES THE FILE HOLDS.

    Nothing anywhere tested a checkbox field, and the gap hid a bug in the one
    place it mattered: the answer went through `parseBool`, which reads the
    form *declaration*'s vocabulary (`required: true`), while the responses
    file stores `yes`/`no` and the console's own widget submits `yes`/`no`.
    Every form carrying a checkbox was unanswerable from the console, refused
    with a sentence naming two words nothing in the product shows.

    So both pairs are accepted and one pair is stored, and the round trip —
    submit, render, read back, resubmit — is what these check rather than the
    single hop that happened to work.
  */
  {
    const config = parseFormBlocks(
      [
        "```form",
        "id: nda",
        "responses: 3-resources/nda-responses.md",
        "layout: table",
        "fields:",
        "  - { name: who, type: line, max: 40, required: true }",
        "  - { name: agreed, type: checkbox }",
        "```",
      ].join("\n")
    )[0].config;

    const stored = validateSubmission(config, { who: "Jordan", agreed: "yes" });
    check("a checkbox accepts the word the file holds", stored.error === undefined);
    check("...and stores it as that word", stored.values?.agreed === "yes");

    const declared = validateSubmission(config, { who: "Jordan", agreed: "true" });
    check("...and the declaration's word too, meaning the same thing", declared.values?.agreed === "yes");
    check(
      "...with no/false both landing on no",
      validateSubmission(config, { who: "J", agreed: "no" }).values?.agreed === "no" &&
        validateSubmission(config, { who: "J", agreed: "false" }).values?.agreed === "no"
    );
    check(
      "...and an actual boolean, which is what a JSON client sends",
      validateSubmission(config, { who: "J", agreed: true }).values?.agreed === "yes"
    );
    check(
      "...case and padding are the person's typing, not a different answer",
      validateSubmission(config, { who: "J", agreed: " YES " }).values?.agreed === "yes"
    );
    check(
      "a word that is neither is refused, and the refusal names the words it takes",
      /must be yes or no/.test(validateSubmission(config, { who: "J", agreed: "maybe" }).error || "")
    );

    // The round trip: what the renderer wrote is what the validator accepts.
    const written = renderResponsesFile(config, [
      { id: "r-0000000a", by: "@maya", at: "2026-09-08T09:00Z", values: stored.values, votes: [] },
    ]);
    const readBack = parseResponsesFile(written, config);
    check("the rendered answer parses back", readBack.error === undefined);
    check(
      "...and resubmitting exactly what came out of the file is accepted",
      validateSubmission(config, readBack.responses[0].values).error === undefined
    );

    // And the declaration's own keys are UNCHANGED: `yes` is an answer's word,
    // never a block grammar word, and widening that would change a stable
    // storage format rather than fix a bug.
    check(
      "`edit_own: yes` is still not a form",
      parseFormBlocks(
        [
          "```form",
          "id: x",
          "responses: r.md",
          "edit_own: yes",
          "fields:",
          "  - { name: a, type: line, max: 5 }",
          "```",
        ].join("\n")
      )[0].error !== undefined
    );
  }
}
