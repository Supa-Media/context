/**
 * @jest-environment jsdom
 */

/**
 * Emoji in the editor: typing `:` and a name, and `:name:` drawn in a note.
 *
 * What has to hold: the menu opens only where a shortcode can start and
 * never in code; a standard emoji is written as its character and a
 * workspace one as `:name:`; when nothing local matches, Slackmojis results
 * are offered and picking one adds it and writes it; and a drawn note shows
 * a workspace emoji as its picture, a standard shortcode as its character,
 * and leaves code alone.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { acceptCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";

import { editorCompletion } from "../features/console/files/linkComplete";
import { markdownLanguage } from "../features/console/files/livePreview";
import { emojiHost, type EmojiHostContext } from "../features/console/files/emoji/host";
import { emojiInline } from "../features/console/files/emoji/emojiInline";
import { emojiTyping, openShortcode, rankCustomEmoji } from "../features/console/files/emoji/emojiComplete";
import { searchStandardEmoji } from "../features/console/files/emoji/standardEmoji";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
});

const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

function host(overrides: Partial<EmojiHostContext> = {}): EmojiHostContext {
  return {
    custom: () => ["partyparrot", "lgtm", "api"],
    load: (name) => Promise.resolve(["partyparrot", "lgtm", "api"].includes(name) ? PICTURE : null),
    ...overrides,
  };
}

function mount(doc: string, context: EmojiHostContext | null = host(), anchor = doc.length): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdownLanguage(),
        editorCompletion(null),
        emojiInline(),
        emojiTyping(),
        ...(context === null ? [] : [emojiHost.of({ current: context })]),
      ],
    }),
    parent,
  });
  views.push(view);
  return view;
}

/** Ask for the list and wait past the library's debounce and interaction delay. */
async function settle(view: EditorView, ms = 250): Promise<void> {
  startCompletion(view);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("where a shortcode starts", () => {
  test("after a space or at the start of a line, with two characters", () => {
    expect(openShortcode("ship it :pa")).toEqual({ query: "pa", from: 8 });
    expect(openShortcode(":tada")).toEqual({ query: "tada", from: 0 });
    expect(openShortcode("(:+1")).toEqual({ query: "+1", from: 1 });
  });

  test.each(["at 10:30", "http://x", "a :p", "note:ta", ":tada:", "a: b"])("not in %j", (text) => {
    expect(openShortcode(text)).toBeNull();
  });
});

describe("what is offered", () => {
  test("standard emoji rank a whole name, then its start, then inside it", () => {
    expect(searchStandardEmoji("tada", 1)[0]?.emoji.char).toBe("🎉");
    expect(searchStandardEmoji("+1", 1)[0]?.emoji.char).toBe("👍");
    const smiles = searchStandardEmoji("smile", 3).map((hit) => hit.name);
    expect(smiles[0]).toBe("smile");
  });

  test("workspace emoji: the start of a name before inside it", () => {
    expect(rankCustomEmoji(["rapid", "api", "apple"], "ap")).toEqual(["api", "apple", "rapid"]);
  });

  test("the workspace's own come first, and standard ones follow", async () => {
    const view = mount("ship it :par");
    await settle(view);
    const labels = currentCompletions(view.state).map((completion) => completion.label);
    expect(labels[0]).toBe(":partyparrot:");
    expect(labels).toContain(":partying_face:");
  });

  test("someone who may add emoji also gets Search Slackmojis and Add", async () => {
    const view = mount("ship it :par", host({ openAdd: () => Promise.resolve(null), searchSlackmojis: () => Promise.resolve([]) }));
    await settle(view);
    const labels = currentCompletions(view.state).map((completion) => completion.label);
    expect(labels.slice(-2)).toEqual(["Search Slackmojis for “par”", "Add a custom emoji…"]);
  });

  test("a member is offered no actions", async () => {
    const view = mount("ship it :par");
    await settle(view);
    const labels = currentCompletions(view.state).map((completion) => completion.label);
    expect(labels.some((label) => label.startsWith("Add a custom"))).toBe(false);
  });

  test("nothing in code, and nothing after a colon glued to a word", async () => {
    for (const doc of ["`:tad", "```\n:tad", "at 10:30"]) {
      const view = mount(doc);
      await settle(view);
      expect(currentCompletions(view.state)).toEqual([]);
    }
  });
});

describe("what is written", () => {
  test("a standard emoji is its character", async () => {
    const view = mount("done :tada", null);
    await settle(view);
    acceptCompletion(view);
    expect(view.state.doc.toString()).toBe("done 🎉");
  });

  test("a workspace emoji is :name:", async () => {
    const view = mount("ship it :party");
    await settle(view);
    acceptCompletion(view);
    expect(view.state.doc.toString()).toBe("ship it :partyparrot:");
  });

  test("with nothing local, a Slackmojis result is added to the workspace and written", async () => {
    const importSlackmoji = jest.fn((_result: unknown, name: string) => Promise.resolve({ name }));
    const view = mount(
      "morning :blobwave",
      host({
        openAdd: () => Promise.resolve(null),
        searchSlackmojis: () =>
          Promise.resolve([{ name: "blobwave", url: "https://emojis.slackmojis.com/emojis/images/1/2/blobwave.gif", category: null }]),
        importSlackmoji,
      }),
    );
    await settle(view, 700);
    expect(currentCompletions(view.state)[0]?.label).toBe(":blobwave:");
    acceptCompletion(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importSlackmoji).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("morning :blobwave:");
  });

  test("typing the closing colon of a standard shortcode writes the character", () => {
    const view = mount("done :tada", null);
    const from = view.state.doc.length;
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view, from, from, ":", () => view.state.update({ changes: { from, insert: ":" } })));
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("done 🎉");
  });

  test("…but not a name nobody knows, and not in code", () => {
    for (const doc of ["see :notanemoji", "`:tada"]) {
      const view = mount(doc, null);
      const from = view.state.doc.length;
      const handled = view.state
        .facet(EditorView.inputHandler)
        .some((handler) => handler(view, from, from, ":", () => view.state.update({ changes: { from, insert: ":" } })));
      expect(handled).toBe(false);
    }
  });
});

describe("drawn in the note", () => {
  test("a workspace emoji as its picture, a standard one as its character, code left alone", async () => {
    const view = mount("ok :lgtm: :tada: `:lgtm:` :nope:", host(), 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pictures = view.contentDOM.querySelectorAll("img.cm-emoji");
    expect(pictures).toHaveLength(1);
    expect(pictures[0]?.getAttribute("alt")).toBe(":lgtm:");
    expect(view.contentDOM.querySelector(".cm-emoji-char")?.textContent).toBe("🎉");
    expect(view.contentDOM.textContent).toContain(":nope:");
    // The file is untouched: drawing is only drawing.
    expect(view.state.doc.toString()).toBe("ok :lgtm: :tada: `:lgtm:` :nope:");
  });

  test("with no host, standard shortcodes still draw and workspace names stay text", async () => {
    const view = mount("ok :lgtm: :tada:", null, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.contentDOM.querySelectorAll("img.cm-emoji")).toHaveLength(0);
    expect(view.contentDOM.querySelector(".cm-emoji-char")?.textContent).toBe("🎉");
  });
});
