import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_CSS } from "../features/landing/notesCss";

/**
 * The homepage footer's "Download for Mac" (Dev, 2026-10-20). It is one
 * address, `/download/mac`, which the router answers with the newest dmg
 * (`infra/router/src/download.ts`), and it never shows on a phone, which
 * cannot install a Mac app.
 */
const PAGE = readFileSync(join(__dirname, "../features/landing/NotesPage.web.tsx"), "utf8");
const FOOTER = PAGE.slice(PAGE.indexOf('<footer className="np-wrap np-foot">'), PAGE.indexOf("</footer>"));
const ROUTER = readFileSync(join(__dirname, "../../../infra/router/src/download.ts"), "utf8");

describe("the homepage footer's Mac download", () => {
  test("links the router's stable address, not a release with a version in it", () => {
    expect(FOOTER).toMatch(/<a className="np-mac" href="\/download\/mac">\s*Download for Mac\s*<\/a>/);
    expect(FOOTER).not.toMatch(/github\.com|\d+\.\d+\.\d+/);
    expect(ROUTER).toContain('"/download/mac":');
  });

  test("sits between Pricing and Privacy", () => {
    const order = ["Pricing", "Download for Mac", "Privacy", "Terms"].map((w) => FOOTER.indexOf(w));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("is hidden unless there is a mouse, so a phone never shows it", () => {
    expect(NOTES_CSS).toContain(".np-mac{display:none}");
    expect(NOTES_CSS).toContain("@media (hover:hover) and (pointer:fine){.np-mac{display:inline}}");
  });
});
