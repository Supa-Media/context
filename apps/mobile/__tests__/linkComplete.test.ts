/**
 * @jest-environment jsdom
 */

/**
 * TYPING `[[` OFFERS THE NOTES YOU COULD MEAN.
 *
 * There was no completion at all: `[[` was two characters and the path after
 * them was typed from memory. Getting it wrong failed *silently* — `noteLinks`
 * draws a wikilink only once it resolves, so a mistyped link is indistinguishable
 * from prose until you go and read the tree.
 *
 * Two halves are tested here and they fail differently:
 *
 *  - **Which text is a `[[` at all.** Pure over the string before the caret,
 *    and what makes it correct is what it refuses — a closed link, a single
 *    bracket, a caret on the next line.
 *  - **What is offered, and what is written.** Also pure. The insertion is the
 *    rooted path with `.md` dropped, which is the one style `resolveLink`
 *    settles without a note list, so a completion cannot produce a link the
 *    editor then declines to draw.
 *
 * The mounted case at the bottom is the one thing neither half can prove: that
 * accepting a completion leaves a document with exactly one `]]` in it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the closed-link refusal dropped, so `[[a]]` still completes        2
 *   the newline allowed in the query, so a `[[` reaches the line below 1
 *   `.md` left on the inserted path                                    6
 *   the self note left in the list                                     1
 *   the band order flattened to plain alphabetical                     1
 *   the existing `]]` not detected, so accepting writes `]]]]`         1
 *
 * The last two of those went undetected on the first pass — the fixture had no
 * pair where the bands and the alphabet disagree, and no case put a newline in
 * front of the pattern. Both are covered now, which is the point of running the
 * sabotage rather than reading the assertions.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { startCompletion, currentCompletions, acceptCompletion } from "@codemirror/autocomplete";
import {
  MAX_CHOICES,
  noteChoices,
  editorCompletion,
  openWikilink,
} from "../features/console/files/linkComplete";
import type { NoteLinkContext } from "../features/console/files/noteLinks";

const PATHS = [
  "1-projects/editor-polish/overview.md",
  "1-projects/editor-polish/ux-sweep.md",
  "2-products/context-lc/overview.md",
  "4-resources/engineering/agent-workflows.md",
  // Sorts after `1-projects/…` but is a *better* match for "sweep" than
  // `ux-sweep` is: the band test below is about exactly this pair, and a
  // fixture where alphabetical and banded agree would prove nothing.
  "5-archive/sweep-notes.md",
  "index.md",
];

describe("what counts as an open wikilink", () => {
  test("the text after `[[` is the query", () => {
    expect(openWikilink("see [[over")).toEqual({ query: "over", from: 6 });
  });

  test("a bare `[[` is an open link with an empty query", () => {
    expect(openWikilink("see [[")).toEqual({ query: "", from: 6 });
  });

  test("a closed link is not one", () => {
    // The caret is past the `]]`. Completing here would rewrite a link somebody
    // has finished with.
    expect(openWikilink("see [[overview]] and")).toBeNull();
  });

  test("a single bracket is not one", () => {
    expect(openWikilink("see [over")).toBeNull();
  });

  test("a second `[[` on the same line wins", () => {
    expect(openWikilink("[[first]] then [[sec")).toEqual({ query: "sec", from: 17 });
  });

  test("a `[[` on the line above is not one", () => {
    /*
      The caller only ever hands this one line, so this is belt and braces —
      and it is the kind of belt that quietly stops being fastened when a
      caller changes. `parseLinks`' own wikilink pattern excludes the newline
      for the same reason: a link does not span lines.
    */
    expect(openWikilink("see [[\nnext line")).toBeNull();
  });

  test("nothing at all is not one", () => {
    expect(openWikilink("")).toBeNull();
    expect(openWikilink("plain prose")).toBeNull();
  });
});

