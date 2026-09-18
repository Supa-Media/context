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
 *  3. **The groups are questions, not plumbing.** "Integrations" is the
 *     word somebody looking for connected mail, calendars and chats reaches
 *     for before they know which provider owns the setup.
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
  test("both kinds get the capture sections", () => {
    // The capture *address* is personal-only and each block gates its own
    // controls, but the sentence explaining why a workspace cannot connect
    // Gmail lives in the same block — hiding the section would take the
    // explanation with it. "Absent, not disabled" is right for a control that
    // would be refused and wrong for the sentence that says why.
    for (const kind of ["personal", "shared"] as const) {
      const keys = settingsSectionsFor(kind).map((section) => section.key);
      for (const key of ["integrations", "meetings"]) {
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
  test("the list reads in the order somebody asks the questions", () => {
    /*
      Seven rows, and the order is the argument: who you are, which context
      this is, where its notes are kept, what fills them, what records a
      meeting into them, what it costs, and who else can see it. Storage moved
      up when Search became a block on it — it is where notes live, not a
      footnote — and Premium sits above Sharing because it is about the
      context as a whole.
    */
    const keys: readonly string[] = SETTINGS_SECTIONS.map((section) => section.key);
    const rank = (key: string) => keys.indexOf(key);
    expect(rank("profile")).toBeLessThan(rank("workspace"));
    expect(rank("workspace")).toBeLessThan(rank("storage"));
    expect(rank("storage")).toBeLessThan(rank("integrations"));
    expect(rank("integrations")).toBeLessThan(rank("meetings"));
    expect(rank("meetings")).toBeLessThan(rank("premium"));
    expect(rank("premium")).toBeLessThan(rank("sharing"));
  });

  test("seven rows, and one of them only when it has something to say", () => {
    // The whole of the change: twenty rows under four headings became seven
    // under none. `plugins` is deprecated behind `shown` and `invitations`
    // appears only while an invitation is pending.
    expect(settingsSectionsFor("personal").map((section) => section.key)).toEqual([
      "profile",
      "workspace",
      "storage",
      "integrations",
      "meetings",
      "premium",
      "sharing",
    ]);
    expect(
      settingsSectionsFor("personal", { invitations: true }).map((section) => section.key),
    ).toHaveLength(8);
  });

  test("every section sits under a heading somebody can answer", () => {
    for (const section of SETTINGS_SECTIONS) {
      // One heading left: the account/context split, which is a difference in
      // what a row acts on rather than a category to learn. Every context row
      // is ungrouped.
      expect([null, "Your account"]).toContain(section.group);
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
    // personal workspace and a context still loading all keep them.
    for (const kind of ["personal", "shared", null] as const) {
      const keys = settingsSectionsFor(kind).map((section) => section.key);
      expect(keys).toContain("profile");
    }
  });

  test("one question, one row: sharing answers all four of the old ones", () => {
    /*
      People, Groups, Shared links and Privacy asked one question — who can see
      it — and answered it in four places, so somebody had to visit all four to
      know. The merge is only worth anything if every word that used to reach
      one of them still reaches the screen that now holds it.
    */
    const all = settingsSectionsFor("personal");
    const keys = all.map((section) => section.key);
    for (const gone of ["people", "groups", "shares", "privacy"]) {
      expect(keys).not.toContain(gone);
      expect(isSettingsSection(gone)).toBe(false);
    }
    for (const query of ["who can see", "members", "role", "group", "link", "revoke a link", "public", "permissions"]) {
      expect(matchSettingsSections(all, query).map((s) => s.key)).toContain("sharing");
    }
  });

  test("invitations is a row only while one is waiting", () => {
    /*
      Three states, two of them absent and for different reasons: nothing
      pending, and nothing known yet. `undefined` is the list in flight and is
      not zero — the distinction `ConsoleData.invitations` and `previews.ts`
      both keep — but neither is a row, because neither has anything in it.
    */
    const keysWhen = (waiting: boolean | undefined) =>
      settingsSectionsFor("personal", { invitations: waiting }).map((section) => section.key);

    expect(keysWhen(undefined)).not.toContain("invitations");
    expect(keysWhen(false)).not.toContain("invitations");
    expect(keysWhen(true)).toContain("invitations");
    // And with no `shown` at all, which is every caller that does not know:
    // fail closed, the direction the deprecated rows already land on.
    expect(settingsSectionsFor("personal").map((s) => s.key)).not.toContain("invitations");
  });

  test("signing out is a control on Profile, not a row of its own", () => {
    /*
      "Sign out & delete" was a row in the index for two buttons somebody
      presses once or never — and it put the control that ends a *session* on
      the only screen that can end an *account*. Both are at the foot of
      Profile now, under the identity they act on.
    */
    const all = settingsSectionsFor("personal");
    expect(all.map((section) => section.key)).not.toContain("account");
    expect(isSettingsSection("account")).toBe(false);
    expect(matchSettingsSections(all, "sign out").map((s) => s.key)).toEqual(["profile"]);
  });

  test("appearance is a sentence on Profile, not a section of its own", () => {
    /*
      "Follow the device" is the whole of the feature now, so there is nothing
      to navigate to — but "dark mode" is exactly what somebody types when they
      cannot find the setting, and a search that matches nothing reads as a
      product that lost it.
    */
    const all = settingsSectionsFor("personal");
    expect(all.map((section) => section.key)).not.toContain("appearance");
    expect(isSettingsSection("appearance")).toBe(false);
    expect(matchSettingsSections(all, "dark mode").map((s) => s.key)).toEqual(["profile"]);
    expect(matchSettingsSections(all, "theme").map((s) => s.key)).toEqual(["profile"]);
  });

  test("the machines are reachable from Profile, because the row went and the revoke did not", () => {
    /*
      A grant here lets a Mac capture into private notes. Losing the row is a
      navigation change; losing the way to revoke one from a phone would be a
      change to what this product promises (`CLAUDE.md`: never weaken
      revocability). So: no `devices` section, and Profile answers for it.
    */
    const keys = settingsSectionsFor("personal").map((section) => section.key);
    expect(keys).not.toContain("devices");
    expect(isSettingsSection("devices")).toBe(false);
    expect(
      matchSettingsSections(settingsSectionsFor("personal"), "revoke laptop").map(
        (section) => section.key,
      ),
    ).toEqual(["profile"]);
  });

  test("and are recognisable without knowing the list", () => {
    expect(isAccountSection("profile")).toBe(true);
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
    expect(matchSettingsSections(all, "gmail").map((s) => s.key)).toContain("integrations");
    expect(matchSettingsSections(all, "bucket").map((s) => s.key)).toContain("storage");
    expect(matchSettingsSections(all, "cursor").map((s) => s.key)).toContain("integrations");
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
      "profile",
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
    ["sign out", "profile"],
    ["delete my account", "profile"],
    ["gmail", "integrations"],
    ["mailbox", "integrations"],
    ["forward", "integrations"],
    ["imessage", "integrations"],
    ["messages", "integrations"],
    ["calendar", "integrations"],
    ["ical", "integrations"],
    ["schedule", "integrations"],
    ["zoom", "meetings"],
    ["recording", "meetings"],
    ["transcript", "meetings"],
    ["claude", "integrations"],
    ["revoke", "integrations"],
    ["username", "profile"],
    ["dropbox", "storage"],
    ["rebuild index", "storage"],
    ["fast search", "storage"],
    ["who can see", "sharing"],
    ["shared link", "sharing"],
    ["revoke a link", "sharing"],
    ["members", "sharing"],
    ["groups", "sharing"],
    ["audit log", "workspace"],
    ["export keys", "workspace"],
    /*
      The four somebody types when they are done with a workspace. Every one of
      them matched *nothing* before: "delete this workspace" has been at the
      bottom of that screen since it shipped and none of its own words were in
      any haystack. The bare "delete" is the one that was actively wrong rather than
      merely missing — see below.
    */
    ["delete workspace", "workspace"],
    ["remove workspace", "workspace"],
    ["delete this workspace", "workspace"],
    ["destroy a workspace", "workspace"],

    /*
      The four somebody types when they are worried. "public" is the one that
      matters most and the one our own vocabulary would never have caught: the
      product has no public tier, so the word appears in no label and in no
      copy — and a person asking "is any of this public?" is asking the
      question this section exists to answer. All four land on Sharing &
      Access now, which is the whole answer rather than the quarter of it
      Privacy used to be.
    */
    ["private", "sharing"],
    ["public", "sharing"],
    ["hide", "sharing"],
    ["permissions", "sharing"],
    /*
      The machine words, repointed rather than deleted — "Your devices" is a
      card at the foot of Profile now. A word kept for a row that no longer
      exists returns a section that cannot answer, which is worse than no word.
    */
    ["mac", "profile"],
    ["laptop", "profile"],
    ["revoke a mac", "profile"],
    /*
      Repointed with the row: the picker is gone and the app follows the
      device, so "dark mode" has to land on the screen that says so. A word
      that matches nothing is somebody concluding the setting is missing.
    */
    ["dark mode", "profile"],
    ["light", "profile"],
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

  test("and 'invite' opens Invitations, but only while one is waiting", () => {
    // Off the table above because it is the one query whose answer depends on
    // the person rather than the context: with nothing pending there is no
    // row, so there is nothing for the box to return either.
    const waiting = settingsSectionsFor("personal", { invitations: true });
    expect(matchSettingsSections(waiting, "invite").map((s) => s.key)).toContain(
      "invitations",
    );
    /*
      With nothing pending the word still has a destination — Sharing &
      Access, where you invite somebody — and that is the point: the box goes on answering,
      it just cannot offer a screen whose only content would be "Nothing
      pending".
    */
    const none = settingsSectionsFor("personal", { invitations: false });
    const hits = matchSettingsSections(none, "invite").map((s) => s.key);
    expect(hits).not.toContain("invitations");
    expect(hits).toEqual(["sharing"]);
  });

  /*
    The two destructive screens, kept apart.

    They are one word away from each other — "delete" — and the wrong answer is
    unrecoverable in a way no other mis-hit here is: somebody who wants one
    workspace off their list must never be handed the screen that closes their
    account. So each is reachable by its own noun and neither answers for the
    other's. This is the assertion that fails if a later edit "helpfully" adds
    `workspace` to Profile's keywords — Profile being where the account
    controls now live, at the foot of the screen about the person.
  */
  test("deleting a workspace and deleting an account are not the same search", () => {
    const all = settingsSectionsFor("personal");
    const keysFor = (query: string) =>
      matchSettingsSections(all, query).map((section) => section.key);

    expect(keysFor("delete workspace")).toEqual(["workspace"]);
    expect(keysFor("delete my account")).toEqual(["profile"]);
    // A personal workspace goes with the account it belongs to — the sentence
    // `deletionBlockedReason` gives for refusing it in Advanced — so the noun
    // has to land on the screen that can actually do it. "workspace" is the noun
    // here on purpose: the word is retired from the copy, and people who
    // learned it will go on typing it for years.
    expect(keysFor("delete my brain")).toEqual(["profile"]);
    // The bare verb is ambiguous and should say so by offering both, rather
    // than silently picking the more destructive one. That is what it did
    // before: "delete" matched the account row alone.
    expect(keysFor("delete")).toEqual(expect.arrayContaining(["profile", "workspace"]));
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
    expect(isSettingsSection("integrations")).toBe(true);
    // The four rows Integrations replaced: a URL still carrying one is an
    // alias's job (`nav.ts`), never a section this list admits to having.
    expect(isSettingsSection("email")).toBe(false);
    expect(isSettingsSection("apps")).toBe(false);
    // The section this one replaced. A URL still carrying it must fail the
    // check and fall back to the default, not open a blank panel.
    expect(isSettingsSection("sources")).toBe(false);
    expect(isSettingsSection("../../etc")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
  });
});
