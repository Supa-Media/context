/**
 * @jest-environment jsdom
 */

/**
 * MARKDOWN FORMS, IN THE EDITOR.
 *
 * The half a person sees: a ```` ```form ```` fence drawn as boxes you can fill
 * in and a button that sends them. `apps/mcp/test/forms.test.mjs` proves the
 * format and `apps/convex/__tests__/forms.test.ts` proves who may write to it;
 * this file proves the three things only the editor can get wrong.
 *
 *  1. **A form is drawn when the note is read and never while it is written.**
 *     Everywhere else in `livePreview.ts` markup comes back when the caret
 *     touches it, and a form cannot follow that rule — typing into a field *is*
 *     putting a caret somewhere, so a form that revealed on selection would
 *     turn back into a code fence the moment somebody used it. Read mode is the
 *     whole of the switch, and both directions are asserted.
 *  2. **A block that does not parse says so.** The owner's words: "if the
 *     formatting is off then we just show like, hey, we can't display because
 *     the formatting is off". Never a half-built form with the fields it
 *     managed to read — the same "inert rather than half-working" rule the
 *     gateway follows.
 *  3. **The widget survives the note changing around it.** `eq` compares the
 *     fence's text, so a keystroke in a paragraph three lines up must not tear
 *     down a form somebody is halfway through typing a bug report into. That is
 *     the failure that would be discovered by a customer rather than by us.
 *
 * What is deliberately *not* re-tested here: the grammar. Nothing in
 * `formBlock.ts` knows which keys a block accepts — it imports
 * `apps/mcp/src/forms.js` and asks — and a second table of "valid forms" in
 * this file would be a second grammar to drift from the first.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import {
  FormWidget,
  formFences,
  formHost,
  readFence,
  type FormHostContext,
  type FormOutcome,
  type FormSubmission,
} from "../features/console/files/formBlock";
import { decorationsFor, markdownLanguage } from "../features/console/files/livePreview";

const FORM = [
  "# Feedback",
  "",
  "```form",
  "id: bugs",
  "responses: bugs-responses.md",
  "layout: table",
  "submit: member",
  "edit_own: true",
  "show_responses: true",
  "votes: named",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "  - { name: detail, type: text, max: 2000 }",
  "  - { name: area, type: select, options: [app, gateway] }",
  "```",
  "",
  "Thanks.",
].join("\n");

/** A broken block: `layout` is required and `slartibartfast` is not a key. */
const BROKEN = ["```form", "id: bugs", "slartibartfast: yes", "```"].join("\n");

function stateFor(
  doc: string,
  options: { readOnly?: boolean; cursor?: number; host?: FormHostContext | null } = {},
): EditorState {
  const { readOnly = true, cursor, host } = options;
  return EditorState.create({
    doc,
    ...(cursor === undefined ? {} : { selection: { anchor: cursor } }),
    extensions: [
      markdownLanguage(),
      EditorState.readOnly.of(readOnly),
      ...(host === undefined ? [] : [formHost.of({ current: host })]),
    ],
  });
}

/** Every block-replacing widget in the decoration set, in document order. */
function widgets(state: EditorState): FormWidget[] {
  const found: FormWidget[] = [];
  decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
    const widget = (value.spec as { widget?: unknown }).widget;
    if (widget instanceof FormWidget) found.push(widget);
  });
  return found;
}

