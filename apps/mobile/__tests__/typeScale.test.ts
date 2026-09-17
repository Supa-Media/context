import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@jest/globals";

import { pointerType, touchType, typeFor } from "../features/design/tokens";

/**
 * The type scale's contract.
 *
 * This file exists because `tokens.ts` shipped for the whole life of the app
 * without a type scale, and the cost was measurable rather than aesthetic: 26
 * distinct font sizes across `features/` and `app/`, drifting in half-points.
 * Every assertion below is aimed at the way that happened — one screen at a
 * time, each nudge individually defensible.
 */

const ROLES = ["label", "meta", "ui", "lede", "body", "h3", "h2", "title", "display"] as const;

describe("the type scale", () => {
  test("both densities declare exactly the same roles", () => {
    expect(Object.keys(pointerType).sort()).toEqual(Object.keys(touchType).sort());
  });

  test("the roles are the nine that were designed, and no more", () => {
    // The guard against drifting back: a tenth role is how 9 becomes 26, and
    // it always arrives as one reasonable-looking addition.
    expect(Object.keys(pointerType).sort()).toEqual([...ROLES].sort());
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s sizes are whole numbers", (_name, scale) => {
    const fractional = Object.entries(scale).filter(([, size]) => !Number.isInteger(size));
    // Half-points are never a decision — they are a nudge that stuck, and they
    // blur on any display that is not 2x.
    expect(fractional).toEqual([]);
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s sizes are positive", (_name, scale) => {
    expect(Object.values(scale).every((size) => size > 0)).toBe(true);
  });

  test.each([
    ["pointer", pointerType],
    ["touch", touchType],
  ])("%s ascends from label to display", (_name, scale) => {
    const sizes = ROLES.map((role) => scale[role]);
    const ascending = sizes.every((size, index) => index === 0 || size >= sizes[index - 1]!);
    expect(ascending).toBe(true);
  });

  test("touch is not pointer scaled up — the title is deliberately smaller", () => {
    // A phone's measure is roughly 342pt against the console's 640. A title
    // set at the pointer size wraps to three lines there, which is not
    // emphasis, it is an obstacle. This is the one role that shrinks, and it
    // is pinned so that a future "make everything bigger on mobile" cannot
    // quietly take it with the rest.
    expect(touchType.title).toBeLessThan(pointerType.title);
  });

  test("everything a finger drives is at least as large on touch", () => {
    for (const role of ["ui", "lede", "body"] as const) {
      expect(touchType[role]).toBeGreaterThanOrEqual(pointerType[role]);
    }
  });
});

describe("typeFor", () => {
  test("the phone gets the touch scale", () => {
    expect(typeFor("compact")).toBe(touchType);
  });

  test("both pointer densities share one scale", () => {
    // A medium window is a narrower desktop, not a larger phone.
    expect(typeFor("medium")).toBe(pointerType);
    expect(typeFor("wide")).toBe(pointerType);
  });
});

/* ------------------------------------------------------------------ *
 * The ratchet.
 *
 * `Text.tsx` is where the drift started and the rest of the tree is where it
 * spread: a hundred literal sizes across forty-three files, in the same
 * half-point shape — 10.5 beside 11, 12.5 beside 12, 15.5 beside 15 and 16.
 * They are all roles from this scale now, so the whole tree is held to it
 * rather than one file.
 *
 * Reading source is crude, and it is the only thing that catches this before
 * it ships: the rendered difference between `fontSize: 13.5` and
 * `fontSize: pointerType.ui` is half a point, which no render test would ever
 * be written to notice.
 *
 * A screen that genuinely needs a size the scale does not have is a change to
 * the scale, made in `tokens.ts`, with a reviewer — not a number in a
 * stylesheet. A numeric `fontSize` that is **data** rather than style — a
 * drawing element carries its own, for instance — would need an exemption
 * named here, with its reason. There are none today, which is the point.
 * ------------------------------------------------------------------ */
