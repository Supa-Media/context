/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { applyTheme, connect, darkColors, guestStyles, layout, lightColors, NOTE, themeVars } from "./fixtures";

describe("the palette", () => {
  test("both palettes reach the document, and a change of appearance is not a reload", () => {
    const w = connect({ doc: NOTE, editable: true });
    const read = (name: string) => document.documentElement.style.getPropertyValue(name);

    expect(read("--lp-bg")).toBe(darkColors.surface);

    const before = w.view.state.doc.toString();
    w.host.setTheme(themeVars(lightColors, "Menlo", true));
    expect(read("--lp-bg")).toBe(lightColors.surface);
    // The editor was reconfigured, not rebuilt: a colour change must not cost
    // the caret and the undo history.
    expect(w.view.state.doc.toString()).toBe(before);
    w.destroy();
  });

  /*
    The note's type is one size, and the density decides other things.

    This used to assert 16px against 14.5px and was named for the measure
    changing with the density. Both halves were wrong to keep: the pointer's
    14.5px had nothing arguing for it, and because the measure is a multiple
    of the type it shrank the column as well as the glyphs. The size is now
    the same at both densities and this asserts that it is — a re-split is a
    decision, not a tidy-up, and it would move the column too.

    What still branches is drawn here alongside it, so a reader can see the
    difference is deliberate rather than left over: a phone reads the note in
    full-strength text, a pointer inspects it beside a file tree in the
    quieter one.
  */
  test("the note's type is one size at both densities, and the tone is not", () => {
    expect(themeVars(darkColors, "Menlo", true)["--lp-size"]).toBe("16px");
    expect(themeVars(darkColors, "Menlo", false)["--lp-size"]).toBe("16px");
    expect(themeVars(darkColors, "Menlo", true)["--lp-content"]).toBe(darkColors.text);
    expect(themeVars(darkColors, "Menlo", false)["--lp-content"]).toBe(darkColors.text2);
  });

  /**
   * THE OTHER HALF OF THE GUARD `liveEditorMount.test.ts` HOLDS.
   *
   * That one proves the web console declares every `--lp-*` its stylesheets
   * read. This is the same relationship on the host where the values arrive
   * over a bridge — and the consequence of a gap is worse here, because an
   * undeclared custom property does not fall back, it invalidates the whole
   * declaration that names it. The note keeps rendering, without whatever that
   * declaration was doing.
   *
   * Two questions, because there are two suppliers: the `:root` block in
   * `styles.ts` is what a guest whose first theme message never arrives sees,
   * and `themeVars` is what every real one gets.
   */
  test("every --lp-* the guest stylesheet reads is one its own :root declares", () => {
    const css = guestStyles();
    const open = css.indexOf(":root {");
    expect(open).toBeGreaterThan(-1);
    const root = css.slice(open, css.indexOf("}", open));

    const declared = new Set([...root.matchAll(/(--lp-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const read = new Set([...css.matchAll(/var\(\s*(--lp-[a-z0-9-]+)/g)].map((m) => m[1]));

    expect([...read].filter((property) => !declared.has(property))).toEqual([]);
    // Named so a regression says which one went: the measure is the only
    // property here that is not a colour or a face, and losing it is invisible
    // in a screenshot of a short note.
    expect([...declared]).toContain("--lp-measure");
  });

  test("and every one the host is responsible for is in themeVars", () => {
    const css = guestStyles();
    const read = [...css.matchAll(/var\(\s*(--lp-[a-z0-9-]+)/g)].map((m) => m[1]);
    const sent = themeVars(darkColors, "Menlo", true);

    /*
      The one exception, and it is a real one rather than an excuse:
      `--lp-inset-bottom` is how much of the editor the keyboard is covering.
      It is measured on the device and written by the `inset` message (see
      `guest.ts`), so it changes many times per second while a keyboard is
      animating and has no business in a theme.
    */
    const missing = [...new Set(read)].filter(
      (property) => property !== "--lp-inset-bottom" && !(property in sent),
    );
    expect(missing).toEqual([]);
  });

  test("the note is drawn as a measured, centred column on this host too", () => {
    // Comments stripped: this rule carries a long one, and the assertions
    // below are about which properties are and are not set rather than about
    // what the prose beside them mentions.
    const css = guestStyles().replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf("#root .cm-content {");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));

    expect(rule).toContain("padding-inline: max(0px, calc((100% - var(--lp-measure) * 1em) / 2))");
    // The same rule the web console has, on the column rather than the line,
    // and by padding rather than by width — see `liveEditorMount.test.ts` for
    // both halves of why.
    expect(rule).not.toContain("max-width");
    expect(css.slice(css.indexOf("#root .cm-line {"))).not.toMatch(
      /^#root \.cm-line \{[^}]*(max-width|padding-inline)/,
    );
  });

  test("the reading measure is a bare multiple, so it is one value for both densities", () => {
    const compact = themeVars(darkColors, "Menlo", true)["--lp-measure"];
    const pointer = themeVars(darkColors, "Menlo", false)["--lp-measure"];

    /*
      Unlike every other line in `themeVars`, this one does not branch on
      `compact` — and that is the argument rather than an oversight. A measure
      stated as a multiple of the type is the same line whatever the type
      scale is, so it survives a change to either density's size; a pixel
      measure would have been two numbers kept in step by hand. Both densities
      happen to draw 16px today, which makes the property constant twice over
      rather than making the indirection pointless.
    */
    expect(compact).toBe(pointer);

    /*
      And it carries NO UNIT. A font-relative length inside a custom property
      may be resolved where the property is declared or where it is used, and
      engines differ. The wrapper and the note also draw in different faces —
      Times New Roman on the wrapper, a sans in the note — which is what made
      `ch` ambiguous here, and their sizes agreeing today is not something this
      may lean on. `styles.ts`
      multiplies by 1em against the text itself. A unit sneaking back in here
      is that ambiguity returning, silently, on one engine only.
    */
    expect(compact).toMatch(/^\d+$/);

    /*
      The band the number has to stay inside, which is the design decision
      rather than the value. Prose in a system sans averages 0.45-0.55em a
      character, so 40em is roughly 73-89 characters and the comfortable range
      is 60-75. Anything outside this changes how the note reads and should
      have to edit a test that says so.
      `e2e/webkit/readingMeasure.spec.ts` checks the rendered result.
    */
    expect(layout.readingMeasureEm).toBeGreaterThanOrEqual(30);
    expect(layout.readingMeasureEm).toBeLessThanOrEqual(40);
  });

  test("the phone's own width is what governs there — the measure cannot bind", () => {
    const compact = themeVars(darkColors, "Menlo", true);
    const ems = Number(compact["--lp-measure"]);
    const size = Number(compact["--lp-size"]?.replace("px", ""));
    const pad = Number(compact["--lp-pad-x"]?.replace("px", ""));

    /*
      The measure in points is exactly the multiple times the type size — no
      font metric involved, which is the other half of why the unit is em: this
      arithmetic is the layout's, not a guess about a face. Against the widest
      phone this app runs on (a 430pt iPhone Pro Max, wider than the 390 the
      WebKit suite uses) the text column is still far narrower, so the padding
      that insets the column computes to zero and `--lp-pad-x` decides the line
      length. If that ever stops being true the phone quietly gains a centred
      column with slack either side, which is not what a note on a phone should
      look like.
    */
    const widestPhone = 430 - 2 * pad;
    expect(ems * size).toBeGreaterThan(widestPhone);
  });

  test("only our own custom properties are written", () => {
    const target = document.createElement("div");
    applyTheme(target, {
      "--lp-bg": "#123456",
      // Not ours. A theme message is host-authored, but this is the one place a
      // string becomes CSS and a property name is the cheapest thing to bound.
      "--other": "#000",
      "background": "red",
    });
    expect(target.style.getPropertyValue("--lp-bg")).toBe("#123456");
    expect(target.style.getPropertyValue("--other")).toBe("");
    expect(target.style.background).toBe("");
  });
});