describe("what is offered", () => {
  const self = "1-projects/editor-polish/overview.md";

  test("a name that starts with the query comes before one that contains it", () => {
    /*
      `overview` starts with "over"; `agent-workflows` does not and its path
      does not contain it either, so it is absent rather than last. The band
      order is the assertion — flattening to alphabetical puts `context-lc`
      first because of its folder.
    */
    expect(noteChoices("over", PATHS, null).map((choice) => choice.label)).toEqual([
      "overview",
      "overview",
    ]);
  });

  test("a better band beats a better alphabetical position", () => {
    /*
      `sweep-notes` *starts with* the query and `ux-sweep` merely contains it,
      so `sweep-notes` is first — even though its path sorts after the other's.
      Flatten the bands to plain alphabetical and this reverses.
    */
    expect(noteChoices("sweep", PATHS, null).map((choice) => choice.label)).toEqual([
      "sweep-notes",
      "ux-sweep",
    ]);
  });

  test("a path match is offered when no name matches", () => {
    expect(noteChoices("engineering", PATHS, null).map((choice) => choice.insert)).toEqual([
      "4-resources/engineering/agent-workflows",
    ]);
  });

  test("the note being edited is never offered", () => {
    const offered = noteChoices("over", PATHS, self).map((choice) => choice.insert);
    expect(offered).toEqual(["2-products/context-lc/overview"]);
  });

  test("what is written is the rooted path with the extension dropped", () => {
    /*
      Not the bare name. A bare `[[overview]]` resolves only while exactly one
      note answers to it, and this fixture already has two — so a completion
      that produced one would write a link the editor declines to draw.
    */
    expect(noteChoices("ux", PATHS, null)).toEqual([
      {
        label: "ux-sweep",
        folder: "1-projects/editor-polish",
        insert: "1-projects/editor-polish/ux-sweep",
      },
    ]);
  });

  test("a note at the root reports no folder", () => {
    expect(noteChoices("index", PATHS, null)).toEqual([
      { label: "index", folder: "", insert: "index" },
    ]);
  });

  test("an empty query offers everything, capped", () => {
    expect(noteChoices("", PATHS, null)).toHaveLength(PATHS.length);
    const many = Array.from({ length: MAX_CHOICES + 20 }, (_, i) => `f/note-${i}.md`);
    expect(noteChoices("", many, null)).toHaveLength(MAX_CHOICES);
  });

  test("a query nothing matches offers nothing", () => {
    expect(noteChoices("zzz", PATHS, null)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
});

/** A mounted editor whose only extension is the completion under test. */
function mount(doc: string): EditorView {
  const ref: { current: NoteLinkContext } = {
    current: { path: null, paths: PATHS, onOpen: () => {}, onPress: () => {} },
  };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [editorCompletion(ref)],
    }),
    parent,
  });
  views.push(view);
  return view;
}

/**
 * Ask for the list and wait until it can be accepted.
 *
 * Two waits in one, and both are the library's rather than ours.
 * `startCompletion` dispatches an effect and the plugin *debounces* before it
 * queries its sources, so the state carries no completions on the next
 * microtask however synchronous the source is. Then `acceptCompletion` refuses
 * for `interactionDelay` after the list opens — a deliberate guard against a
 * keystroke in flight accepting something the person has not seen yet. 250ms
 * clears both with room, and a shorter wait fails as "nothing was inserted",
 * which reads exactly like the bug these tests are for.
 */
async function settle(view: EditorView): Promise<void> {
  startCompletion(view);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe("accepting a completion", () => {
  test("writes the path and closes the brackets", async () => {
    const view = mount("see [[ux");
    await settle(view);
    expect(currentCompletions(view.state).map((c) => c.label)).toEqual(["ux-sweep"]);

    acceptCompletion(view);
    expect(view.state.doc.toString()).toBe("see [[1-projects/editor-polish/ux-sweep]]");
    // Past the brackets, which is where the next word goes.
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  test("does not write a second `]]` over one that is already there", async () => {
    const view = mount("see [[ux]]");
    // The caret is inside the brackets, not at the end of the document.
    view.dispatch({ selection: { anchor: 8 } });
    await settle(view);

    acceptCompletion(view);
    expect(view.state.doc.toString()).toBe("see [[1-projects/editor-polish/ux-sweep]]");
  });

  test("prose offers nothing", async () => {
    const view = mount("just some prose");
    await settle(view);
    expect(currentCompletions(view.state)).toEqual([]);
  });
});
