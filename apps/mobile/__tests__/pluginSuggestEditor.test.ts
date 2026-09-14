/**
 * @jest-environment jsdom
 */

/**
 * The suggestion list, in the editor it actually ships in.
 *
 * `pluginSuggest.test.ts` holds the gate and the routing as pure functions.
 * This drives the real completion source against a real `EditorView`, because
 * the things most likely to be wrong here are not expressible without one: what
 * the plugin is *asked* (the line up to the cursor, not the whole document, not
 * the word under the caret), and what a pick *writes* (the line the plugin
 * produced, and only if that line has not moved underneath it).
 *
 * ## Why the harness mounts `editorExtensions` rather than the source alone
 *
 * It did not, and that shipped a crash. The first version of this file built an
 * `EditorState` from `pluginSuggestions(...)` and nothing else — the extension
 * proved correct in an editor nobody uses. In the console's real editor there
 * is already an `autocompletion()` call, and CodeMirror's `override` field has
 * no combiner: a second one throws `Config merge conflict for field override`
 * at state construction, which is every note failing to open for anyone with a
 * plugin running.
 *
 * Both `linkComplete.ts` and `formComplete.ts` carry that warning in their own
 * headers. The test that would have caught it is the one that builds the editor
 * the product builds, so that is what every test below does now.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { editorExtensions } from "../features/console/files/editorSetup";
import { pluginSuggestSource } from "../features/console/files/pluginSuggest";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
  document.body.innerHTML = "";
});

/*
  Several turns, not one. CodeMirror runs a completion source from a state
  field after a debounce, and only for a focused view — so the harness focuses
  the editor and lets the scheduler settle rather than assuming the source ran
  synchronously.
*/
const tick = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function editor(options: {
  doc: string;
  cursor: number;
  ask?: (line: string, ch: number) => Promise<{ text: string }[]>;
  pick?: (index: number) => Promise<string | null>;
  asked?: { line: string; ch: number }[];
}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      selection: { anchor: options.cursor },
      /*
        The whole editor, not the one extension. See the module header: the
        source has to compose with the completion this console already
        configures, and only building both proves that it does.
      */
      extensions: editorExtensions({
        editable: true,
        editableCompartment: new Compartment(),
        handlers: { current: { onChange: () => {}, onSave: () => {} } },
        pluginSuggest: pluginSuggestSource({
          ask: async (line, ch) => {
            options.asked?.push({ line, ch });
            return options.ask ? options.ask(line, ch) : [];
          },
          pick: async (index) => (options.pick ? options.pick(index) : null),
        }),
      }),
    }),
  });
  views.push(view);
  view.focus();
  return view;
}

describe("what the plugin is asked", () => {
  test("the line up to the cursor, and where the cursor is in it", async () => {
    const asked: { line: string; ch: number }[] = [];
    const view = editor({
      doc: "first line\nsee @ John 3:16 now",
      // Just after "3:16", i.e. 15 characters into the second line.
      cursor: "first line\n".length + 15,
      asked,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
    });
    startCompletion(view);
    await tick();
    /*
      Not the whole document, and not the word under the caret. A suggester's
      `onTrigger` reads backwards along the line for its own marker — `@ ` here
      — so anything less than the line before the cursor makes it blind, and
      anything more hands the sandbox note content it was not asked for.
    */
    expect(asked).toEqual([{ line: "see @ John 3:16", ch: 15 }]);
  });

  test("an empty answer opens no menu at all", async () => {
    const view = editor({ doc: "ordinary prose", cursor: 14, ask: async () => [] });
    startCompletion(view);
    await tick();
    expect(currentCompletions(view.state)).toEqual([]);
  });

  test("what the plugin rendered is what the list shows", async () => {
    const view = editor({
      doc: "see @ John 3:16",
      cursor: 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }, { text: "John 3:16 (ESV)" }],
    });
    startCompletion(view);
    await tick();
    expect(currentCompletions(view.state).map((one) => one.label)).toEqual([
      "John 3:16 (NIV)",
      "John 3:16 (ESV)",
    ]);
  });
});