describe("the tree draws its type from the scale", () => {
  const ROOTS = ["features", "app"];

  function sources(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
      // A committed build output is not a stylesheet anybody writes, and its
      // minified identifiers collide with everything a source scan looks for.
      // `.generated.ts` is checked by the workflow that rebuilds it instead.
      if (entry.name.endsWith(".generated.ts")) return [];
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  const files = ROOTS.flatMap((root) => sources(join(__dirname, "..", root)));

  test("there is a tree to check", () => {
    // A glob that silently matches nothing is a guard that always passes.
    expect(files.length).toBeGreaterThan(200);
  });

  test("no stylesheet carries a literal font size", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/fontSize: ([0-9][0-9.]*)/g)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${file.split("/apps/mobile/")[1] ?? file}:${line} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every size it does name is a role that exists", () => {
    const roles = new Set(Object.keys(pointerType));
    const named: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /fontSize: (?:pointerType|touchType|t)\.([A-Za-z0-9]+)/g,
      )) {
        named.push(match[1]!);
      }
    }
    expect(named.length).toBeGreaterThan(50);
    expect([...new Set(named.filter((role) => !roles.has(role)))]).toEqual([]);
  });
});

/**
 * The markdown heading ladder.
 *
 * Six levels need six sizes. Before the scale, `h5` and `h6` were 13.5 and 13
 * — a difference no reader could see, but one the renderer still owed the
 * document, and the obvious mapping put both on `ui` and collapsed a level
 * without anything failing. This is the assertion that would have caught it.
 */
describe("a rendered note keeps six heading levels", () => {
  const SIZES: Record<string, number> = pointerType as unknown as Record<string, number>;
  const source = readFileSync(
    join(__dirname, "..", "features", "share", "NoteBody.tsx"),
    "utf8",
  );

  const ladder = [...source.matchAll(/h([1-6]): \{ fontSize: t\.([A-Za-z0-9]+)/g)].map(
    (match) => ({ level: Number(match[1]), size: SIZES[match[2]!]! }),
  );

  test("all six are declared", () => {
    expect(ladder.map((entry) => entry.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("each level is strictly smaller than the one above it", () => {
    const sizes = ladder.map((entry) => entry.size);
    expect(sizes.every((size, index) => index === 0 || size < sizes[index - 1]!)).toBe(true);
  });
});

/**
 * AND THE EDITOR'S OWN LADDER IS THE SAME LADDER.
 *
 * `livePreviewStyles` sizes a rendered heading in `em` — a multiple of the
 * editor's body size — and for most of this file's life those multiples were a
 * *third* scale: 1.625 / 1.3 / 1.15, measured off Obsidian mobile, after a
 * 1.7 / 1.4 / 1.2 that was measured off nothing. Neither was `pointerType`.
 *
 * Two scales in one application is one of them being wrong wherever they meet,
 * and where they met was the note: a 30pt title in the tokens, a 26pt one on
 * the page. The design canvas sides with the tokens, so the multiples are now
 * `title / body`, `h2 / body` and `h3 / body` — and this is the assertion that
 * keeps them there, because an `em` in a template literal is exactly the kind
 * of number that gets nudged.
 */
describe("the editor's heading ladder is the type scale", () => {
  /*
    Read as source, not imported, exactly as the `NoteBody.tsx` block above is.
    `livePreview.ts` pulls in `@codemirror/*`, which this suite's jest project
    does not transform — importing it fails the whole file to *run*, which is a
    suite that reports nothing rather than a suite that reports green, but is
    still not a guard.
  */
  const LIVE_PREVIEW = readFileSync(
    join(__dirname, "..", "features", "console", "files", "livePreview.ts"),
    "utf8",
  );
  const RATIOS = [...LIVE_PREVIEW.matchAll(/\.cm-lp-h([1-3]) \{ font-size: ([\d.]+)em/g)].map(
    (match) => ({ level: Number(match[1]), ratio: Number(match[2]) }),
  );

  test("the three that map to a named role are all declared", () => {
    // Vacuity guard: a regex that stops matching would otherwise make every
    // case below pass by finding nothing.
    expect(RATIOS.map((entry) => entry.level)).toEqual([1, 2, 3]);
  });

  test("each is its role divided by the body size", () => {
    const expected = [pointerType.title, pointerType.h2, pointerType.h3].map(
      (size) => size / pointerType.body,
    );
    expect(RATIOS.map((entry) => entry.ratio)).toEqual(expected);
  });
});
