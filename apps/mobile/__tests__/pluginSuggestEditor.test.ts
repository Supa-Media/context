/**
 * @jest-environment jsdom
 */

/**
 * The suggestion list, in a real CodeMirror.
 *
 * `pluginSuggest.test.ts` holds the gate and the routing as pure functions.
 * This drives the actual extension against a real `EditorView`, because the two
 * things most likely to be wrong here are not expressible without one: what the
 * plugin is *asked* (the line up to the cursor, not the whole document, not the
 * word under the caret), and what a pick *writes* (the line the plugin
 * produced, and only if that line has not moved underneath it).
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { pluginSuggestions } from "../features/console/files/pluginSuggest";

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
      extensions: [
        pluginSuggestions({
          ask: async (line, ch) => {
            options.asked?.push({ line, ch });
            return options.ask ? options.ask(line, ch) : [];
          },
          pick: async (index) => (options.pick ? options.pick(index) : null),
        }),
      ],
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
