/**
 * "Whose file it is": between the markers is the machine's, everything else
 * is yours — and what the console says when somebody edits the machine's
 * half. See activity.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import { ACTIVITY_PATH, change, entryFor, parseFile, renderFile, repairPrompt, strayRows } from "./fixtures.mjs";

export async function runActivityFileIdentityChecks(check) {
  /*
    THE CLAIM THE CONSOLE MAKES ABOUT THIS FILE, CHECKED.

    The page says "a note in your own storage", and the console now lets an
    owner open its Markdown and type in it. That promise is only worth
    anything if a write by an agent thirty seconds later does not flatten what
    they wrote — which is exactly what `renderFile` did before this: it
    rebuilt the file from `HEADER` every time, so the honest description of
    the old behaviour was "you may edit this until something happens".

    The contract is one sentence: **between the markers is the machine's,
    everything else is yours.**
  */
  {
    const one = entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true }));
    const fresh = renderFile([one]);
    check("a first render lays down the header", fresh.includes("role: activity"));
    /*
      THE CHECK THAT CAUGHT THE ONE REAL BUG IN THIS CHANGE.

      The first splice trimmed the text above the marker and let a join put a
      newline back, which ate the blank line above it. Every other check here
      passed — the prose survived, the entries parsed, and a *second* render
      was stable, because the damage was done once and then settled. So the
      property to assert is not "stable eventually" but "changes nothing at
      all": a file Context wrote and nobody has touched must come back byte
      for byte, or the first write after a deploy silently reflows a header in
      the one file whose promise is that Context leaves your text alone.
    */
    check("an untouched file is byte-identical after a re-render", renderFile([one], fresh) === fresh);
    check(
      "and declares itself a page to read, for this console and for Obsidian",
      fresh.includes("view: read"),
    );

    const mine =
      fresh.replace("# Activity", "# Activity\n\nA paragraph I wrote myself.") +
      "\nAnd a line after the end marker.\n";
    const two = entryFor(change("create_note", ["1-projects/beta.md"], { team_visible: true }));
    const after = renderFile([two, one], mine);
    check("a later write keeps prose above the markers", after.includes("A paragraph I wrote myself."));
    check(
      "and keeps what is below them",
      after.includes("And a line after the end marker."),
    );
    check("while the machine's region is rebuilt", after.includes("1-projects/beta.md"));
    check(
      "and the whole file is stable under a re-render",
      renderFile([two, one], after) === after,
    );
    check("and still parses to both entries", parseFile(after).length === 2);

    // The one shape `splitAround` refuses to guess at, stated rather than
    // discovered: no markers, so no boundary, so a fresh header rather than a
    // silent decision about where somebody's text ended.
    const noMarkers = "# My own activity file\n\nnothing else\n";
    const rebuilt = renderFile([one], noMarkers);
    check("a file with no markers gets a fresh header", rebuilt.includes("role: activity"));
    check("rather than a guess at where the region was", parseFile(rebuilt).length === 1);
  }

  /*
    AND WHAT THE CONSOLE SAYS WHEN SOMEBODY EDITS THE MACHINE'S HALF.

    Nothing refuses the edit. What must not happen is silence: rows vanish
    from the list, and a person who was not told why concludes the product ate
    them.
  */
  {
    const one = entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true }));
    const file = renderFile([one]);
    check("a file Context wrote has nothing stray in it", strayRows(file) === 0);
    check(
      "editing a row's words is not stray — the comment is what is read",
      strayRows(file.replace("added", "ADDED, by my own hand")) === 0,
    );
    check(
      "deleting a row's comment is",
      strayRows(file.replace(/ <!--ctx[\s\S]*?-->/, "")) === 1,
    );
    check(
      "and so is breaking the JSON inside one",
      strayRows(file.replace("<!--ctx ", "<!--ctx {{{")) === 1,
    );
    check(
      "a bullet written outside the markers is the owner's and is left alone",
      strayRows(file.replace("# Activity", "# Activity\n\n- my own bullet")) === 0,
    );
    check("and a file with no markers at all has nothing to be stray in", strayRows("# hi\n") === 0);

    /*
      The prompt is handed over rather than a button pressed. A one-press
      "fix" that deletes what somebody typed is the product taking the file
      back the moment it looks untidy — in the one feature whose whole subject
      is that the file is theirs. So what is asserted is that it names the
      rule, and that it tells the client **not** to invent the one thing it
      must never invent: a `<!--ctx -->` comment is the record, and a
      fabricated one is a fabricated fact about somebody's context.
    */
    const prompt = repairPrompt();
    check("the repair prompt names the file", prompt.includes(ACTIVITY_PATH));
    check("and both markers, so the client can find the region", prompt.includes("BEGIN CONTEXT ACTIVITY") && prompt.includes("END CONTEXT ACTIVITY"));
    check("and forbids inventing a record", /[Dd]o not invent/.test(prompt));
    check("and carries no path, name or content from anybody's context", !/@|1-projects|0-inbox/.test(prompt));
  }
}
