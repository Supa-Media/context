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
  isAccountSection,
  matchSettingsSections,
  settingsSectionsFor,
  SETTINGS_SECTIONS,
} from "../features/console/settings/sections";

describe("which sections a context has", () => {
  test("both kinds get the sources section", () => {
    // The capture *address* is personal-only and the pane gates that card, but
    // the card explaining why a workspace cannot connect Gmail is in the same
    // block — hiding the section would take the explanation with it.
    for (const kind of ["personal", "shared"] as const) {
      expect(settingsSectionsFor(kind).map((section) => section.key)).toContain("sources");
    }
  });

  test("a loading context still gets a usable list", () => {
    // `null` is the list not landed yet. It must not produce an empty panel.
    expect(settingsSectionsFor(null).length).toBeGreaterThan(0);
    expect(settingsSectionsFor(undefined).map((s) => s.key)).toContain("storage");
  });
});

describe("the order and the grouping", () => {
  test("what comes in is asked before where it is kept", () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key);
    expect(keys.indexOf("sources")).toBeLessThan(keys.indexOf("storage"));
  });

  test("every section sits under a heading somebody can answer", () => {
    // The headings are the whole point of the regrouping: a person who does
    // not know what a bucket is can still tell which third of the list their
    // question is in.
    for (const section of SETTINGS_SECTIONS) {
      // `null` is the ungrouped head of the list — Overview, which answers
      // "which context is this" before any of the three questions below it.
      expect([
        null,
        "Your account",
        "What comes in",
        "Who can see it",
        "Your notes",
      ]).toContain(section.group);
    }
  });

  test("the default section is one that exists", () => {
    expect(isSettingsSection(DEFAULT_SETTINGS_SECTION)).toBe(true);
    expect(settingsSectionsFor("shared").map((s) => s.key)).toContain(
      DEFAULT_SETTINGS_SECTION,
    );
  });
});

describe("two scopes in one list", () => {
  test("account sections survive whichever context is open", () => {
    // They are about the person, not the context — so a shared workspace, a
    // personal brain and a context still loading all keep them.
    for (const kind of ["personal", "shared", null] as const) {
      const keys = settingsSectionsFor(kind).map((section) => section.key);
      expect(keys).toContain("apps");
      expect(keys).toContain("account");
    }
  });

  test("and are recognisable without knowing the list", () => {
    expect(isAccountSection("apps")).toBe(true);
    expect(isAccountSection("storage")).toBe(false);
  });

  test("keys are unique across both scopes, so a URL needs no prefix", () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("searching the list", () => {
  test("finds a section by a word that is not on its row", () => {
    // The whole point: nobody types "sources" looking for Gmail, and nobody
    // types "account" meaning cancel.
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "gmail").map((s) => s.key)).toContain("sources");
    expect(matchSettingsSections(all, "bucket").map((s) => s.key)).toContain("storage");
    expect(matchSettingsSections(all, "cursor").map((s) => s.key)).toContain("apps");
  });

  test("every word has to match, so two words narrow", () => {
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "gmail bucket")).toHaveLength(0);
  });

  test("an empty query is not a search", () => {
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "   ")).toHaveLength(all.length);
  });
});

describe("reading a section out of a URL", () => {
  test("only names we have", () => {
    expect(isSettingsSection("storage")).toBe(true);
    expect(isSettingsSection("sources")).toBe(true);
    expect(isSettingsSection("../../etc")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
  });
});
