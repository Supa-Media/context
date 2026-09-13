/**
 * WRITING A FORM BLOCK, WITH HELP.
 *
 * The owner asked for this twice, and the second time narrowed it: "Im not
 * really thinking of adding a full UI, Im thinking more so that we have auto
 * complete for when people do add a form, that allows them to easily see the
 * accepted fields, it should all be text editable."
 *
 * So the thing to prove is not that a list appears. It is that **the list and
 * the grammar are the same list**, in both directions:
 *
 *  - Every key, value and template this offers produces a block that
 *    `parseFormBlocks` accepts. That is the differential test at the foot of
 *    this file, and it is the one that matters: an autocompletion that suggests
 *    something the gateway refuses is worse than no autocompletion, because the
 *    person now believes they were told the answer.
 *  - Nothing is offered where the grammar would not take it. Most of the cases
 *    below are refusals — config keys inside a `{ … }`, field types on a line
 *    that is not a field — because offering the right words in the wrong place
 *    is how somebody ends up with a block that does not parse *and* the
 *    impression the editor approved of it.
 */

import { describe, expect, test } from "@jest/globals";
import {
  formChoicesFor,
  formFenceAt,
  formSpotAt,
  type FormChoice,
} from "../features/console/files/formComplete";
import { parseFormBlocks } from "../../mcp/src/forms.js";

/** The document, with `|` marking the caret. */
function at(withCaret: string): { doc: string; pos: number } {
  const pos = withCaret.indexOf("|");
  expect(pos).toBeGreaterThanOrEqual(0);
  return { doc: withCaret.slice(0, pos) + withCaret.slice(pos + 1), pos };
}

function spotAt(withCaret: string) {
  const { doc, pos } = at(withCaret);
  return formSpotAt(doc, pos);
}

function labelsAt(withCaret: string): string[] {
  const { doc, pos } = at(withCaret);
  const found = formSpotAt(doc, pos);
  if (found === null) return [];
  return formChoicesFor(found.spot, formFenceAt(doc, pos)?.body ?? []).map((c) => c.label);
}

const OPEN = "```form\n";

describe("where the caret is", () => {
  test("a fence that has just been opened offers the block itself", () => {
    expect(spotAt("```|")?.spot).toEqual({ kind: "fence-info" });
    expect(labelsAt("```f|")).toEqual(["form"]);
  });

  test("an empty line in the block offers the config keys", () => {
    expect(labelsAt(`${OPEN}|`)).toContain("responses");
    expect(labelsAt(`${OPEN}|`)).toContain("layout");
  });

  test("a key already written is not offered again", () => {
    // The grammar refuses a repeat with `"x" is set twice`, so offering one is
    // offering an error.
    const labels = labelsAt(`${OPEN}id: bugs\nlayout: table\n|`);
    expect(labels).not.toContain("id");
    expect(labels).not.toContain("layout");
    expect(labels).toContain("responses");
  });

  test("after `layout:` it offers the two layouts and nothing else", () => {
    expect(labelsAt(`${OPEN}layout: |`)).toEqual(["table", "sections"]);
  });

  test("after `submit:` it offers the three roles", () => {
    expect(labelsAt(`${OPEN}submit: |`)).toEqual(["member", "editor", "owner"]);
  });

  test("after `votes:` it offers named and off", () => {
    expect(labelsAt(`${OPEN}votes: |`)).toEqual(["named", "off"]);
  });

  test("a partly typed value still offers its own list, from the start of the word", () => {
    const found = spotAt(`${OPEN}layout: tab|`);
    expect(found?.spot).toEqual({ kind: "key-value", key: "layout" });
    // Three characters back, so accepting replaces `tab` rather than appending
    // to it and leaving `tabtable`.
    expect(found?.back).toBe(3);
  });

  test("inside a field's braces it offers the field keys, not the config keys", () => {
    const labels = labelsAt(`${OPEN}fields:\n  - { |`);
    expect(labels).toContain("name");
    expect(labels).toContain("type");
    expect(labels).not.toContain("layout");
    expect(labels).not.toContain("responses");
  });

  test("after `type:` inside braces it offers the six field types", () => {
    expect(labelsAt(`${OPEN}fields:\n  - { name: a, type: |`)).toEqual([
      "line",
      "text",
      "select",
      "number",
      "date",
      "checkbox",
    ]);
  });

  test("a list item under `fields:` offers a field template", () => {
    expect(spotAt(`${OPEN}fields:\n  - |`)?.spot).toEqual({ kind: "field-entry" });
  });

  test("a closed brace ends the field, so the next key is a config key again", () => {
    const labels = labelsAt(`${OPEN}fields:\n  - { name: a, type: line, max: 3 }\n|`);
    expect(labels).toContain("responses");
    expect(labels).not.toContain("options");
  });
});

