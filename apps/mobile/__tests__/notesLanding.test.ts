import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FREE_NOTES_PER_WORKSPACE,
  FREE_WORKSPACES,
} from "../features/landing/notesParts.web";

/**
 * Page a, the notes page (Dev2, 2026-10-21). Its free-plan line is a promise,
 * so the numbers in it are the server's own; it reaches Tex only by linking to
 * tex.lc; and every "make a workspace" button lands on the sign-up.
 */
const read = (path: string) => readFileSync(join(__dirname, path), "utf8");
const PAGE = read("../features/landing/NotesPage.web.tsx");
const PARTS = read("../features/landing/notesParts.web.tsx");
const CONSTANTS = read("../../convex/functions/lib/workspaces/constants.ts");
const PREMIUM = read("../../convex/functions/lib/premium.ts");

function constant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  if (match === null) throw new Error(`${name} not found`);
  return Number(match[1]);
}

describe("page a, the notes page", () => {
  test("the free line's numbers are the server's limits, not copies that can drift", () => {
    expect(FREE_WORKSPACES).toBe(
      constant(CONSTANTS, "MAX_WORKSPACES_PER_USER"),
    );
    expect(FREE_NOTES_PER_WORKSPACE).toBe(
      constant(PREMIUM, "FREE_MANAGED_NOTE_CAP"),
    );
    expect(PARTS).toContain("Free: up to {FREE_WORKSPACES} workspaces");
  });

  test("every way to start lands on the one sign-up", () => {
    expect(PAGE).toContain('<div className="np-sign" id="join">');
    expect(PAGE).toContain("<InlineSignUp />");
    const starts = [...(PAGE + PARTS).matchAll(/href="#([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(starts)).toEqual(new Set(["join"]));
  });

  test("leads with Dev2's own words, and sends texting to tex.lc rather than drawing a chat", () => {
    expect(PAGE).toMatch(
      /<h1 className="np-h1">Context gives your brain that feeling you have when your room is clean\.<\/h1>/,
    );
    expect(PARTS).toContain('href="https://tex.lc"');
    expect(PAGE).toContain('href="https://tex.lc"');
    expect(PAGE + PARTS).not.toMatch(/TexChat|tp-chat|tp-b\b/);
  });

  test("every made-up picture says so", () => {
    expect(PARTS).toContain("Example people and notes.");
    expect(PARTS).toContain("Example workspaces.");
    expect(PARTS).toContain("A note Tex filed (example)");
  });

  test("example people are drawn faces, never letters, and none is called Maya (Dev2, 2026-10-29)", () => {
    const FACES = read("../features/landing/sketchFaces.web.tsx");
    expect(PARTS).not.toMatch(/initial:/);
    expect(PARTS.match(/<SketchFace /g)?.length).toBeGreaterThanOrEqual(3);
    const MARKETING = [
      PAGE,
      PARTS,
      FACES,
      read("../features/landing/demoMap.ts"),
      read("../features/landing/editorScene.ts"),
      read("../features/tex/launch/TexLanding.web.tsx"),
    ];
    for (const source of MARKETING) expect(source).not.toMatch(/maya/i);
  });
});