describe("when a form is drawn", () => {
  test("a read-only note draws it", () => {
    const fences = formFences(stateFor(FORM));
    expect(fences).toHaveLength(1);
    expect(fences[0].config?.id).toBe("bugs");
    expect(fences[0].error).toBeNull();
  });

  test("an editable note leaves it as source, wherever the caret is", () => {
    // Far from the fence, which is where every *other* preview in this editor
    // is drawn. A form is not, and this is the assertion that says so.
    expect(formFences(stateFor(FORM, { readOnly: false, cursor: 0 }))).toEqual([]);
    expect(formFences(stateFor(FORM, { readOnly: false, cursor: FORM.length }))).toEqual([]);
  });

  test("the replacement spans the whole fence, both backtick lines included", () => {
    const state = stateFor(FORM);
    const [fence] = formFences(state);
    expect(state.doc.sliceString(fence.from, fence.from + 7)).toBe("```form");
    expect(state.doc.sliceString(fence.to - 3, fence.to)).toBe("```");
  });

  test("an ordinary code fence is not a form", () => {
    const doc = ["```js", "const id = 'bugs';", "```"].join("\n");
    expect(formFences(stateFor(doc))).toEqual([]);
  });

  /*
    The case a regex over the whole note gets wrong, and the reason
    `parseFormBlocks` walks fences in order: a tutorial quoting a form block
    inside a wider fence is prose about forms, not a form.
  */
  test("a form block quoted inside a wider fence is not a form", () => {
    const doc = ["````markdown", "```form", "id: bugs", "```", "````"].join("\n");
    expect(formFences(stateFor(doc))).toEqual([]);
  });

  test("a fence indented inside a list item stays text", () => {
    // A block widget replaces whole lines and an indented fence does not
    // occupy them — the rule `htmlPreviews` states and this shares.
    const doc = ["- item", "  ```form", "  id: bugs", "  ```"].join("\n");
    expect(formFences(stateFor(doc))).toEqual([]);
  });
});

describe("a block that does not parse", () => {
  test("is reported rather than half-drawn", () => {
    const read = readFence(BROKEN);
    expect(read.config).toBeNull();
    expect(read.error).toContain("slartibartfast");
  });

  test("still replaces the fence, so the note says why instead of showing raw keys", () => {
    const state = stateFor(BROKEN);
    const [fence] = formFences(state);
    expect(fence.error).not.toBeNull();
    expect(fence.config).toBeNull();
  });

  test("the card names the trouble and the line", () => {
    const state = stateFor(`# Note\n\n${BROKEN}\n`);
    const [fence] = formFences(state);
    const dom = new FormWidget(fence, null).toDOM();
    expect(dom.className).toContain("cm-lp-form-broken");
    expect(dom.textContent).toContain("can’t be displayed");
    expect(dom.textContent).toContain("slartibartfast");
    // Line 3 of the note, which is where the fence opens — not line 1 of the
    // block, which is a number nobody can find in their editor.
    expect(dom.textContent).toContain("line 3");
  });

  test("and draws no input at all, which is what 'inert' means", () => {
    const state = stateFor(BROKEN);
    const dom = new FormWidget(formFences(state)[0], null).toDOM();
    expect(dom.querySelectorAll("input, textarea, select, button")).toHaveLength(0);
  });
});

