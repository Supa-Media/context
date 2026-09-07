/**
 * The HTML converter, tested as what it is: a parser for input an attacker
 * chose, byte by byte, specifically to break it.
 *
 * Two properties matter more than fidelity:
 *
 *   1. **It always finishes, in time linear in its input.** The timing
 *      assertions below are deliberately generous — they are not benchmarks,
 *      they are tripwires for the exponential blow-up that a regex-based
 *      implementation exhibits on these exact inputs.
 *   2. **It never emits more than it was told to.** Entity expansion means the
 *      output can be larger than the markup that produced it, so the cap is
 *      enforced on the way out, not inferred from the way in.
 */
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html";

const CAP = 100_000;

describe("converting HTML to text", () => {
  it("keeps the words and drops the markup", () => {
    expect(htmlToText("<p>Hello <b>there</b>.</p><p>Bye.</p>", CAP)).toBe("Hello there.\n\nBye.");
  });

  it("turns breaks and list items into lines", () => {
    expect(htmlToText("a<br>b<ul><li>one</li><li>two</li></ul>", CAP)).toBe(
      "a\nb\n\n- one\n- two",
    );
  });

  it("resolves the entities it knows and leaves the rest alone", () => {
    expect(htmlToText("a &amp; b &lt;c&gt; &#65; &#x42; &notanentity;", CAP)).toBe(
      "a & b <c> A B &notanentity;",
    );
  });

  it("refuses to resolve a control character out of a numeric entity", () => {
    // `&#0;` and `&#13;` are how you smuggle a NUL or a CR past a naive
    // converter and into a note. They stay literal.
    expect(htmlToText("a&#0;b&#13;c&#127;d", CAP)).toBe("a&#0;b&#13;c&#127;d");
  });

  it("refuses a lone surrogate, which is not a character", () => {
    expect(htmlToText("a&#xD800;b", CAP)).toBe("a&#xD800;b");
  });
});

