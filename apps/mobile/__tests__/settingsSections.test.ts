/**
 * The settings overlay's section list.
 *
 * Settings stopped being one scroll that opened on an access key. What this
 * pins is the part a redesign could quietly undo:
 *
 *  1. **A section a context does not have is absent, not disabled.** A shared
 *     workspace has no capture address at all, so it has no Email section —
 *     and a greyed row inviting somebody to press it would be a worse answer
 *     than no row (`CLAUDE.md`: only a personal context has an ingestion
 *     alias).
 *  2. **Storage is not first.** It is touched at setup and at a key rotation
 *     and then never again, and it used to occupy the entire first screen.
 *     The order here is how often a thing is actually opened.
 *  3. **The groups are questions, not subsystems.** "What comes in" is
 *     answerable by somebody who has never heard of a bucket; "Integrations"
 *     was not.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  settingsSectionsFor,
  SETTINGS_SECTIONS,
} from "../features/console/settings/sections";

describe("which sections a context has", () => {
  test("a personal brain can be sent mail, so it has an Email section", () => {
    const keys = settingsSectionsFor("personal").map((section) => section.key);
    expect(keys).toContain("email");
  });

  test("a shared workspace has no capture address, so the section is absent", () => {
    const keys = settingsSectionsFor("shared").map((section) => section.key);
    // Absent, not present-and-disabled. A workspace should not receive
    // somebody's email, and a row saying so is a control that lies.
    expect(keys).not.toContain("email");
    expect(keys).toContain("storage");
  });

  test("an unknown kind gets only what every context has", () => {
    // `null` is the list still loading. It must not guess "personal" and offer
    // a section that will vanish a moment later.
    expect(settingsSectionsFor(null).map((section) => section.key)).not.toContain("email");
    expect(settingsSectionsFor(undefined).map((section) => section.key)).not.toContain(
      "email",
    );
  });
});

describe("the order and the grouping", () => {
  test("what comes in is asked before where it is kept", () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key);
    expect(keys.indexOf("email")).toBeLessThan(keys.indexOf("storage"));
  });

  test("every section sits under a heading somebody can answer", () => {
    // The headings are the whole point of the regrouping: a person who does
    // not know what a bucket is can still tell which third of the list their
    // question is in.
    for (const section of SETTINGS_SECTIONS) {
      expect(["What comes in", "Your notes"]).toContain(section.group);
    }
  });

  test("the default section is one that exists", () => {
    expect(isSettingsSection(DEFAULT_SETTINGS_SECTION)).toBe(true);
    expect(settingsSectionsFor("shared").map((s) => s.key)).toContain(
      DEFAULT_SETTINGS_SECTION,
    );
  });
});

describe("reading a section out of a URL", () => {
  test("only names we have", () => {
    expect(isSettingsSection("storage")).toBe(true);
    expect(isSettingsSection("email")).toBe(true);
    expect(isSettingsSection("../../etc")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
  });
});
