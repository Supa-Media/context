/**
 * A sheet's own visibility, read the same by both parsers.
 *
 * The gateway's parser took a `.csv` exact-note override from the day sheets
 * could carry their own visibility (`docs/decisions/sheets.md`), and the
 * control plane's port still refused one. A refused line makes the whole
 * manifest unreadable, so one sheet set to private would have failed every
 * note in the workspace closed on the control plane's side while the gateway
 * read it fine. Found by the file-kinds audit, 2026-11-25
 * (`docs/decisions/file-kinds.md`).
 */
import { describe, expect, test } from "vitest";
import { effectiveVisibility, parsePrivacyManifest } from "../../functions/lib/privacy";
import { gateway, manifest, block } from "./fixtures.helpers";

const SHEET = "2-areas/metrics/readings.csv";

const WITH_SHEET = manifest(
  block(["default_visibility: private", "", "folder_defaults:", "  2-areas: team", "", "note_overrides:", `  ${SHEET}: private`]),
);

describe("a sheet takes an exact override", () => {
  test("both engines read it", () => {
    for (const parse of [parsePrivacyManifest, gateway.parsePrivacyManifest]) {
      const parsed = parse(WITH_SHEET);
      expect(parsed.rules).toEqual([{ prefix: "2-areas", vis: "team" }]);
      expect(parsed.overrides.get(SHEET)).toBe("private");
    }
  });

  test("it narrows the sheet and nothing beside it", () => {
    const parsed = parsePrivacyManifest(WITH_SHEET);
    expect(effectiveVisibility(SHEET, parsed.rules, parsed.overrides)).toBe("private");
    expect(effectiveVisibility("2-areas/metrics/notes.md", parsed.rules, parsed.overrides)).toBe("team");
  });

  test("another file type is still refused by both", () => {
    const text = manifest(block(["default_visibility: private", "", "note_overrides:", "  2-areas/photo.png: private"]));
    for (const parse of [parsePrivacyManifest, gateway.parsePrivacyManifest]) {
      expect(() => parse(text)).toThrow();
    }
  });
});
