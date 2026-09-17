/**
 * @jest-environment jsdom
 */

/**
 * A NOTE THAT ASKS TO BE OPENED FOR READING.
 *
 * The case that asked for this: a page whose whole content is a ` ```form `
 * fence is only *usable* while the note is read — that is `formBlock.ts`'s
 * central rule and `docs/decisions/forms.md`'s — so every person who opened one
 * had to find the eye in the trailing group before they could fill anything in.
 * A page built to be used opened as source.
 *
 * Two claims are held here, and the second is the one worth sabotaging:
 *
 *  - the frontmatter is read, in both vocabularies, and an unreadable value is
 *    ignored rather than guessed at;
 *  - **a declaration is a default, not a mode.** The person's press outranks
 *    it, and it never follows them onto the next note. Collapsing the two
 *    layers into one flag passes every parsing test in this file and fails the
 *    three at the foot of it.
 *
 * The hook is exercised through a real render rather than by calling
 * `declareReadMode` directly, because the timing *is* the behaviour: the
 * declaration is applied when the note's identity changes and at no other
 * point, and a test that called the bus by hand would go green on a hook that
 * re-applied it on every keystroke.
 */

import { afterEach, describe as group, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { resetReadMode, setReadMode, useReadMode } from "../features/console/files/readMode";
import { declaredView, useDeclaredView } from "../features/console/files/viewMode";

/* -------------------------------------------------------------------------- */
/*                         what the frontmatter says                          */
/* -------------------------------------------------------------------------- */

const FORM_NOTE = [
  "---",
  "title: Report a bug",
  "view: read",
  "---",
  "",
  "```form",
  "responses: 1-projects/bugs/responses.md",
  "layout: sections",
  "submit: member",
  "```",
  "",
].join("\n");

const PLAIN_NOTE = "---\ntitle: The storage binding\n---\n\nProse.\n";

group("what a note declares", () => {
  test("the key this console writes about, in every word it accepts", () => {
    expect(declaredView("---\nview: read\n---\n")).toBe("read");
    expect(declaredView("---\nview: reading\n---\n")).toBe("read");
    expect(declaredView("---\nview: preview\n---\n")).toBe("read");
    expect(declaredView("---\nview: edit\n---\n")).toBe("edit");
    expect(declaredView("---\nview: editing\n---\n")).toBe("edit");
    expect(declaredView("---\nview: source\n---\n")).toBe("edit");
  });

  test("case and quotes are YAML's, not the answer's", () => {
    expect(declaredView('---\nView: "Read"\n---\n')).toBe("read");
    expect(declaredView("---\nVIEW: EDIT\n---\n")).toBe("edit");
    expect(declaredView("---\nview:   read   \n---\n")).toBe("read");
  });

  /**
   * The same bucket is open in Obsidian while this console is looking at it,
   * and `obsidianUIMode` is the key Obsidian already honours for exactly this.
   * Reading it means one line in the file rather than two that can disagree.
   */
  test("Obsidian's own key is read, and ours wins where a note carries both", () => {
    expect(declaredView("---\nobsidianUIMode: preview\n---\n")).toBe("read");
    expect(declaredView("---\nobsidianUIMode: source\n---\n")).toBe("edit");
    expect(declaredView("---\nobsidianUIMode: preview\nview: edit\n---\n")).toBe("edit");
    // Order in the file does not decide it; the key does.
    expect(declaredView("---\nview: read\nobsidianUIMode: source\n---\n")).toBe("read");
  });

  /**
   * A key that is only nearly right must not half-work. The note opens however
   * the person was already working, which is what every note did before this
   * existed — never "well, it said something, so read it".
   */
  test("a value neither table knows is ignored rather than guessed at", () => {
    expect(declaredView("---\nview: readonly\n---\n")).toBeNull();
    expect(declaredView("---\nview: true\n---\n")).toBeNull();
    expect(declaredView("---\nview:\n---\n")).toBeNull();
    expect(declaredView("---\nviewing: read\n---\n")).toBeNull();
    // …and an unreadable row does not stop the other key being asked.
    expect(declaredView("---\nview: yes please\nobsidianUIMode: preview\n---\n")).toBe("read");
  });

  test("a note that says nothing declares nothing", () => {
    expect(declaredView(PLAIN_NOTE)).toBeNull();
    expect(declaredView("")).toBeNull();
    expect(declaredView("# Just a note\n\nProse.\n")).toBeNull();
  });

  /**
   * Only the frontmatter is looked at. A line reading `view: read` further down
   * is prose — in a paragraph, in a quotation, or inside the fenced example
   * that documents this feature — and prose does not change how a note opens.
   */
  test("the body is prose, including when the prose is about this feature", () => {
    expect(declaredView("---\ntitle: How to\n---\n\nPut `view: read` in the block.\n")).toBeNull();
    expect(declaredView("# How to\n\n```yaml\nview: read\n```\n")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                    what the console does about it                          */
/* -------------------------------------------------------------------------- */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  resetReadMode();
});

/** The hook and the bus, with the mode they agree on painted into the DOM. */
function Probe({ note, source }: { note: string | null; source: string }) {
  useDeclaredView(note, source);
  return createElement("span", { "data-testid": "mode" }, useReadMode() ? "read" : "edit");
}

function open(note: string | null, source: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (next: { note: string | null; source: string }) => {
    act(() => root.render(createElement(Probe, next)));
  };
  show({ note, source });

  return {
    /** Open another note, or the same note after somebody typed in it. */
    show,
    mode: () => container.querySelector('[data-testid="mode"]')!.textContent,
  };
}

group("the mode a note opens in", () => {
  test("a page built around a form opens as the form, not as its source", () => {
    const app = open("w1:1-projects/bugs/report.md", FORM_NOTE);
    expect(app.mode()).toBe("read");
  });

  test("a note that declares nothing opens the way the person was working", () => {
    const app = open("w1:1-projects/plan.md", PLAIN_NOTE);
    expect(app.mode()).toBe("edit");
  });

  test("`view: edit` is the other direction, and it is real", () => {
    const app = open("w1:1-projects/plan.md", "---\nview: edit\n---\n");
    expect(app.mode()).toBe("edit");

    // Even with the person reading everything else: this note asked.
    act(() => setReadMode(true));
    const next = open("w1:3-resources/ref.md", "---\nview: edit\n---\n");
    expect(next.mode()).toBe("edit");
  });

  /**
   * THE claim. A form page that cannot be edited is not a page: the one place
   * a `form` fence that will not parse can be fixed is its source, and the
   * pencil is how you get there.
   */
  test("the pencil outranks the file, and keeps outranking it", () => {
    const app = open("w1:1-projects/bugs/report.md", FORM_NOTE);
    expect(app.mode()).toBe("read");

    act(() => setReadMode(false));
    expect(app.mode()).toBe("edit");

    // Typing does not re-apply what the file asked for. The source changes on
    // every keystroke and the note's identity does not, which is the whole
    // reason the hook depends on one and not the other.
    app.show({ note: "w1:1-projects/bugs/report.md", source: `${FORM_NOTE}\nmore text` });
    expect(app.mode()).toBe("edit");
  });

  /**
   * The failure that would never be reported as one: a file quietly deciding
   * how the *session* works. Every note opened after the form would come up
   * unwritable, with nothing on screen saying why.
   */
  test("a declaration does not follow you onto the next note", () => {
    const app = open("w1:1-projects/bugs/report.md", FORM_NOTE);
    expect(app.mode()).toBe("read");

    app.show({ note: "w1:1-projects/plan.md", source: PLAIN_NOTE });
    expect(app.mode()).toBe("edit");
  });

  /**
   * …and the mirror of it, which is `readMode.ts`'s own rule and must survive:
   * reading mode is how you are working, so it persists across notes that say
   * nothing. Only a note with an opinion may interrupt it, and only for itself.
   */
  test("the person's own mode still persists across notes", () => {
    const app = open("w1:1-projects/plan.md", PLAIN_NOTE);
    act(() => setReadMode(true));
    expect(app.mode()).toBe("read");

    app.show({ note: "w1:3-resources/books.md", source: "# Books\n" });
    expect(app.mode()).toBe("read");

    // Through a declaring note and out the other side, unchanged.
    app.show({ note: "w1:1-projects/plan2.md", source: "---\nview: edit\n---\n" });
    expect(app.mode()).toBe("edit");
    app.show({ note: "w1:3-resources/films.md", source: "# Films\n" });
    expect(app.mode()).toBe("read");
  });

  test("closing the note takes its declaration with it", () => {
    const app = open("w1:1-projects/bugs/report.md", FORM_NOTE);
    expect(app.mode()).toBe("read");
    app.show({ note: null, source: "" });
    expect(app.mode()).toBe("edit");
  });

  /**
   * Two contexts under PARA conventions plausibly both hold `1-projects/plan.md`,
   * and `BrowsePane` is reconciled with no `key` across a context switch. The
   * identity it passes therefore carries the context, and this is the test that
   * fails if somebody simplifies it back to the path.
   */
  test("the same path in another context is another note", () => {
    const app = open("w1:1-projects/plan.md", PLAIN_NOTE);
    expect(app.mode()).toBe("edit");
    app.show({ note: "w2:1-projects/plan.md", source: FORM_NOTE });
    expect(app.mode()).toBe("read");
  });
});
