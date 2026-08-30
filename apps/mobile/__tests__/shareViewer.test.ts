/**
 * THE SHARE VIEWER — the page a shared link opens.
 *
 * Two modules, both pure, and the split is deliberate: `share.ts` decides which
 * screen to show, `markdown.ts` decides what a note looks like. Neither needs a
 * router or a socket, which is the rule `capabilities.ts` states at length —
 * across a sabotage sweep of this codebase, every guard expressed as a pure
 * module was held and every guard expressed inside a hook or a component was
 * not.
 *
 * The parser is the part with teeth, because it renders **somebody else's
 * note**. The questions are not "does bold work" but what a hostile document
 * can do to the reader: a `javascript:` link they might tap, a tracking pixel
 * that turns reading into a read receipt, markup that escapes its own block.
 */

import { describe, expect, test } from "@jest/globals";
import {
  MAX_BLOCKS,
  noteTitle,
  parseInline,
  parseNote,
  safeHref,
  type Inline,
} from "../features/share/markdown";
import {
  SHARE_ROUTE,
  firstParam,
  linkLabel,
  onwardLinks,
  resolveShareView,
  shareHref,
  shareSignInHref,
  type SharedNote,
} from "../features/share/share";

const note = (over: Partial<SharedNote> = {}): SharedNote => ({
  path: "1-projects/overview.md",
  text: "# Overview\n\nBody.\n",
  entryPath: "1-projects/overview.md",
  links: [],
  ...over,
});

const TOKEN = "a".repeat(64);
const SIGNED_IN = { isLoading: false, isAuthenticated: true };
const SIGNED_OUT = { isLoading: false, isAuthenticated: false };

/** The rendered text of a run list, for assertions about what a reader sees. */
function textOf(runs: readonly Inline[]): string {
  return runs.map((run) => run.text).join("");
}

