/**
 * WHAT A STRANGER SEES, AND WHAT THEY CANNOT SEND.
 *
 * `collectForm.ts` is the only logic between somebody with no account and a
 * write into somebody else's bucket, so what it *refuses to draw* matters more
 * than what it draws:
 *
 *  1. A block that did not parse is not a form. The reader cannot fix it and
 *     must not be collected from through it.
 *  2. A form only editors may answer is not drawn at all — the server refuses
 *     it through a link, and a Send button that is going to fail is worse than
 *     no Send button.
 *  3. What goes on the wire is the *validator's* normalization, never what was
 *     typed, so "valid here" and "valid there" cannot be two questions.
 */

import { describe, expect, test } from "@jest/globals";
import {
  blankAnswers,
  fieldLabel,
  formInFence,
  refusalText,
  sendable,
  type CollectForm,
} from "../features/share/collectForm";

const FENCE = [
  "id: intake",
  "responses: 1-projects/intake-responses.md",
  "layout: table",
  "submit: member",
  "votes: off",
  "fields:",
  "  - { name: who, type: line, max: 120, required: true }",
  "  - { name: budget, type: number, min: 0, max: 100000 }",
  "  - { name: kind, type: select, options: [Brand film, Event] }",
  "  - { name: nda, type: checkbox }",
  "  - { name: brief, type: text, max: 2000 }",
].join("\n");

function only(fence: string): CollectForm {
  const form = formInFence(fence);
  expect(form).not.toBeNull();
  return form!;
}

describe("which forms a stranger is shown", () => {
  test("the note's form, with its declared fields", () => {
    const form = only(FENCE);
    expect(form.id).toBe("intake");
    expect(form.fields.map((field) => field.name)).toEqual([
      "who",
      "budget",
      "kind",
      "nda",
      "brief",
    ]);
    expect(form.fields[0]!.required).toBe(true);
    expect(form.fields[2]!.options).toEqual(["Brand film", "Event"]);
  });

  test("a block that did not parse is not drawn as a half-built form", () => {
    // The grammar rejects it — `max` is mandatory on a line — and the reader
    // is not the author, so nothing is drawn rather than a form missing a rule
    // the answers file was built around.
    expect(formInFence(["id: oops", "fields:", "  - { name: x }"].join("\n"))).toBeNull();
  });

  test("a form only editors may answer is not drawn, because a link cannot answer it", () => {
    expect(formInFence(FENCE.replace("submit: member", "submit: editor"))).toBeNull();
  });

  test("a stray fence marker in the body refuses, rather than truncating", () => {
    /*
      `markdown.ts` accepts `~~~form` too, so a body really can arrive here
      with a bare ``` line in it. That line is never valid inside a form block,
      so the answer is always "this is not a form" — and the point of building
      the fence LONGER than anything inside is that the grammar sees the whole
      body and says so. Rebuild with a bare ``` and the fence closes at that
      line, the part above it parses as a complete form, and the page draws one
      missing every field below without a word.
    */
    const marker = "`".repeat(3);
    const truncating = [
      "id: intake",
      "responses: 1-projects/intake-responses.md",
      "layout: table",
      "submit: member",
      "fields:",
      "  - { name: who, type: line, max: 120, required: true }",
      marker,
      "  - { name: brief, type: text, max: 2000 }",
    ].join("\n");
    expect(formInFence(truncating)).toBeNull();
  });

  test("an empty fence, and one that is not a form at all", () => {
    expect(formInFence("")).toBeNull();
    expect(formInFence("just some words")).toBeNull();
  });
});

describe("what an empty form starts as", () => {
  test("every field has a value, so no box can lose what was typed in it", () => {
    const answers = blankAnswers(only(FENCE));
    expect(Object.keys(answers).sort()).toEqual(["brief", "budget", "kind", "nda", "who"]);
    for (const [name, value] of Object.entries(answers)) {
      expect([name, typeof value]).toEqual([name, "string"]);
    }
  });

  test("a checkbox starts as a word the validator knows, not as empty", () => {
    // "" is not one of a checkbox's two words, so an untouched checkbox would
    // refuse the whole submission if it started blank.
    expect(blankAnswers(only(FENCE)).nda).toBe("no");
    expect(sendable(only(FENCE), { ...blankAnswers(only(FENCE)), who: "Jordan" }).ok).toBe(true);
  });
});

describe("what goes on the wire", () => {
  const form = only(FENCE);

  test("the validator's normalization, never the raw boxes", () => {
    const result = sendable(form, {
      ...blankAnswers(form),
      who: "  Jordan  ",
      budget: " 4000 ",
      nda: "yes",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.values.map((v) => [v.field, v.value]));
    expect(byName.who).toBe("Jordan");
    expect(byName.budget).toBe("4000");
    expect(byName.nda).toBe("yes");
  });

  test("a required field left empty is refused here, and named", () => {
    const result = sendable(form, blankAnswers(form));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("who");
  });

  test("a number out of range is refused, with the bound in the sentence", () => {
    const result = sendable(form, { ...blankAnswers(form), who: "Jordan", budget: "999999" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("100000");
  });

  test("a select answer that is not one of its options is refused", () => {
    const result = sendable(form, { ...blankAnswers(form), who: "Jordan", kind: "Something else" });
    expect(result.ok).toBe(false);
  });

  test("a field the page does not know about cannot be smuggled in", () => {
    // The page sends its OWN declared fields, so an extra key in state is
    // dropped rather than forwarded. A form whose answers file grew a column
    // nobody declared is the shape this closes.
    const result = sendable(form, { ...blankAnswers(form), who: "Jordan", sneaky: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.map((v) => v.field)).not.toContain("sneaky");
  });
});

describe("what the person is told", () => {
  test("every refusal about the LINK says the same thing", () => {
    // Revoked, expired, never existed and not-collecting all arrive as one
    // code and must read as one sentence — a stranger holding a URL must not
    // be able to tell a link that was taken back from one that never was.
    expect(refusalText("LINK_NOT_COLLECTING", "revoked")).toBe(
      refusalText("LINK_NOT_COLLECTING", "never existed"),
    );
    expect(refusalText("LINK_NOT_COLLECTING", "")).not.toContain("revoked");
  });

  test("a fact about this submission is passed through as the server worded it", () => {
    expect(refusalText("CHALLENGE_REFUSED", "That check did not pass.")).toBe(
      "That check did not pass.",
    );
    expect(refusalText("FORM_INVALID", '"who" is required')).toBe('"who" is required');
  });

  test("a code nobody recognises still says something a person can act on", () => {
    expect(refusalText(null, "")).not.toBe("");
    expect(refusalText("SOMETHING_NEW", "")).not.toBe("");
  });
});

describe("a field's label", () => {
  test("reads as words, while the wire keeps the author's name", () => {
    expect(fieldLabel("client_name")).toBe("Client name");
    expect(fieldLabel("budget")).toBe("Budget");
    expect(fieldLabel("start-date")).toBe("Start date");
    expect(fieldLabel("")).toBe("");
  });
});