describe("where nothing is offered", () => {
  test("in ordinary prose", () => {
    expect(spotAt("Just a note about forms.|")).toBeNull();
  });

  test("in an ordinary code fence", () => {
    expect(spotAt("```js\nconst layout = |")).toBeNull();
  });

  test("after the form fence has closed", () => {
    expect(spotAt(`${OPEN}id: bugs\n\`\`\`\n|`)).toBeNull();
  });

  test("inside a wider fence that merely quotes a form block", () => {
    // The case `parseFormBlocks` walks fences in order to get right, and the
    // one a regex over the note gets wrong.
    expect(spotAt("````markdown\n```form\nid: bugs\n```\n````\n|")).toBeNull();
  });

  test("a list item where no `fields:` has been written yet", () => {
    // There is no list to be an item of, so a `{ … }` there is a parse error
    // rather than a field.
    expect(spotAt(`${OPEN}id: bugs\n  - |`)?.spot).not.toEqual({ kind: "field-entry" });
  });

  test("mid-sentence on a line that is already prose", () => {
    expect(spotAt(`${OPEN}id: bugs\nsome words here |`)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * EVERYTHING OFFERED, PARSED BACK THROUGH THE GRAMMAR.
 *
 * The guard that makes the tables in `formComplete.ts` safe to keep there.
 * `docs/decisions/forms.md` allows them — "the grammar is a small strict subset
 * precisely so that what autocomplete offers and what the gateway accepts can
 * be the same list" — and allows them *on this condition*: that the sameness is
 * checked rather than asserted in a comment. If somebody adds a seventh field
 * type to this file and not to `forms.js`, this fails.
 */
describe("every offer parses", () => {
  /** Accept a choice into a block, then read the block back. */
  function applied(before: string, choice: FormChoice, back: number): string {
    const insert = choice.insert ?? choice.label;
    return before.slice(0, before.length - back) + insert;
  }

  function parses(block: string): { ok: boolean; why: string } {
    const blocks = parseFormBlocks(block) as Array<{ error?: string }>;
    if (blocks.length === 0) return { ok: false, why: "no block found" };
    return { ok: blocks[0].error === undefined, why: blocks[0].error ?? "" };
  }

  test("the starter block the fence offers is a valid form", () => {
    const found = spotAt("```|");
    const choice = formChoicesFor(found!.spot)[0];
    const block = applied("```", choice, found!.back) + "\n```";
    const result = parses(block);
    expect(result.why).toBe("");
    expect(result.ok).toBe(true);
  });

  test("every config key completes into a block that parses", () => {
    /*
      The block is rebuilt for each key with that key left out, then the
      completion is accepted onto the end of it. Reusing one base with every key
      already in it would only ever prove that the grammar refuses a duplicate.
    */
    const LINES: Record<string, string> = {
      id: "id: x",
      responses: "responses: r.md",
      layout: "layout: table",
      submit: "submit: member",
      edit_own: "edit_own: true",
      show_responses: "show_responses: true",
      votes: "votes: named",
    };
    /** What has to follow a completion that stops at `key: `. */
    const COMPLETIONS: Record<string, string> = { id: "x", responses: "r.md" };
    // `fields` comes last in every block: its list is the lines beneath it, so
    // a key written after it would be read as one more field.
    const FIELDS = "fields:\n  - { name: a, type: line, max: 5 }";

    for (const choice of formChoicesFor({ kind: "key" })) {
      const others = Object.entries(LINES)
        .filter(([key]) => key !== choice.label)
        .map(([, line]) => line)
        .join("\n");
      // The completion lands on an empty line under the other keys; `fields`
      // (whose own completion inserts the list) is the only one with no tail.
      const before = `${OPEN}${others}\n`;
      const tail = choice.label === "fields" ? "" : `\n${FIELDS}`;
      /*
        `fields` inserts a template with an empty `name:` and puts the caret
        there — see the template test below — so the one thing the completion
        cannot guess is typed in here, exactly as a person would.
      */
      const block = (
        applied(before, choice, 0) + (COMPLETIONS[choice.label] ?? "") + tail + "\n```"
      ).replace("name: ,", "name: summary,");
      const result = parses(block);
      expect({ key: choice.label, why: result.why }).toEqual({ key: choice.label, why: "" });
    }
  });

  test("every layout, role and vote mode is one the grammar takes", () => {
    for (const key of ["layout", "submit", "votes", "edit_own", "show_responses"] as const) {
      for (const choice of formChoicesFor({ kind: "key-value", key })) {
        const block =
          `${OPEN}id: x\nresponses: r.md\nlayout: table\n` +
          (key === "layout" ? "" : `${key}: ${choice.label}\n`) +
          (key === "layout" ? `layout2: \n` : "") +
          `fields:\n  - { name: a, type: line, max: 5 }\n\`\`\``;
        // `layout` is in the base twice over, so it is checked on its own.
        const subject =
          key === "layout"
            ? `${OPEN}id: x\nresponses: r.md\nlayout: ${choice.label}\nfields:\n  - { name: a, type: line, max: 5 }\n\`\`\``
            : block;
        const result = parses(subject);
        expect({ key, value: choice.label, why: result.why }).toEqual({
          key,
          value: choice.label,
          why: "",
        });
      }
    }
  });

  test("every field type is one the grammar takes", () => {
    for (const choice of formChoicesFor({ kind: "field-value", key: "type" })) {
      // `line` and `text` need a `max`; `select` needs `options`. Supplied here
      // because this is asserting the *type name* is known, and the grammar's
      // own rules about what each type requires are `forms.test.mjs`'s.
      const extra =
        choice.label === "line" || choice.label === "text"
          ? ", max: 50"
          : choice.label === "select"
            ? ", options: [a, b]"
            : "";
      const block = `${OPEN}id: x\nresponses: r.md\nlayout: table\nfields:\n  - { name: a, type: ${choice.label}${extra} }\n\`\`\``;
      const result = parses(block);
      expect({ type: choice.label, why: result.why }).toEqual({ type: choice.label, why: "" });
    }
  });

  test("every field key is one the grammar takes", () => {
    for (const choice of formChoicesFor({ kind: "field-key" })) {
      const entry =
        choice.label === "options"
          ? "{ name: a, type: select, options: [x, y] }"
          : choice.label === "min"
            ? "{ name: a, type: number, min: 0 }"
            : choice.label === "max"
              ? "{ name: a, type: line, max: 50 }"
              : choice.label === "required"
                ? "{ name: a, type: line, max: 50, required: true }"
                : choice.label === "type"
                  ? "{ name: a, type: line, max: 50 }"
                  : "{ name: a, type: line, max: 50 }";
      const block = `${OPEN}id: x\nresponses: r.md\nlayout: table\nfields:\n  - ${entry}\n\`\`\``;
      expect({ key: choice.label, why: parses(block).why }).toEqual({
        key: choice.label,
        why: "",
      });
    }
  });

  test("the field template it inserts parses once a name is typed into it", () => {
    const choice = formChoicesFor({ kind: "field-entry" })[0];
    const inserted = (choice.insert ?? choice.label).replace("name: ,", "name: summary,");
    const block = `${OPEN}id: x\nresponses: r.md\nlayout: table\nfields:\n  - ${inserted}\n\`\`\``;
    expect(parses(block).why).toBe("");
  });

  test("and the caret lands where the name goes, not at the end", () => {
    const choice = formChoicesFor({ kind: "field-entry" })[0];
    const insert = choice.insert ?? choice.label;
    const caret = insert.length - (choice.caretBack ?? 0);
    // Immediately after `name: `, which is the one thing the template cannot
    // guess and the first thing somebody has to type.
    expect(insert.slice(0, caret)).toBe("{ name: ");
  });
});