describe("the drawn form", () => {
  function drawn(host: FormHostContext | null = null): HTMLElement {
    const state = stateFor(FORM, { host });
    return new FormWidget(formFences(state)[0], host === null ? null : { current: host }).toDOM();
  }

  test("draws one control per declared field, of the declared kind", () => {
    const dom = drawn();
    expect(dom.querySelector<HTMLInputElement>("#cm-form-bugs-summary")?.tagName).toBe("INPUT");
    expect(dom.querySelector<HTMLElement>("#cm-form-bugs-detail")?.tagName).toBe("TEXTAREA");
    expect(dom.querySelector<HTMLElement>("#cm-form-bugs-area")?.tagName).toBe("SELECT");
  });

  test("carries the field's own limit onto the control, so it is enforced as you type", () => {
    const dom = drawn();
    expect(dom.querySelector<HTMLInputElement>("#cm-form-bugs-summary")?.maxLength).toBe(120);
    expect(dom.querySelector<HTMLTextAreaElement>("#cm-form-bugs-detail")?.maxLength).toBe(2000);
  });

  test("offers every option and, on an optional select, the position that means none", () => {
    const select = drawn().querySelector<HTMLSelectElement>("#cm-form-bugs-area");
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "app",
      "gateway",
    ]);
  });

  /*
    A select option is the one string in a form block that a person writes
    freely and that reaches the screen verbatim. It goes through `textContent`
    like everything else here, so the characters are drawn as characters.
  */
  test("an option that looks like markup is drawn as text, not as markup", () => {
    const doc = [
      "```form",
      "id: x",
      "responses: r.md",
      "layout: table",
      "fields:",
      "  - { name: pick, type: select, options: ['<img src=x>'] }",
      "```",
    ].join("\n");
    const state = stateFor(doc);
    const [fence] = formFences(state);
    expect(fence.error).toBeNull();
    const dom = new FormWidget(fence, null).toDOM();
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.textContent).toContain("<img src=x>");
  });

  /**
   * A READER CAN SEE WHERE THEIR ANSWER IS GOING.
   *
   * `responses:` names a sister note, and that is the load-bearing half of the
   * whole design — who may read an answer is whatever visibility that one file
   * has. An author sees the key in the block. A reader saw a box and a Submit
   * button and had no way at all to find out which note their words land in,
   * which in a shared workspace is the thing they might reasonably want to
   * check before typing.
   */
  describe("the head says what the box is and where it sends", () => {
    test("the responses note is named to the person filling it in", () => {
      const head = drawn().querySelector<HTMLElement>(".cm-lp-form-head");
      expect(head).not.toBeNull();
      expect(head?.textContent).toContain("bugs-responses.md");
    });

    test("and the form is named by its own id, not by a guess at a title", () => {
      expect(drawn().querySelector<HTMLElement>(".cm-lp-form-kind")?.textContent).toContain("bugs");
    });

    /*
      Through `textContent` like every other string in this file. A path is
      author-supplied text reaching the screen, so the rule that holds for a
      select option holds here: there is no `innerHTML` in this widget.
    */
    test("a path that looks like markup is drawn as characters", () => {
      const doc = [
        "```form",
        "id: x",
        "responses: <img src=x onerror=alert(1)>.md",
        "layout: table",
        "fields:",
        "  - { name: a, type: line, max: 10 }",
        "```",
      ].join("\n");
      const state = stateFor(doc);
      const [fence] = formFences(state);
      // Whether the grammar accepts this path at all is `forms.js`'s call; what
      // is asserted here is that if it reaches the DOM it reaches it as text.
      if (fence.config === null) return;
      const dom = new FormWidget(fence, null).toDOM();
      expect(dom.querySelector("img")).toBeNull();
      expect(dom.textContent).toContain("<img src=x onerror=alert(1)>.md");
    });
  });

  /**
   * The count is a limit, and a limit read after the control it applies to is
   * one you find out about by running out of room. It shares the label's line.
   */
  test("the character count sits on the label's own row", () => {
    const top = drawn().querySelector<HTMLElement>(".cm-lp-form-top");
    expect(top?.querySelector(".cm-lp-form-label")).not.toBeNull();
    expect(top?.querySelector(".cm-lp-form-count")?.textContent).toBe("0 / 120");
  });

  test("says it cannot send when the surface has no host, rather than offering a dead button", () => {
    const dom = drawn(null);
    expect(dom.querySelector<HTMLButtonElement>(".cm-lp-form-submit")?.disabled).toBe(true);
    expect(dom.textContent).toContain("can’t send responses");
  });

  test("draws a readable response file underneath the form", async () => {
    const host: FormHostContext = {
      submit: async () => ({ ok: true, message: "Sent." }),
      readResponses: async () => ({
        ok: true,
        message: "",
        text: [
          "<!-- context:form responses id=bugs layout=table -->",
          "",
          "| Id | By | At | summary | detail | area | Votes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| r-1234abcd | @alex | 2026-09-13T03:20Z | Search is slow | | app | @sam |",
        ].join("\n"),
      }),
      vote: async () => ({ ok: true, message: "Vote added." }),
      update: async () => ({ ok: true, message: "Updated." }),
      retract: async () => ({ ok: true, message: "Deleted." }),
    };
    const dom = drawn(host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const responses = dom.querySelector(".cm-lp-form-responses");
    expect(responses?.textContent).toContain("Search is slow");
    expect(responses?.textContent).toContain("@alex");
    expect(responses?.textContent).toContain("@sam");
    expect(responses?.querySelectorAll("button")).toHaveLength(4);
  });

  test("does not claim private responses are empty", async () => {
    const host: FormHostContext = {
      submit: async () => ({ ok: true, message: "Sent." }),
      readResponses: async () => ({ ok: false, message: "not found" }),
      vote: async () => ({ ok: false, message: "not found" }),
    };
    const dom = drawn(host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.querySelector(".cm-lp-form-responses")).toBeNull();
    expect(dom.textContent).not.toContain("No responses");
  });

  test("does not read responses unless the form explicitly shows them", async () => {
    let reads = 0;
    const host: FormHostContext = {
      submit: async () => ({ ok: true, message: "Sent." }),
      readResponses: async () => {
        reads++;
        return { ok: true, text: "", message: "" };
      },
    };
    const hidden = FORM.replace("show_responses: true\n", "");
    const state = stateFor(hidden, { host });
    const dom = new FormWidget(formFences(state)[0], { current: host }).toDOM();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reads).toBe(0);
    expect(dom.querySelector(".cm-lp-form-responses")).toBeNull();
  });

  test("casts a vote and refreshes the visible voters", async () => {
    let voters = "—";
    const votes: unknown[] = [];
    const host: FormHostContext = {
      submit: async () => ({ ok: true, message: "Sent." }),
      readResponses: async () => ({
        ok: true,
        message: "",
        text: [
          "<!-- context:form responses id=bugs layout=table -->",
          "",
          "| Id | By | At | summary | detail | area | Votes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          `| r-1234abcd | @alex | 2026-09-13T03:20Z | Search is slow | | app | ${voters} |`,
        ].join("\n"),
      }),
      vote: async (vote) => {
        votes.push(vote);
        voters = "@seyi";
        return { ok: true, message: "Vote added." };
      },
    };
    const dom = drawn(host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    dom.querySelector<HTMLButtonElement>(".cm-lp-form-vote")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(votes).toEqual([{ formId: "bugs", responseId: "r-1234abcd", vote: "up" }]);
    expect(dom.querySelector(".cm-lp-form-voters")?.textContent).toBe("@seyi");
  });

  test("edits and deletes a response from the response row", async () => {
    let title = "Search is slow";
    let deleted = false;
    const updates: unknown[] = [];
    const retractions: unknown[] = [];
    const host: FormHostContext = {
      submit: async () => ({ ok: true, message: "Sent." }),
      readResponses: async () => ({
        ok: true,
        message: "",
        text: [
          "<!-- context:form responses id=bugs layout=table -->",
          "",
          "| Id | By | At | summary | detail | area | Votes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...(deleted
            ? []
            : [`| r-1234abcd | @seyi | 2026-09-13T03:20Z | ${title} | | app | — |`]),
        ].join("\n"),
      }),
      update: async (change) => {
        updates.push(change);
        title = change.values.find((entry) => entry.field === "summary")?.value ?? title;
        return { ok: true, message: "Updated." };
      },
      retract: async (change) => {
        retractions.push(change);
        deleted = true;
        return { ok: true, message: "Deleted." };
      },
    };
    const dom = drawn(host);
    await new Promise((resolve) => setTimeout(resolve, 0));

    dom.querySelector<HTMLButtonElement>(".cm-lp-form-edit")?.click();
    const summary = dom.querySelector<HTMLInputElement>("#cm-form-bugs-summary")!;
    expect(summary.value).toBe("Search is slow");
    summary.value = "Search is fast";
    dom.querySelector<HTMLButtonElement>(".cm-lp-form-submit")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates).toEqual([
      expect.objectContaining({ formId: "bugs", responseId: "r-1234abcd" }),
    ]);
    expect(dom.querySelector(".cm-lp-form-responses")?.textContent).toContain("Search is fast");

    const remove = dom.querySelector<HTMLButtonElement>(".cm-lp-form-delete")!;
    remove.click();
    expect(remove.textContent).toBe("Confirm delete");
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retractions).toEqual([{ formId: "bugs", responseId: "r-1234abcd" }]);
    expect(dom.querySelector(".cm-lp-form-responses")?.textContent).toContain("No responses yet");
  });
});