describe("what a pick writes", () => {
  async function pickFirst(view: EditorView) {
    const completion = currentCompletions(view.state)[0];
    expect(completion).toBeDefined();
    const apply = completion!.apply as (view: EditorView) => void;
    apply(view);
    await tick();
  }

  test("the line the plugin produced replaces the line it was shown", async () => {
    const view = editor({
      doc: "see @ John 3:16",
      cursor: 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
      pick: async () => "see [John 3:16](https://www.bible.com/bible/1/John.3.16)",
    });
    startCompletion(view);
    await tick();
    await pickFirst(view);
    expect(view.state.doc.toString()).toBe(
      "see [John 3:16](https://www.bible.com/bible/1/John.3.16)",
    );
  });

  test("only that line — the rest of the note is untouched", async () => {
    const view = editor({
      doc: "keep me\nsee @ John 3:16\nand me",
      cursor: "keep me\n".length + 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
      pick: async () => "see [John 3:16](https://example.test/v)",
    });
    startCompletion(view);
    await tick();
    await pickFirst(view);
    expect(view.state.doc.toString()).toBe(
      "keep me\nsee [John 3:16](https://example.test/v)\nand me",
    );
  });

  /*
    THE GUARD THIS FILE IS MOST WORTH WRITING FOR.

    A pick crosses to a sandbox and back, which is long enough for somebody to
    keep typing. The plugin computed its line from the line it was shown; if
    that line has changed since, writing the answer would overwrite the
    keystrokes with a completion for text that is gone. The etag rule, at the
    scale of one line: never write over what you did not read.
  */
  test("a line that changed while the plugin was thinking is left alone", async () => {
    let release: (value: string | null) => void = () => {};
    const view = editor({
      doc: "see @ John 3:16",
      cursor: 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
      pick: () => new Promise<string | null>((resolve) => { release = resolve; }),
    });
    startCompletion(view);
    await tick();
    const completion = currentCompletions(view.state)[0]!;
    (completion.apply as (view: EditorView) => void)(view);
    // The person carries on typing before the sandbox answers.
    view.dispatch({ changes: { from: 15, insert: " and more" } });
    release("see [John 3:16](https://example.test/v)");
    await tick();
    expect(view.state.doc.toString()).toBe("see @ John 3:16 and more");
  });

  test("a plugin that never answers leaves the line as it was", async () => {
    const view = editor({
      doc: "see @ John 3:16",
      cursor: 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
      pick: async () => null,
    });
    startCompletion(view);
    await tick();
    await pickFirst(view);
    expect(view.state.doc.toString()).toBe("see @ John 3:16");
  });

  test("a line that no longer exists is not written to", async () => {
    let release: (value: string | null) => void = () => {};
    const view = editor({
      doc: "first\nsee @ John 3:16",
      cursor: "first\n".length + 15,
      ask: async () => [{ text: "John 3:16 (NIV)" }],
      pick: () => new Promise<string | null>((resolve) => { release = resolve; }),
    });
    startCompletion(view);
    await tick();
    (currentCompletions(view.state)[0]!.apply as (view: EditorView) => void)(view);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "gone" } });
    release("see [John 3:16](https://example.test/v)");
    await tick();
    expect(view.state.doc.toString()).toBe("gone");
  });
});

/*
  TYPING, NOT `startCompletion`.

  Every test above drives the menu open explicitly, which proves the source is
  correct and proves nothing about whether it ever runs. The way somebody
  actually meets this feature is by typing `@John 3:16` and expecting a list —
  and a source that is only reachable from a keyboard shortcut nobody presses is
  indistinguishable, from the outside, from a feature that was never built.

  So this types character by character, the way the person in the bug report
  did, and asserts the plugin was asked at all.
*/
describe("it fires on typing, which is the only way anyone will meet it", () => {
  function type(view: EditorView, text: string) {
    for (const character of text) {
      const at = view.state.selection.main.head;
      view.dispatch({
        changes: { from: at, insert: character },
        selection: { anchor: at + character.length },
        userEvent: "input.type",
      });
    }
  }

  test("typing the trigger asks the plugin, with no shortcut pressed", async () => {
    const asked: { line: string; ch: number }[] = [];
    const view = editor({ doc: "", cursor: 0, asked, ask: async () => [{ text: "John 3:16 (NIV)" }] });
    type(view, "@John 3:16");
    await tick();
    expect(asked.length).toBeGreaterThan(0);
    /*
      The last thing it was asked is the whole line up to the cursor. No space
      after the `@` — that is what the plugin's own onTrigger scans for, and the
      host must not be the thing deciding what a trigger looks like.
    */
    expect(asked[asked.length - 1]).toEqual({ line: "@John 3:16", ch: 10 });
  });

  test("and the list it returns is on screen without a shortcut", async () => {
    const view = editor({ doc: "", cursor: 0, ask: async () => [{ text: "John 3:16 (NIV)" }] });
    type(view, "@John 3:16");
    await tick();
    expect(currentCompletions(view.state).map((one) => one.label)).toEqual(["John 3:16 (NIV)"]);
  });
});

/*
  THE CRASH THIS FILE DID NOT CATCH.

  Reported from production in `@test-workspace`: opening a note threw
  `Config merge conflict for field override` and the console fell back to the
  workspace route. Not a plugin fault and not a data fault — CodeMirror's
  `completionConfig` facet combines its fields with `combineConfig`, and
  `override` is not in its combiner map, so a *second* `autocompletion()` in the
  same state is a throw at construction rather than a second list.

  The console has configured one since forms and `[[` links shared it. #552
  added another, and every test it shipped with built an editor that had only
  the new one.

  These two hold the composition itself: the state builds, and both sources are
  still reachable in it.
*/
describe("it composes with the completion this editor already has", () => {
  test("a note with a plugin source in it opens at all", () => {
    expect(() => editor({ doc: "see @ John 3:16", cursor: 15 })).not.toThrow();
  });

  /*
    The other half of the same bug, and the reason the fix is a source rather
    than a second `autocompletion()`: if this file's source silently displaced
    the editor's own, `[[` and form completion would stop answering and nothing
    here would say so.
  */
  test("the editor's own completion still answers beside it", async () => {
    const view = editor({
      doc: "```form\nlayout: ",
      cursor: "```form\nlayout: ".length,
      ask: async () => [],
    });
    startCompletion(view);
    await tick();
    expect(currentCompletions(view.state).length).toBeGreaterThan(0);
  });
});
