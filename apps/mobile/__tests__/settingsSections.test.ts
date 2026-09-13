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
  settingsSectionLabel,
  settingsSectionsFor,
  SETTINGS_SECTIONS,
} from "../features/console/settings/sections";

describe("which sections a context has", () => {
  test("both kinds get all four communications sections", () => {
    // The capture *address* is personal-only and each panel gates its own
    // controls, but the sentence explaining why a workspace cannot connect
    // Gmail lives in the same block — hiding the section would take the
    // explanation with it. "Absent, not disabled" is right for a control that
    // would be refused and wrong for the sentence that says why.
    for (const kind of ["personal", "shared"] as const) {
      const keys = settingsSectionsFor(kind).map((section) => section.key);
      for (const key of ["email", "calendar", "chats", "meetings"]) {
        expect(keys).toContain(key);
      }
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
    expect(keys.indexOf("email")).toBeLessThan(keys.indexOf("storage"));
    expect(keys.indexOf("meetings")).toBeLessThan(keys.indexOf("storage"));
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
    expect(matchSettingsSections(all, "gmail").map((s) => s.key)).toContain("email");
    expect(matchSettingsSections(all, "bucket").map((s) => s.key)).toContain("storage");
    expect(matchSettingsSections(all, "cursor").map((s) => s.key)).toContain("apps");
  });

  test("every word has to match, so two words narrow", () => {
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "gmail bucket")).toHaveLength(0);
  });

  test("filler words do not have to match anything", () => {
    // "delete my account" returned nothing: every word has to match and `my`
    // is in no section's vocabulary. People type sentences at a search box.
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "delete my account").map((s) => s.key)).toContain(
      "account",
    );
    // Still a filter, not a shrug: a real word that matches nothing still
    // empties the list.
    expect(matchSettingsSections(all, "my kubernetes")).toHaveLength(0);
  });

  test("an empty query is not a search", () => {
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "   ")).toHaveLength(all.length);
  });

  /*
    A curated table rather than a property, because the failure this catches is
    a *wrong* answer and not a missing one: every one of these queries matched
    something before, and the ones that regressed matched the wrong row. "sign
    out" is the case that shipped — the word `sign` lived in exactly one
    haystack, so it returned the screen that deletes an account.
  */
  /*
    The `sources` rows below are repointed rather than deleted. One section
    covering mail, calendars and chats became four, and the queries that used
    to land on it are exactly the ones that must still land somewhere: the
    split is only worth anything if "imessage" now opens Chats instead of a
    page that also holds a forwarding address.
  */
  test.each([
    ["sign out", "account"],
    ["delete my account", "account"],
    ["gmail", "email"],
    ["mailbox", "email"],
    ["forward", "email"],
    ["imessage", "chats"],
    ["messages", "chats"],
    ["calendar", "calendar"],
    ["ical", "calendar"],
    ["schedule", "calendar"],
    ["zoom", "meetings"],
    ["recording", "meetings"],
    ["transcript", "meetings"],
    ["invite", "invitations"],
    ["claude", "apps"],
    ["revoke", "apps"],
    ["username", "profile"],
    ["dropbox", "storage"],
    ["rebuild index", "search"],
    ["who can see", "people"],
    ["shared link", "shares"],
    ["revoke a link", "shares"],
    ["audit log", "advanced"],
    ["export keys", "advanced"],
    /*
      The four somebody types when they are done with a workspace. Every one of
      them matched *nothing* before: "delete this workspace" has been at the
      bottom of Advanced since it shipped and none of its own words were in any
      haystack. The bare "delete" is the one that was actively wrong rather than
      merely missing — see below.
    */
    ["delete workspace", "advanced"],
    ["remove workspace", "advanced"],
    ["delete this workspace", "advanced"],
    ["destroy a workspace", "advanced"],

    /*
      The four somebody types when they are worried. "public" is the one that
      matters most and the one our own vocabulary would never have caught: the
      product has no public tier, so the word appears in no label and in no
      copy — and a person asking "is any of this public?" is asking the
      question this section exists to answer.
    */
    ["private", "privacy"],
    ["public", "privacy"],
    ["hide", "privacy"],
    ["permissions", "privacy"],
    ["mac", "devices"],
    ["laptop", "devices"],
    ["dark mode", "appearance"],
    ["light", "appearance"],
    /*
      Nobody types "premium" — they type what they are trying to do, and none
      of these words are on the row. "storage limit" is the one worth keeping:
      the 50 GB ceiling is a Premium fact and the Storage section cannot answer
      it, so a person hunting for it must not be sent to the bucket screen.
    */
    ["cancel subscription", "premium"],
    ["invoice", "premium"],
    ["card", "premium"],
    ["payment", "premium"],
    ["storage limit", "premium"],
    ["upgrade", "premium"],
  ])("%p opens %p", (query, key) => {
    const hits = matchSettingsSections(settingsSectionsFor("personal"), query).map(
      (section) => section.key,
    );
    expect(hits).toContain(key);
  });

  /*
    The two destructive screens, kept apart.

    They are one word away from each other — "delete" — and the wrong answer is
    unrecoverable in a way no other mis-hit here is: somebody who wants one
    workspace off their list must never be handed the screen that closes their
    account. So each is reachable by its own noun and neither answers for the
    other's. This is the assertion that fails if a later edit "helpfully" adds
    `workspace` to the account row's keywords.
  */
  test("deleting a workspace and deleting an account are not the same search", () => {
    const all = settingsSectionsFor("personal");
    const keysFor = (query: string) =>
      matchSettingsSections(all, query).map((section) => section.key);

    expect(keysFor("delete workspace")).toEqual(["advanced"]);
    expect(keysFor("delete my account")).toEqual(["account"]);
    // A brain goes with the account it belongs to — the sentence
    // `deletionBlockedReason` gives for refusing it in Advanced — so the noun
    // has to land on the screen that can actually do it.
    expect(keysFor("delete my brain")).toEqual(["account"]);
    // The bare verb is ambiguous and should say so by offering both, rather
    // than silently picking the more destructive one. That is what it did
    // before: "delete" matched the account row alone.
    expect(keysFor("delete")).toEqual(expect.arrayContaining(["account", "advanced"]));
  });

  test("a section is always findable by the words on its own row", () => {
    // Our name for a thing has to be *a* way in even when it is not the
    // reader's: a row nobody can find by typing what it says is a row whose
    // keywords have quietly replaced its label rather than widened it.
    const all = settingsSectionsFor("personal");
    for (const section of all) {
      const hits = matchSettingsSections(all, section.label).map((entry) => entry.key);
      expect(hits).toContain(section.key);
    }
  });
});

describe("the panel is headed by the row that opened it", () => {
  test("every section's heading is its own label", () => {
    // They were separate strings and drifted: the row said "Mail, calendar &
    // chats" and the panel it opened was headed "Integrations", handing back
    // the vocabulary the row exists to avoid.
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsSectionLabel(section.key)).toBe(section.label);
    }
  });
});

describe("reading a section out of a URL", () => {
  test("only names we have", () => {
    expect(isSettingsSection("storage")).toBe(true);
    expect(isSettingsSection("email")).toBe(true);
    // The section this one replaced. A URL still carrying it must fail the
    // check and fall back to the default, not open a blank panel.
    expect(isSettingsSection("sources")).toBe(false);
    expect(isSettingsSection("../../etc")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
  });
});