describe("content that is not text is not emitted", () => {
  it("drops script and style bodies whole", () => {
    expect(
      htmlToText("<p>before</p><script>alert('x')</script><style>p{}</style><p>after</p>", CAP),
    ).toBe("before\n\nafter");
  });

  it("does not let markup inside a script close it", () => {
    // Sabotage: match the closing tag with a non-greedy `[\s\S]*?</` and a
    // `</div>` inside the script ends the skip early, leaking script source.
    expect(htmlToText("<script>var a = '</div>'; alert(1)</script>done", CAP)).toBe("done");
  });

  it("drops head, title, svg, iframe and noscript", () => {
    const html =
      "<head><title>secret</title></head><svg><text>vector</text></svg>" +
      "<iframe>frame</iframe><noscript>ns</noscript><p>body</p>";
    const text = htmlToText(html, CAP);
    expect(text).toBe("body");
    for (const leaked of ["secret", "vector", "frame", "ns"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("drops link targets, keeping only the words", () => {
    // A URL is the most useful thing to smuggle into someone's notes. It
    // renders as friendly text and points somewhere else.
    const text = htmlToText('<a href="https://evil.test/steal">click here</a>', CAP);
    expect(text).toBe("click here");
    expect(text).not.toContain("evil.test");
  });

  it("drops image alt text", () => {
    expect(htmlToText('<img alt="instructions for the assistant" src="x">after', CAP)).toBe("after");
  });

  it("does not let a quoted attribute value end a tag early", () => {
    expect(htmlToText('<div title="a > b">text</div>', CAP)).toBe("text");
  });

  it("swallows an unterminated comment, like a browser does", () => {
    expect(htmlToText("visible<!-- hidden forever", CAP)).toBe("visible");
  });

  it("keeps a bare `<` that is not a tag", () => {
    expect(htmlToText("1 < 2 and 3 > 2", CAP)).toBe("1 < 2 and 3 > 2");
  });
});

describe("it cannot be made to run long", () => {
  /**
   * Work done, not time elapsed. A wall-clock budget here (there used to be
   * one: `expect(Date.now() - started).toBeLessThan(1_000)`) is a bet that
   * this process gets a full core's attention for the length of the test —
   * true on a quiet machine and false under ten parallel `turbo` tasks, where
   * the same linear-time code can miss a generous budget for reasons that
   * have nothing to do with a regression in `html.ts`. Flaky red on a fast
   * machine trains everyone to re-run rather than look, which is how a real
   * regression here would actually get missed.
   *
   * `htmlToText`'s `onStep` hook is called once per iteration of its three
   * loops (the outer scan and its two inner tag-scanning loops), and every
   * one of those iterations strictly advances a cursor into `html` and never
   * revisits a position — see the hook's doc comment in `html.ts`. So the
   * total call count over one run is bounded by a small constant multiple of
   * `html.length` REGARDLESS of machine speed, load, or how many other tests
   * happen to be running: a fixed, size-derived ceiling rather than a
   * time-derived one. A regression that reintroduces the backtracking regex
   * this scanner was written to avoid restructures these loops away entirely,
   * which this bound would catch by construction — there would be nothing
   * left calling `onStep` at all, and the assertion below would never see the
   * count it expects.
   */
  const attacks: Record<string, string> = {
    "many unclosed script opens": "<script ".repeat(50_000),
    "nested unclosed tags": "<div><span><b>".repeat(30_000),
    "an ocean of angle brackets": "<".repeat(400_000),
    "a very long unterminated attribute": `<div title="${"a".repeat(300_000)}`,
    "endless ampersands": "&".repeat(300_000),
    "endless entity openers": "&#x".repeat(100_000),
    "one enormous tag name": `<${"a".repeat(300_000)}>text`,
    "alternating tag and text": "<b>a</b>".repeat(50_000),
    "unterminated comment openers": "<!--".repeat(100_000),
  };

  it.each(Object.entries(attacks))("%s", (_name, html) => {
    let steps = 0;
    const text = htmlToText(html, CAP, () => {
      steps += 1;
    });
    // 3x is headroom for the (rare) input position visited by both an inner
    // tag-scanning loop and the outer loop's own bookkeeping around it, not a
    // knob to widen if this ever fails — a genuine regression here blows the
    // count out by orders of magnitude, not by a few percent.
    expect(steps).toBeLessThanOrEqual(html.length * 3 + 100);
    expect(text.length).toBeLessThanOrEqual(CAP);
  });

  it("the step count actually tracks a real slowdown, not just a fast one", () => {
    // Sabotage-test the tripwire itself: without this, a bound nothing ever
    // exercises above its own floor is a bound that could report zero calls
    // and still "pass". A tag name long enough that its scan loop dominates
    // must push the count close to the input length, not leave it near zero.
    let steps = 0;
    const html = `<${"a".repeat(10_000)}>text`;
    htmlToText(html, CAP, () => {
      steps += 1;
    });
    expect(steps).toBeGreaterThan(9_000);
  });
});

describe("the output cap is enforced on the output", () => {
  it("truncates plain text at the cap", () => {
    expect(htmlToText("x".repeat(5_000), 100)).toHaveLength(100);
  });

  it("truncates entity-expanded text at the cap", () => {
    // 3 chars of markup per emitted character: a naive "cap the input" would
    // let this through at three times the intended size.
    expect(htmlToText("&#65;".repeat(5_000), 100).length).toBeLessThanOrEqual(100);
  });

  it("truncates structural newlines at the cap too", () => {
    expect(htmlToText("<br>".repeat(5_000), 10).length).toBeLessThanOrEqual(10);
  });
});

describe("whitespace", () => {
  it("collapses runs without joining words", () => {
    expect(htmlToText("<p>a     b\n\n\n\tc</p>", CAP)).toBe("a b c");
  });

  it("never leaves more than one blank line", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p></p><p>b</p>", CAP)).toBe("a\n\nb");
  });

  it("trims the ends", () => {
    expect(htmlToText("<br><br>  hello  <br><br>", CAP)).toBe("hello");
  });
});
