import { type DemoContextTree, file, folder, listing, privacyNote, teamFile } from "./treeHelpers";

// ── @lk — someone else's context, team access ────────────────────────────────

export const LK_TREE: DemoContextTree = {
  listings: {
    "": listing("", "private", [
      folder("1-projects", "team"),
      folder("3-resources", "team"),
      file("index.md", { visibility: "team", inherited: "team" }),
      file("privacy.md", { readOnly: true }),
    ]),
    "1-projects": listing("1-projects", "team", [
      teamFile("1-projects/worship-with-strangers.md"),
      teamFile("1-projects/pw-101-curriculum.md"),
    ]),
    "3-resources": listing("3-resources", "team", [
      teamFile("3-resources/set-building.md"),
    ]),
  },
  notes: {
    "index.md": [
      "# LK",
      "",
      "Music and formation, Public Worship.",
      "",
      "You are seeing this workspace with **team** access, which is why it",
      "looks small: private folders are not listed at all, so there is",
      "nothing here whose absence you could notice.",
      "",
    ].join("\n"),
    "1-projects/worship-with-strangers.md": [
      "---",
      "updated: 2026-08-21",
      "status: active",
      "---",
      "",
      "# Worship With Strangers",
      "",
      "A public, participatory format. No stage in the usual sense: the",
      "room is the choir and the band is accompanying it.",
      "",
      "The rule that makes it work is that nothing is performed at",
      "people. If a song cannot be sung by someone who has never heard",
      "it, it does not go in.",
      "",
    ].join("\n"),
    "1-projects/pw-101-curriculum.md": [
      "---",
      "updated: 2026-08-11",
      "---",
      "",
      "# PW 101",
      "",
      "The Academy's entry course, in three movements:",
      "",
      "- **The Heart** — why we sing at all, and to whom.",
      "- **The Craft** — the musicianship the room deserves.",
      "- **The Witness** — what a gathering says to someone who",
      "  wandered in.",
      "",
    ].join("\n"),
    "3-resources/set-building.md": [
      "# Building a set",
      "",
      "Keys before songs. Pick the range the room can actually sing in,",
      "then find the songs that live there — not the other way round.",
      "",
    ].join("\n"),
    "privacy.md": privacyNote(
      [
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  1-projects: team",
        "  3-resources: team",
        "",
        "note_overrides: {}",
      ].join("\n"),
    ),
  },
  defaultSelection: "1-projects/worship-with-strangers.md",
  defaultExpanded: ["1-projects"],
  readOnlyReason:
    "You have team access to this workspace. Anything LK keeps private is not listed here at all — that is the privacy model, not a loading state.",
};
