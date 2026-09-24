import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, test } from "@jest/globals";

/**
 * Colours live in the palette, and the retired ones stay retired.
 *
 * `theme.test.ts` already refuses the eight framework defaults *as palette
 * values*. That guard was not enough, and the way it failed is worth keeping:
 * the console avatar was painted
 * `linear-gradient(140deg,#3B82F6,#8B5CF6)` — blue-500 to violet-500 — in two
 * components, over a flat `#5F6EF6` fallback. None of those are palette
 * values, so nothing looked at them, and the one mark on screen that says
 * "this is yours" went on wearing the exact two colours the repaint was
 * supposed to have removed. It took running the app and looking at it.
 *
 * So the rule is the stronger one: a component does not name a colour at all.
 * It reads one from `useColors()`. The exemptions below are colours that are
 * genuinely not ours to choose.
 */

/**
 * Colours that are genuinely not the palette's to choose. Each needs a reason,
 * and the reason is the point: an exemption without one is a bypass with
 * paperwork.
 */
const EXEMPT = new Map<string, string>([
  ["#FF5F57", "macOS window close pip — the OS's colour, not ours"],
  ["#FEBC2E", "macOS window minimise pip"],
  ["#28C840", "macOS window zoom pip"],
  ["#000", "a shadow's ink, not a hue. See the note below about warming it."],
  ["#FFFFFF", "DrawingView's paper: white in both themes on purpose — what is inside the frame is the customer's drawing, not our chrome"],
]);

/**
 * Comments are documentation, not use.
 *
 * This file's whole reason for existing is a retired colour that survived in a
 * gradient string, and the fix for that should not make it impossible to
 * *write down* which colours were retired and why — `tokens.ts` names all
 * eight in prose, and so does the comment on the avatar that this test was
 * born from. So the scan runs on code with comments removed rather than on
 * raw text with a fragile "does this line start with a star" heuristic, which
 * is what the first version of this test used and which missed a value sitting
 * on the second line of a block comment.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The framework defaults the palette retired. These may not appear at all. */
const RETIRED = [
  "#3B82F6",
  "#2563EB",
  "#34D399",
  "#FBBF24",
  "#F87171",
  "#DC2626",
  "#8B5CF6",
  "#7C3AED",
];

/**
 * The same colours as rgb triplets, because hex is not the only way to write
 * one down and the second escape used the other way.
 *
 * `rgba(59,130,246,.10)` is blue-500, and it was painting the halo behind the
 * hero on five screens — the landing, login, the error boundary, the dead-link
 * page and a shared note — while a hex-only scan reported the palette clean.
 * `rgba(251,146,86,…)` is the retired landing orange, which had never been a
 * palette value at all.
 */
const RETIRED_RGB: Array<[string, [number, number, number]]> = [
  ["blue-500", [59, 130, 246]],
  ["blue-600", [37, 99, 235]],
  ["emerald-400", [52, 211, 153]],
  ["amber-400", [251, 191, 36]],
  ["red-400", [248, 113, 113]],
  ["violet-500", [139, 92, 246]],
  ["the retired landing orange", [251, 146, 86]],
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    if (entry.name.endsWith(".generated.ts")) return [];
    // The palette itself is where colours are allowed to be written down —
    // `design/tokens.ts` is now a facade re-exporting `design/tokens/*`, split
    // by token family, and the colour literals live in that directory's
    // `colors.ts`.
    if (full.endsWith(join("design", "tokens.ts"))) return [];
    if (full.includes(join("design", "tokens") + sep)) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const FILES = ["features", "app"].flatMap((root) => sources(join(__dirname, "..", root)));
const short = (file: string) => file.split("/apps/mobile/")[1] ?? file;

describe("components read colours, they do not name them", () => {
  test("there is a tree to check", () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  test("no retired framework default appears anywhere, in any form", () => {
    // Deliberately not anchored to a `backgroundColor:` — the one that got
    // through was inside a gradient string.
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const value of RETIRED) {
        const hit = new RegExp(value, "i").exec(code);
        if (!hit) continue;
        offenders.push(`${short(file)}:${code.slice(0, hit.index).split("\n").length} -> ${value}`);
      }
      for (const [name, [r, g, b]] of RETIRED_RGB) {
        const hit = new RegExp(`${r}\\s*,\\s*${g}\\s*,\\s*${b}`).exec(code);
        if (!hit) continue;
        offenders.push(`${short(file)}:${code.slice(0, hit.index).split("\n").length} -> ${name} as rgb`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no component names a colour the palette has not been asked for", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/"(#[0-9a-fA-F]{3,8})"/g)) {
        const value = match[1]!.toUpperCase();
        if (EXEMPT.has(value) || EXEMPT.has(value.replace(/^#([0-9A-F]{6})FF$/, "#$1"))) continue;
        offenders.push(`${short(file)}:${code.slice(0, match.index).split("\n").length} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
