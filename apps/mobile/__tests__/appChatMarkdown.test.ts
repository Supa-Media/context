/**
 * TEX'S WORDS AS BLOCKS.
 *
 * `chatBlocks` reads a Tex message with the shared-note parser, then keeps the
 * chat's own rules: only an `https:` link is tappable, a note link opens in the
 * app, and a paragraph that is only a note link is a card. These tests pin the
 * shapes the renderer draws and the refusals that keep a message from becoming
 * a link to somewhere else.
 */

import { describe, expect, test } from "@jest/globals";
import { chatBlocks, chatPlainText, noteLinkOf, type ChatBlock, type ChatInline } from "../features/tex/chat/appChatMarkdown";

/** The inline runs of the first paragraph-like block. */
function runsOf(text: string): ChatInline[] {
  const [block] = chatBlocks(text);
  if (block === undefined) throw new Error("no block");
  if (block.kind === "bullet" || block.kind === "ordered") throw new Error("a list, not a paragraph");
  if (block.kind === "notecard") throw new Error("a card, not a paragraph");
  return block.content;
}

describe("lists and emphasis", () => {
  test("a bullet list keeps its items", () => {
    const blocks = chatBlocks("- one\n- two");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "bullet" });
    const items = (blocks[0] as Extract<ChatBlock, { kind: "bullet" }>).items;
    expect(items.map((item) => item.map((run) => run.text).join(""))).toEqual(["one", "two"]);
  });

  test("a numbered list is ordered", () => {
    const [block] = chatBlocks("1. first\n2. second");
    expect(block).toMatchObject({ kind: "ordered" });
    expect((block as Extract<ChatBlock, { kind: "ordered" }>).items).toHaveLength(2);
  });

  test("a heading is a heading block with its words", () => {
    const [block] = chatBlocks("## Plan");
    expect(block).toEqual({ kind: "heading", content: [{ kind: "text", text: "Plan" }] });
  });

  test("bold, italic and inline code are marked, not shown as asterisks or ticks", () => {
    const runs = runsOf("a **big** and *soft* `cmd` word");
    expect(runs).toContainEqual({ kind: "text", text: "big", strong: true });
    expect(runs).toContainEqual({ kind: "text", text: "soft", em: true });
    expect(runs).toContainEqual({ kind: "code", text: "cmd" });
    expect(runs.map((run) => run.text).join("")).toBe("a big and soft cmd word");
  });

  test("markup inside a code span stays literal", () => {
    expect(runsOf("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });
});

describe("links", () => {
  test("a bare https address in words becomes a link", () => {
    const runs = runsOf("see https://supa.media/notes now");
    expect(runs).toContainEqual({ kind: "link", text: "https://supa.media/notes", href: "https://supa.media/notes" });
  });

  test("a bare domain stays words", () => {
    const runs = runsOf("visit supa.media today");
    expect(runs.some((run) => run.kind === "link")).toBe(false);
    expect(runs.map((run) => run.text).join("")).toContain("supa.media");
  });

  test("a javascript: link stays words, never a link", () => {
    const runs = runsOf("[click](javascript:alert(1))");
    expect(runs.some((run) => run.kind === "link" || run.kind === "note")).toBe(false);
    expect(runs.map((run) => run.text).join("")).toContain("click");
  });

  test("raw HTML stays words", () => {
    const runs = runsOf("<script>alert(1)</script> and <b>bold</b>");
    expect(runs.some((run) => run.kind !== "text")).toBe(false);
    expect(runs.map((run) => run.text).join("")).toContain("<script>alert(1)</script>");
  });

  test("a message opening with --- is not read as frontmatter, so its words stay", () => {
    const words = chatBlocks("---\ntitle: hi\n---\nafter").flatMap((block) =>
      block.kind === "paragraph" ? block.content.map((run) => run.text) : [],
    );
    expect(words.join(" ")).toContain("title: hi");
  });
});

describe("note links", () => {
  test("a note link in a sentence opens the console address for the note", () => {
    const runs = runsOf("Read [the plan](https://context.lc/note/@supa/projects/x.md) today");
    const note = runs.find((run) => run.kind === "note");
    expect(note).toEqual({
      kind: "note",
      text: "the plan",
      href: "/console/@supa?note=projects%2Fx.md",
      path: "projects/x.md",
      url: "https://context.lc/note/@supa/projects/x.md",
    });
  });

  test("a page link (/p/) is the same note, read the same way", () => {
    expect(noteLinkOf("https://context.lc/p/@supa/Public%20Worship.page.md")).toEqual({
      href: "/console/@supa?note=Public%20Worship.page.md",
      path: "Public Worship.page.md",
    });
  });

  test("a relative note path is accepted, another host's path is still a note", () => {
    expect(noteLinkOf("/note/@supa/a.md")).toEqual({ href: "/console/@supa?note=a.md", path: "a.md" });
    expect(noteLinkOf("https://context.lc/note/@supa/a.md?t=A&k=AbCdEfGhIjKlMnOpQrSt_-")).toEqual({ href: "/console/@supa?note=a.md", path: "a.md" });
    expect(noteLinkOf("https://example.org/note/@supa/a.md")?.path).toBe("a.md");
  });

  test("a link without the @ context segment is not a note link", () => {
    expect(noteLinkOf("https://context.lc/note/supa/a.md")).toBeNull();
    expect(noteLinkOf("https://context.lc/about")).toBeNull();
    expect(noteLinkOf("javascript:/note/@supa/a.md")).toBeNull();
  });

  test("a traversal path is refused after decoding, and the link stays an https link", () => {
    const link = "https://context.lc/note/@supa/%2e%2e/secret.md";
    expect(noteLinkOf(link)).toBeNull();
    const runs = runsOf(`see ${link}`);
    expect(runs.some((run) => run.kind === "note")).toBe(false);
    expect(runs).toContainEqual({ kind: "link", text: link, href: link });
  });
});

describe("note cards", () => {
  test("a paragraph that is only a bare note link is a card named after the note", () => {
    const [block] = chatBlocks("https://context.lc/note/@supa/1-projects/context-lc-file-page-persistence/overview.md");
    expect(block).toEqual({
      kind: "notecard",
      href: "/console/@supa?note=1-projects%2Fcontext-lc-file-page-persistence%2Foverview.md",
      path: "1-projects/context-lc-file-page-persistence/overview.md",
      title: "Overview",
      folder: "1-projects/context-lc-file-page-persistence",
      url: "https://context.lc/note/@supa/1-projects/context-lc-file-page-persistence/overview.md",
    });
  });

  test("a markdown link alone on its line takes its link text as the title", () => {
    const [block] = chatBlocks("[Read the plan](https://context.lc/p/@supa/plan.page.md)");
    expect(block).toMatchObject({ kind: "notecard", title: "Read the plan", folder: "", path: "plan.page.md" });
  });

  test("a dashed root file name is spaced and capitalised", () => {
    const [block] = chatBlocks("https://context.lc/note/@supa/my-first-note.md");
    expect(block).toMatchObject({ kind: "notecard", title: "My first note", folder: "" });
  });

  test("a note link inside a sentence is not a card", () => {
    const [block] = chatBlocks("Look at https://context.lc/note/@supa/a.md please");
    expect(block).toMatchObject({ kind: "paragraph" });
  });

  test("a full stop after a bare note link makes it a sentence, not a card", () => {
    const [block] = chatBlocks("https://context.lc/note/@supa/a.md.");
    expect(block).toMatchObject({ kind: "paragraph" });
  });
});

describe("the rest falls back to words", () => {
  test("a quote and a code block are words", () => {
    expect(chatBlocks("> wise words")).toEqual([{ kind: "paragraph", content: [{ kind: "text", text: "wise words" }] }]);
    expect(chatBlocks("```\nlet x = 1\n```")).toEqual([{ kind: "paragraph", content: [{ kind: "text", text: "let x = 1" }] }]);
  });

  test("an empty message has no blocks", () => {
    expect(chatBlocks("")).toEqual([]);
  });
});

describe("chatPlainText", () => {
  test("drops the Markdown a person never sees: link brackets, bold stars, list marks", () => {
    expect(chatPlainText("Two things are open on [Saturday plan](https://example.test/x):\n\n- the **$3 fee**\n- the cake")).toBe(
      "Two things are open on Saturday plan:\n• the $3 fee\n• the cake",
    );
  });

  test("numbers an ordered list and keeps plain words as they are", () => {
    expect(chatPlainText("1. one\n2. two")).toBe("1. one\n2. two");
    expect(chatPlainText("just words")).toBe("just words");
  });
});
