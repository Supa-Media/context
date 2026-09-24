/**
 * Markdown forms: the grammar, checked without a worker. A well-formed block
 * parses to a config with the right defaults; every malformed shape (an
 * unknown key, a missing layout, an uncapped line field, a field named after
 * a column the gateway writes, two fields sharing a name, an options-less
 * select, an unclosed fence) is refused by name; `create_form`'s render side
 * (a config renders back to the same block, twice, with option-list quoting
 * and line-break-forging both refused); who a form may notify (a handle or
 * "owner", never an address, on both the parse side and the render side); and
 * a form block quoted inside a longer fence is not itself a form.
 *
 * Split out of forms.test.mjs; see fixtures.mjs for the shared note fixtures.
 */

import { BUGS_NOTE, REQUESTS_NOTE, STAFF_NOTE, parseFormBlocks, renderFormBlock } from "./fixtures.mjs";

export async function runFormGrammarAndRenderingChecks(check) {
  /* ================= the grammar, checked without a worker ================= */

  {
    const blocks = parseFormBlocks(BUGS_NOTE);
    check("a well-formed form block parses to one config", blocks.length === 1 && !!blocks[0].config);
    check("...and keeps its declared layout rather than inferring one", blocks[0].config.layout === "sections");
    check("...and defaults edit_own to true", blocks[0].config.edit_own === true);
    check("...and hides responses unless opted in", blocks[0].config.show_responses === false);

    const noVotes = parseFormBlocks(STAFF_NOTE)[0].config;
    check("votes defaults are read, not guessed", noVotes.votes === "off" && noVotes.submit === "editor");
    check("response display can be opted into", parseFormBlocks(REQUESTS_NOTE)[0].config.show_responses === true);
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

  /* ------------- writing a block, which is the half that was missing ------- */
  //
  // `create_form` exists because an agent asked for "an intake form" had to
  // know this grammar by heart and hand-write it through `write_note`. The
  // tool holds the same line the four submission tools hold — no argument
  // reaches a file as text — which means the block is *rendered*, and a
  // renderer that can be talked into emitting a second key is the same
  // injection this file already tests for on the response side.
  {
    const config = parseFormBlocks(BUGS_NOTE)[0].config;
    const rendered = renderFormBlock(config);
    check("a parsed form renders back to a block", typeof rendered.text === "string");
    const reparsed = parseFormBlocks(rendered.text)[0];
    check(
      "...that parses to the same config",
      JSON.stringify(reparsed?.config) === JSON.stringify(config)
    );
    check(
      "...and renders identically the second time, which is what create_form checks",
      renderFormBlock(reparsed.config).text === rendered.text
    );

    const select = (options) =>
      renderFormBlock({ ...config, fields: [{ name: "x", type: "select", options }] });
    check(
      "an option holding a comma is refused, because the list is split on commas first",
      /comma or a square bracket/.test(select(["a, b"]).error || "")
    );
    check(
      "...and one holding a square bracket, which would end the list early",
      /comma or a square bracket/.test(select(["a]b"]).error || "")
    );
    // An option that OPENS with a quote is the fixture that decides the
    // quoting, and the only one: the scanner unquotes a list entry only when
    // it starts with `"`, so every other awkward character round-trips bare
    // and a "simplification" that emitted everything bare would pass without
    // this line — and turn this option into "the list has an unclosed quote".
    check(
      "an option that starts with a quote survives the round trip rather than breaking the list",
      parseFormBlocks(select(['"as sent" to me']).text)[0]?.config?.fields?.[0]?.options?.[0] ===
        '"as sent" to me'
    );
    check(
      "a line break in a value cannot forge a second key",
      /line break/.test(renderFormBlock({ ...config, responses: "a.md\nid: other" }).error || "")
    );
    check(
      "a form with no fields is refused rather than rendered empty",
      /at least one field/.test(renderFormBlock({ ...config, fields: [] }).error || "")
    );
  }

  /* ------------------- who a form tells, and what it refuses --------------- */
  //
  // `notify` is the only key that points *out* of the workspace, so the
  // grammar is where an address has to die. Everything below is one claim: a
  // block can name a person and cannot name a destination.
  //
  // The two halves are tested together on purpose. The parser refusing an
  // address is worth nothing if the renderer will write one — `create_form`
  // and the console's editor both go through `renderFormBlock`, so a value it
  // emits is a value the parser on the next read has to accept, and a
  // "simplification" that dropped the render-side check would leave the
  // refusal reachable only by hand-editing in Obsidian.
  {
    const config = parseFormBlocks(BUGS_NOTE)[0].config;
    const withNotify = (value) =>
      parseFormBlocks(BUGS_NOTE.replace("id: bugs", `id: bugs\nnotify: ${value}`))[0];

    check(
      "a form says nothing about notification unless it asks to",
      !("notify" in config)
    );
    check("owner is a notification target", withNotify("owner").config?.notify === "owner");
    check("...and so is a handle", withNotify("@dan").config?.notify === "@dan");
    check(
      "an email address is refused by the parser, in words that say what to write instead",
      /never an email address/.test(withNotify("dev@supa.media").error || "")
    );
    check(
      "...and a bare word that is not owner is refused rather than read as a handle",
      /never an email address/.test(withNotify("dan").error || "")
    );
    check(
      "...and a handle longer than the namespace allows",
      /never an email address/.test(withNotify(`@${"a".repeat(33)}`).error || "")
    );

    const rendered = renderFormBlock({ ...config, notify: "@dan" });
    check(
      "a notification target round-trips through the renderer",
      parseFormBlocks(rendered.text)[0]?.config?.notify === "@dan"
    );
    check(
      "...and a form that tells nobody renders no notify line at all",
      !renderFormBlock(config).text.includes("notify:")
    );
    // The renderer is the half an agent reaches. `create_form` takes a policy
    // rather than markdown precisely so that a tool argument cannot become a
    // line in the block; an address arriving as `notify` would be that, and
    // the refusal has to happen before the note is written rather than at the
    // send that never comes.
    check(
      "the renderer refuses an address too, rather than writing one for the server to drop later",
      /never an email address/.test(
        renderFormBlock({ ...config, notify: "dev@supa.media" }).error || ""
      )
    );
    check(
      "...and refuses a value carrying a line break, which would forge a second key",
      /never an email address/.test(
        renderFormBlock({ ...config, notify: "owner\nsubmit: owner" }).error || ""
      )
    );
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
}