describe("submitting", () => {
  function mounted(submit: (s: FormSubmission) => Promise<FormOutcome>) {
    const host = { current: { submit } };
    const state = stateFor(FORM, { host: host.current });
    const dom = new FormWidget(formFences(state)[0], host).toDOM();
    return {
      dom,
      button: dom.querySelector<HTMLButtonElement>(".cm-lp-form-submit")!,
      status: dom.querySelector<HTMLElement>(".cm-lp-form-status")!,
      field: (name: string) => dom.querySelector<HTMLInputElement>(`#cm-form-bugs-${name}`)!,
    };
  }

  /** Let the click's promise chain settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("sends the field names and the typed answers, and nothing else", async () => {
    const sent: FormSubmission[] = [];
    const form = mounted(async (submission) => {
      sent.push(submission);
      return { ok: true, message: "Sent." };
    });
    form.field("summary").value = "Search is slow";
    form.button.click();
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].formId).toBe("bugs");
    expect(sent[0].values).toEqual([
      { field: "summary", value: "Search is slow" },
      { field: "detail", value: "" },
      { field: "area", value: "" },
    ]);
    /*
      No `by`, no `at`, no path. Identity is stamped by the server from the
      session — `docs/decisions/forms.md`, "Identity is stamped, never claimed"
      — and the note is the one the console has open. A widget that could name
      either would be the untrusted half of the app choosing them.
    */
    expect(Object.keys(sent[0])).toEqual(["formId", "values"]);
  });

  test("a required field that is empty is refused here, in the same words the server would use", async () => {
    let calls = 0;
    const form = mounted(async () => {
      calls += 1;
      return { ok: true, message: "Sent." };
    });
    form.button.click();
    await settle();

    expect(calls).toBe(0);
    expect(form.status.textContent).toContain("summary");
    expect(form.status.textContent).toContain("required");
    // Still pressable: a refusal it can fix is not a reason to take the button
    // away from somebody.
    expect(form.button.disabled).toBe(false);
  });

  test("a success clears the boxes and stops a second press", async () => {
    let calls = 0;
    const form = mounted(async () => {
      calls += 1;
      return { ok: true, message: "Sent. Thank you!" };
    });
    form.field("summary").value = "Search is slow";
    form.button.click();
    await settle();

    expect(form.status.textContent).toBe("Sent. Thank you!");
    expect(form.field("summary").value).toBe("");
    /*
      The response file has no idempotency key, so two presses are two rows.
      A slow network is exactly when somebody presses again, so the button does
      not come back.
    */
    form.button.click();
    await settle();
    expect(calls).toBe(1);
  });

  test("a refusal is shown and the button comes back", async () => {
    const form = mounted(async () => ({
      ok: false,
      message: "This form takes responses from editors of this context and above.",
    }));
    form.field("summary").value = "Search is slow";
    form.button.click();
    await settle();

    expect(form.status.textContent).toContain("editors of this context");
    expect(form.button.disabled).toBe(false);
    // The answer is still there. Somebody refused for a reason they may be able
    // to do something about should not have to retype their bug report.
    expect(form.field("summary").value).toBe("Search is slow");
  });

  test("a thrown failure is caught rather than left on 'Sending…'", async () => {
    const form = mounted(async () => {
      throw new Error("Network request failed");
    });
    form.field("summary").value = "Search is slow";
    form.button.click();
    await settle();

    expect(form.status.textContent).toBe("Network request failed");
    expect(form.button.disabled).toBe(false);
  });
});