describe("which screen a reader gets", () => {
  test("a resolved note", () => {
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_IN,
      note: note(),
      requestedPath: null,
    });
    expect(view.kind).toBe("ready");
  });

  test("signed out goes to sign-in, carrying the token back", () => {
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_OUT,
      note: undefined,
      requestedPath: null,
    });
    expect(view.kind).toBe("signIn");
    // The token is in one message and nowhere else — a rail has no entry that
    // could reproduce it, so losing it loses the share.
    expect(view.kind === "signIn" && view.href).toContain(encodeURIComponent(shareHref(TOKEN)));
  });

  /**
   * The gate holds whatever the note state is, and that is the half the tests
   * above did not reach: every signed-out fixture passed `note: undefined`, so
   * `!isAuthenticated` could be narrowed to `!isAuthenticated && note ===
   * undefined` and all 1,676 stayed green — while a reader who signs out with a
   * note already in state keeps reading it. Auth expiring mid-read is the same
   * shape, and it is not hypothetical: `note` is component state and survives
   * the auth flip.
   *
   * `undefined` is included so the three cases sit together and the axis is
   * visible rather than implied.
   */
  test.each([
    ["nothing loaded yet", undefined],
    ["a note already on screen", note()],
    ["a refusal already on screen", new Error("nope")],
  ])("signed out refuses with %s", (_label, loaded) => {
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_OUT,
      note: loaded as SharedNote | Error | undefined,
      requestedPath: null,
    });
    expect(view.kind).toBe("signIn");
  });

  test("signed out on a linked note comes back to that note, not the entry", () => {
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_OUT,
      note: undefined,
      requestedPath: "1-projects/proposal.md",
    });
    expect(view.kind === "signIn" && view.href).toContain(
      encodeURIComponent(shareHref(TOKEN, "1-projects/proposal.md")),
    );
  });

  // Both truth values of `isAuthenticated`, because the only fixture had it
  // false — so `isLoading` could be narrowed to `isLoading && !isAuthenticated`
  // undetected, and a session still resolving would render on the strength of a
  // stale `isAuthenticated: true`. "Still resolving" has to mean wait whatever
  // the other flag currently says.
  test.each([
    ["signed out", false],
    ["apparently signed in", true],
  ])("auth still resolving decides nothing (%s)", (_label, isAuthenticated) => {
    const view = resolveShareView({
      token: TOKEN,
      auth: { isLoading: true, isAuthenticated },
      note: undefined,
      requestedPath: null,
    });
    expect(view.kind).toBe("wait");
  });

  test("in flight is loading, not unavailable", () => {
    // A viewer that renders "not available" while the answer is still arriving
    // tells the reader their link is dead when it is not.
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_IN,
      note: undefined,
      requestedPath: null,
    });
    expect(view.kind).toBe("loading");
  });

  /**
   * THE rule. The server answers revoked, expired, not-yours, deleted,
   * made-private and not-linked with one `SHARE_UNAVAILABLE`, and this must not
   * undo that. Somebody who can tell "the owner revoked this" from "the owner
   * made it private" has learned two things about a context they are not in.
   */
  test("every refusal is the same screen", () => {
    const views = [
      new Error("SHARE_UNAVAILABLE"),
      new Error("revoked"),
      new Error("anything else at all"),
    ].map((error) =>
      resolveShareView({
        token: TOKEN,
        auth: SIGNED_IN,
        note: error,
        requestedPath: null,
      }),
    );
    expect(views.map((view) => view.kind)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("a missing token is the same screen as a spent one", () => {
    expect(
      resolveShareView({
        token: null,
        auth: SIGNED_IN,
        note: undefined,
        requestedPath: null,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  test("a linked note knows it is away from the entry", () => {
    const view = resolveShareView({
      token: TOKEN,
      auth: SIGNED_IN,
      note: note({ path: "1-projects/proposal.md" }),
      requestedPath: "1-projects/proposal.md",
    });
    expect(view.kind === "ready" && view.awayFromEntry).toBe(true);
  });
});

describe("the link", () => {
  test("matches the prefix the router and console use", () => {
    expect(SHARE_ROUTE).toBe("/s");
    expect(shareHref(TOKEN)).toBe(`/s/${TOKEN}`);
  });

  test("a linked note rides in the query, not the path", () => {
    // The token names what you have access to; the path names where you are
    // inside it. A reader who edits the query gets a refusal, never a
    // different share.
    expect(shareHref(TOKEN, "1-projects/a.md")).toBe(
      `/s/${TOKEN}?path=${encodeURIComponent("1-projects/a.md")}`,
    );
  });

  test("a repeated segment does not become a crash", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam(undefined)).toBeNull();
    expect(firstParam("a")).toBe("a");
  });

  test("a missing token still goes somewhere a reader can act on", () => {
    expect(shareSignInHref(null)).toContain("/login");
  });
});

describe("what a reader is offered next", () => {
  test("the note being read is never offered as a link to itself", () => {
    const links = onwardLinks(
      note({ path: "1-projects/a.md", links: ["1-projects/a.md", "1-projects/b.md"] }),
    );
    expect(links).toEqual(["1-projects/b.md"]);
  });

  test("a path becomes a name a person would recognise", () => {
    expect(linkLabel("1-projects/transition/implementation-handoff.md")).toBe(
      "Implementation handoff",
    );
    expect(linkLabel("overview.md")).toBe("Overview");
  });

  test("a filing code falls back to the path rather than to nothing", () => {
    expect(linkLabel("0-inbox/2026-08-29.md")).toBe("0-inbox/2026-08-29.md");
  });
});

/* -------------------------------------------------------------------------- */

describe("a hostile note cannot reach the reader", () => {
  /**
   * The one a reader could actually tap. A shared note is a document a stranger
   * wrote, and they have no reason to expect a link in it to be hostile.
   */
  test.each([
    ["javascript:alert(1)", "script execution"],
    ["JavaScript:alert(1)", "and its case variants"],
    ["data:text/html,<script>alert(1)</script>", "a data URL"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["file:///etc/passwd", "a local file"],
  ])("%s is not offered as a link (%s)", (href) => {
    expect(safeHref(href)).toBeNull();
  });

  test("a rejected link keeps its words, as text", () => {
    const runs = parseInline("see [the report](javascript:alert(1)) now");
    expect(runs.some((run) => run.kind === "link")).toBe(false);
    // The label was part of the sentence, so it is not silently dropped.
    expect(textOf(runs)).toContain("the report");
  });

  test("ordinary links still work", () => {
    expect(safeHref("https://example.invalid/x")).toBe("https://example.invalid/x");
    expect(safeHref("mailto:someone@example.invalid")).toBe(
      "mailto:someone@example.invalid",
    );
  });

  test("a control character in a URL makes it text", () => {
    expect(safeHref("https://example.invalid/\u0000x")).toBeNull();
  });

  /**
   * The anchor, which every case above leaves unpinned.
   *
   * Each hostile href in the list has its scheme at position 0, so dropping the
   * `^` from SAFE_SCHEME rejects all of them anyway and the mutation goes
   * unnoticed — the fixtures hold "where the scheme sits" constant, which is
   * the one axis this regex is about. Unanchored, any `javascript:` URL that
   * mentions a safe scheme *later* becomes tappable, and a hostile note is
   * written by somebody who gets to choose the rest of the string.
   */
  test.each([
    'javascript:fetch("https://example.invalid")',
    "javascript:void(0);//https:",
    "data:text/html,<a href=mailto:x@y.invalid>z</a>",
    "vbscript:msgbox(1)'tel:123",
  ])("%s stays text even though a safe scheme appears later in it", (href) => {
    expect(safeHref(href)).toBeNull();
  });

  test("a safe scheme in caps is still a link", () => {
    // The `i` flag has no test: the existing "JavaScript:alert(1)" case is
    // refused with or without it, so only a POSITIVE case pins it. Dropping the
    // flag fails closed — an uppercase-scheme URL in somebody's note quietly
    // stops being tappable — which is a regression nobody would see reported.
    expect(safeHref("HTTPS://example.invalid/x")).toBe("HTTPS://example.invalid/x");
    expect(safeHref("MailTo:someone@example.invalid")).toBe("MailTo:someone@example.invalid");
  });

  test("and the rule is about the scheme, not a substring blacklist", () => {
    // An ordinary https URL whose *query* names a hostile scheme is a link. A
    // blacklist over the whole string would refuse it, and the note's author
    // would have no way to write about javascript: at all.
    const href = "https://example.invalid/docs?q=javascript:alert(1)";
    expect(safeHref(href)).toBe(href);
  });

  /**
   * A remote image in somebody else's note is a tracking pixel — and because a
   * share is addressed to one named person, it is a read receipt they never
   * agreed to. The alt text renders; nothing is fetched.
   */
  test("an image is alt text and never a fetch", () => {
    const runs = parseInline("![a diagram](https://tracker.invalid/pixel.png)");
    expect(textOf(runs)).toBe("a diagram");
    expect(JSON.stringify(runs)).not.toContain("tracker.invalid");
  });

  test("HTML in a note is text, not markup", () => {
    const parsed = parseNote("<script>alert(1)</script>\n\nAfter.");
    const rendered = JSON.stringify(parsed.blocks);
    // It appears as literal text in a paragraph, and no block claims to be
    // anything but a paragraph.
    expect(rendered).toContain("script");
    expect(parsed.blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });

  test("an enormous note is cut short, and says so", () => {
    const parsed = parseNote("para\n\n".repeat(MAX_BLOCKS + 50));
    expect(parsed.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    // Never presented as a whole document.
    expect(parsed.truncated).toBe(true);
  });

  test("an ordinary note is not marked truncated", () => {
    expect(parseNote("# A\n\nB\n").truncated).toBe(false);
  });
});

describe("what a note looks like", () => {
  test("headings, at their level", () => {
    const parsed = parseNote("# One\n\n## Two\n\n###### Six\n");
    expect(parsed.blocks.map((b) => b.kind === "heading" && b.level)).toEqual([1, 2, 6]);
  });

  test("paragraphs join their lines the way markdown means them to", () => {
    const parsed = parseNote("one\ntwo\n\nthree\n");
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0].kind === "paragraph" && textOf(parsed.blocks[0].content)).toBe(
      "one two",
    );
  });

  test("bullet and ordered lists", () => {
    const parsed = parseNote("- a\n- b\n\n1. x\n2. y\n");
    expect(parsed.blocks.map((b) => b.kind)).toEqual(["bullet", "ordered"]);
  });

  test("a blockquote", () => {
    const parsed = parseNote("> quoted\n> still quoted\n");
    expect(parsed.blocks[0].kind).toBe("quote");
  });

  /**
   * The reason this note was shared, usually. A fence runs to its close or to
   * the end of the note, and nothing inside it is markup.
   */
  test("a fenced block keeps every character", () => {
    const diagram = ["```", "+------+", "| box  |", "**not bold**", "```"].join("\n");
    const parsed = parseNote(diagram);
    expect(parsed.blocks[0].kind).toBe("code");
    expect(parsed.blocks[0].kind === "code" && parsed.blocks[0].text).toBe(
      "+------+\n| box  |\n**not bold**",
    );
  });

  test("an unterminated fence swallows the rest, as every renderer does", () => {
    const parsed = parseNote("intro\n\n```\nnever closed\n# not a heading\n");
    expect(parsed.blocks.map((b) => b.kind)).toEqual(["paragraph", "code"]);
  });

  test("a table needs its delimiter row, or it is prose with pipes in it", () => {
    const table = parseNote("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(table.blocks[0].kind).toBe("table");

    const prose = parseNote("costs | benefits, roughly\n");
    expect(prose.blocks[0].kind).toBe("paragraph");
  });

  test("thematic breaks", () => {
    expect(parseNote("---\n").blocks[0].kind).toBe("rule");
    expect(parseNote("***\n").blocks[0].kind).toBe("rule");
  });

  /**
   * Frontmatter is filing metadata, and `visibility:` at the top of a shared
   * document reads as a statement about the *reader's* access — which it is
   * not. Showing it would be actively misleading.
   */
  test("frontmatter is not part of the document", () => {
    const parsed = parseNote("---\nvisibility: team\n---\n\n# Real title\n");
    expect(JSON.stringify(parsed.blocks)).not.toContain("visibility");
    expect(noteTitle(parsed.blocks)).toBe("Real title");
  });

  test("a note that opens with prose has no title of its own", () => {
    expect(noteTitle(parseNote("Just prose.\n").blocks)).toBeNull();
  });
});

describe("inline markup", () => {
  test("bold, italic, strikethrough and code", () => {
    const runs = parseInline("**b** *i* ~~s~~ `c`");
    expect(runs.filter((r) => r.kind !== "text").map((r) => r.kind)).toEqual([
      "strong",
      "em",
      "strike",
      "code",
    ]);
  });

  /**
   * Inside a code span nothing else is markup — which is the case somebody
   * documenting Markdown in a shared note will hit immediately.
   */
  test("markup inside a code span is literal", () => {
    const runs = parseInline("write `**not bold**` here");
    const code = runs.find((run) => run.kind === "code");
    expect(code?.text).toBe("**not bold**");
    expect(runs.some((run) => run.kind === "strong")).toBe(false);
  });

  /**
   * `_` is not emphasis. `resolve_addressed_user` is an ordinary word in these
   * notes, and italicising half of one is worse than missing emphasis.
   */
  test("underscores in a snake_case word are not emphasis", () => {
    const runs = parseInline("call resolve_addressed_user here");
    expect(runs.every((run) => run.kind === "text")).toBe(true);
  });

  test("a wikilink shows its label, and is not a link", () => {
    expect(textOf(parseInline("[[proposal|the proposal]]"))).toBe("the proposal");
    expect(textOf(parseInline("[[proposal]]"))).toBe("proposal");
    expect(parseInline("[[proposal]]").some((run) => run.kind === "link")).toBe(false);
  });

  /**
   * A relative link points into a bucket the reader has no access to. The
   * share's own traversal offers the linked notes separately, as buttons.
   */
  test("a relative link is text, because it is not a URL the reader can open", () => {
    const runs = parseInline("see [the proposal](proposal.md)");
    expect(runs.some((run) => run.kind === "link")).toBe(false);
    expect(textOf(runs)).toContain("the proposal");
  });
});

/**
 * THREE BUGS A SCREENSHOT FOUND AND FORTY-TWO TESTS DID NOT.
 *
 * Every test above passed while the rendered page showed a stray `)` beside a
 * rejected link, the note's title printed twice, and every heading at one size.
 * The assertions were about the *parse*, and all three bugs were downstream of
 * it — which is the same shape of gap as the vacuous caret test in the console
 * editor: an assertion has to be against the thing that can be wrong.
 */
describe("what the page actually renders", () => {
  /**
   * `[click me](javascript:alert(1))` — a regex that stops at the first `)`
   * cuts the target in half and leaves the trailing paren as text next to the
   * label. Visible on screen; invisible to "is it a link?".
   */
  test("a rejected link leaves no punctuation behind", () => {
    const runs = parseInline("Not a link: [click me](javascript:alert(1)) — done");
    expect(textOf(runs)).toBe("Not a link: click me — done");
  });

  test("a link with parentheses in its URL is consumed whole", () => {
    const runs = parseInline("[wiki](https://example.invalid/Foo_(bar)) after");
    const link = runs.find((run) => run.kind === "link");
    expect(link?.kind === "link" && link.href).toBe("https://example.invalid/Foo_(bar)");
    expect(textOf(runs)).toBe("wiki after");
  });

  /**
   * …but not greedily to the last paren in the line: an aside after a link is
   * not part of its URL.
   */
  test("an aside after a link is not swallowed into it", () => {
    const runs = parseInline("[a](https://example.invalid/x) and (an aside)");
    expect(textOf(runs)).toBe("a and (an aside)");
  });

  test("an image with parens in its URL still renders as alt text only", () => {
    const runs = parseInline("![alt](https://tracker.invalid/p(1).png)");
    expect(textOf(runs)).toBe("alt");
  });

  test("a title after the target is not part of the URL", () => {
    const runs = parseInline('[a](https://example.invalid/x "The Title")');
    const link = runs.find((run) => run.kind === "link");
    expect(link?.kind === "link" && link.href).toBe("https://example.invalid/x");
  });

  /**
   * The page prints the note's name as its heading. If that name came from the
   * note's own H1, the H1 must not also appear in the body — otherwise the
   * reader is told the same thing twice, one line apart.
   */
  test("the title is not printed twice", () => {
    const parsed = parseNote("# Chapter transition\n\nBody.\n");
    const title = noteTitle(parsed.blocks);
    expect(title).toBe("Chapter transition");

    // What `ShareScreen` renders in the body when the title came from the note.
    const body = title === null ? parsed.blocks : parsed.blocks.slice(1);
    expect(body.some((block) => block.kind === "heading" && block.level === 1)).toBe(
      false,
    );
    expect(body).toHaveLength(1);
  });

  test("a note with no H1 keeps every block in the body", () => {
    const parsed = parseNote("Just prose.\n\n## A section\n");
    const title = noteTitle(parsed.blocks);
    const body = title === null ? parsed.blocks : parsed.blocks.slice(1);
    expect(title).toBeNull();
    expect(body).toHaveLength(parsed.blocks.length);
  });
});