describe("the widget is kept across an edit elsewhere", () => {
  /*
    THE FAILURE THIS PREVENTS IS LOSING SOMEBODY'S TYPING.

    `decorationsFor` runs on every transaction, so a new `FormWidget` is built
    constantly. CodeMirror keeps the mounted DOM only while `eq` says the widget
    has not changed — so if `eq` compared anything that moves (the parsed config
    is a fresh object every parse; the host is a ref), the form would be torn
    down and rebuilt with every keystroke in the note, and a half-written bug
    report would vanish as it was typed.
  */
  test("two widgets over the same fence are equal", () => {
    const a = formFences(stateFor(FORM))[0];
    const b = formFences(stateFor(FORM))[0];
    expect(new FormWidget(a, null).eq(new FormWidget(b, { current: null }))).toBe(true);
  });

  test("editing the prose around the form does not change the widget", () => {
    const before = formFences(stateFor(FORM))[0];
    const after = formFences(stateFor(FORM.replace("Thanks.", "Thanks!")))[0];
    expect(new FormWidget(before, null).eq(new FormWidget(after, null))).toBe(true);
  });

  test("editing the block itself does change it", () => {
    const before = formFences(stateFor(FORM))[0];
    const after = formFences(stateFor(FORM.replace("max: 120", "max: 200")))[0];
    expect(new FormWidget(before, null).eq(new FormWidget(after, null))).toBe(false);
  });

  test("the same form source in a different note does not keep old responses", () => {
    const fence = formFences(stateFor(FORM))[0];
    const first = new FormWidget(fence, { current: null, generation: 1 });
    const second = new FormWidget(fence, { current: null, generation: 2 });
    expect(first.eq(second)).toBe(false);
  });
});

describe("in the decoration set", () => {
  test("the form is a block replacement over the fence", () => {
    const state = stateFor(FORM);
    expect(widgets(state)).toHaveLength(1);
  });

  test("and there is none while the note is editable", () => {
    expect(widgets(stateFor(FORM, { readOnly: false }))).toEqual([]);
  });

  /*
    A mark decoration or a hidden ``` inside a block replacement is a range set
    describing two different things for the same characters. `htmlPreviews`
    states the rule; a form has to keep the same one, and the check is that the
    set builds at all — `RangeSet.of(…, true)` throws on an overlap.
  */
  test("no other decoration is laid inside the replaced range", () => {
    const doc = `# Heading\n\n${FORM}\n\n**bold**\n`;
    expect(() => decorationsFor(stateFor(doc))).not.toThrow();
    expect(widgets(stateFor(doc))).toHaveLength(1);
  });

  test("a form and a diagram on one note do not collide", () => {
    const doc = `${FORM}\n\n\`\`\`html-preview\n<p>hi</p>\n\`\`\`\n`;
    expect(() => decorationsFor(stateFor(doc))).not.toThrow();
  });

  test("the host reaches the widget through the facet", () => {
    const host: FormHostContext = { submit: async () => ({ ok: true, message: "Sent." }) };
    const dom = widgets(stateFor(FORM, { host }))[0].toDOM();
    expect(dom.querySelector<HTMLButtonElement>(".cm-lp-form-submit")?.disabled).toBe(false);
  });

  test("and a surface that configured none draws the form with its button off", () => {
    const dom = widgets(stateFor(FORM))[0].toDOM();
    expect(dom.querySelector<HTMLButtonElement>(".cm-lp-form-submit")?.disabled).toBe(true);
  });
});
