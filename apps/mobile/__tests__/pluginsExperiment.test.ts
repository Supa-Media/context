/**
 * Plugins, deprecated in the console.
 *
 * The owner's call on 2026-09-18: the section comes off the settings list, and
 * nothing else goes. Two halves, and this file is written so that neither can
 * be lost without a red run:
 *
 *  - **The row is gone** for a context that has never touched a plugin, which
 *    is the change;
 *  - **nothing was turned off**, which is the promise the change was made
 *    under. Hiding a screen must not disable a plugin, drop a grant, or take
 *    the controls away from somebody who is already running one.
 *
 * Mutations this is written to catch:
 *
 *  - dropping `experimental` from the catalogue, or the guard that reads it —
 *    the row comes back for everybody;
 *  - `pluginsInUse` reading `enabled` rather than `enabled !== defaultEnabled`
 *    on the built-ins, which is true for every context alive and hides
 *    nothing;
 *  - the same function answering `true` on a `loading`, `failed` or `idle`
 *    view, which puts the row back the first time a bucket has a bad minute;
 *  - `settingsSectionsFor` defaulting an unnamed experimental section to
 *    shown, which is the fail-open direction;
 *  - deleting the section from `SETTINGS_SECTIONS` outright, which would take
 *    the panel, the URL and the search entry with it — removal, not
 *    deprecation.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_SETTINGS_SECTION,
  isExperimentalSection,
  isSettingsSection,
  matchSettingsSections,
  settingsSectionLabel,
  settingsSectionsFor,
  SETTINGS_SECTIONS,
} from "../features/console/settings/sections";
import { pluginsInUse, showPluginsSection } from "../features/console/plugins/experiment";
import type { ContextPlugin, ContextPluginsView } from "../features/console/plugins/contextPlugins";
import type { ManagedInstallsView } from "../features/console/plugins/managedInstalls";
import type { ConsolePlugin, PluginsView } from "../features/console/plugins/plugins";

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

/** A built-in as it ships: on, because that is its default. Nobody chose this. */
function builtin(overrides: Partial<ContextPlugin> = {}): ContextPlugin {
  return {
    id: "context-forms",
    name: "Markdown forms",
    description: "A form block collects answers into a sister note.",
    version: "1.0.0",
    author: "Context",
    enabled: true,
    defaultEnabled: true,
    tools: ["submit_form"],
    surfaces: ["Notes"],
    offMeans: "No new answers are taken.",
    ...overrides,
  };
}

function vaultPlugin(): ConsolePlugin {
  return {
    id: "templater-obsidian",
    source: "obsidian",
    bundleFingerprint: "0".repeat(64),
    name: "Templater",
    verdict: "runs",
    evidence: [],
    limitations: [],
    notes: [],
  };
}

/** A context that has never been near the section: defaults, and nothing else. */
const UNTOUCHED: Parameters<typeof pluginsInUse>[0] = {
  plugins: { state: "idle" },
  contextPlugins: {
    state: "ready",
    canManage: true,
    settingsError: null,
    plugins: [builtin(), builtin({ id: "context-images", name: "Images" })],
  },
  pluginInstalls: { state: "ready", installs: [], truncated: false, read: async () => {} },
};

/* -------------------------------------------------------------------------- */
/*                         is this context using plugins?                     */
/* -------------------------------------------------------------------------- */

describe("a context that has never touched a plugin", () => {
  test("is not using plugins, however many built-ins are switched on", () => {
    /*
      The trap this is here for. All five built-ins ship enabled, so a check
      on `enabled` alone is true for every context that exists and the
      deprecation hides the row from nobody.
    */
    expect(pluginsInUse(UNTOUCHED)).toBe(false);
  });

  test("and does not get the row", () => {
    const keys = settingsSectionsFor("personal", {
      plugins: showPluginsSection(UNTOUCHED),
    }).map((section) => section.key);
    expect(keys).not.toContain("plugins");
    // The rest of "Your notes" is untouched: this is one row, not a group.
    expect(keys).toEqual(expect.arrayContaining(["storage", "search", "advanced"]));
  });
});

describe("a context that is already using plugins keeps the screen", () => {
  test("a built-in somebody switched off", () => {
    // `enabled !== defaultEnabled` in the other direction too: a built-in that
    // ships off and was turned on is the same evidence that somebody chose.
    expect(
      pluginsInUse({
        ...UNTOUCHED,
        contextPlugins: {
          state: "ready",
          canManage: true,
          settingsError: null,
          plugins: [builtin({ enabled: false }), builtin({ id: "context-images" })],
        },
      }),
    ).toBe(true);
    expect(
      pluginsInUse({
        ...UNTOUCHED,
        contextPlugins: {
          state: "ready",
          canManage: true,
          settingsError: null,
          plugins: [builtin({ enabled: true, defaultEnabled: false })],
        },
      }),
    ).toBe(true);
  });

  test("something Context installed into the bucket", () => {
    expect(
      pluginsInUse({
        ...UNTOUCHED,
        pluginInstalls: {
          state: "ready",
          installs: [{ id: "dataview", version: "0.5.0", repository: "blacksmithgu/obsidian-dataview" }],
          truncated: false,
          read: async () => {},
        },
      }),
    ).toBe(true);
  });

  test("a vault plugin the scan found", () => {
    expect(
      pluginsInUse({
        ...UNTOUCHED,
        plugins: {
          state: "ready",
          inventory: {
            found: 1,
            scanned: 1,
            truncated: false,
            checkedAt: "2026-09-18",
            plugins: [vaultPlugin()],
          },
        },
      }),
    ).toBe(true);
  });

  test("a scan that found more than it could list", () => {
    // `found` is a floor when the listing was truncated, so it can be above
    // the rows handed back. Reading only the rows would hide the section from
    // the person with the most plugins in this product.
    expect(
      pluginsInUse({
        ...UNTOUCHED,
        plugins: {
          state: "ready",
          inventory: {
            found: 3,
            scanned: 0,
            truncated: true,
            checkedAt: "2026-09-18",
            plugins: [],
          },
        },
      }),
    ).toBe(true);
  });

  test("and the row is on their list", () => {
    const views = {
      ...UNTOUCHED,
      pluginInstalls: {
        state: "ready" as const,
        installs: [{ id: "dataview", version: "0.5.0", repository: null }],
        truncated: false,
        read: async () => {},
      },
    };
    const keys = settingsSectionsFor("personal", { plugins: showPluginsSection(views) }).map(
      (section) => section.key,
    );
    expect(keys).toContain("plugins");
  });
});

describe("a read that did not answer is not evidence of anything", () => {
  /*
    The deprecation's default is hidden, so an unfinished or broken read leaves
    the row off rather than putting it back for everybody whose bucket had a
    bad minute. The flag is the way back, not a failed request.
  */
  const unanswered: readonly [string, Parameters<typeof pluginsInUse>[0]][] = [
    [
      "the scan has not been asked for",
      { ...UNTOUCHED, plugins: { state: "idle" } },
    ],
    [
      "the built-ins are still loading",
      { ...UNTOUCHED, contextPlugins: { state: "loading" } },
    ],
    [
      "the built-ins failed",
      { ...UNTOUCHED, contextPlugins: { state: "failed", reason: "no answer" } },
    ],
    [
      "the installs failed",
      {
        ...UNTOUCHED,
        pluginInstalls: { state: "failed", reason: "no answer", read: async () => {} },
      },
    ],
    [
      "the installs are withheld from a non-owner",
      { ...UNTOUCHED, pluginInstalls: { state: "withheld" } },
    ],
    [
      "a bucket with nothing in it answered successfully",
      {
        ...UNTOUCHED,
        plugins: {
          state: "ready",
          inventory: {
            found: 0,
            scanned: 0,
            truncated: false,
            checkedAt: "2026-09-18",
            plugins: [],
          },
        },
      },
    ],
  ];

  test.each(unanswered)("%s", (_label, views) => {
    expect(pluginsInUse(views)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                        deprecation, not removal                            */
/* -------------------------------------------------------------------------- */

describe("the section is hidden, not deleted", () => {
  test("it is still in the catalogue, with its panel's heading", () => {
    // A row deleted takes the panel, the `?settings=plugins` URL and the
    // search entry with it, and flipping the flag back would be rebuilding
    // rather than switching on.
    expect(SETTINGS_SECTIONS.some((section) => section.key === "plugins")).toBe(true);
    expect(settingsSectionLabel("plugins")).toBe("Plugins");
  });

  test("a ?settings=plugins URL is still a name we have", () => {
    expect(isSettingsSection("plugins")).toBe(true);
  });

  test("the experiment puts it back with nothing else changed", () => {
    const hidden = settingsSectionsFor("personal", { plugins: false }).map((s) => s.key);
    const shown = settingsSectionsFor("personal", { plugins: true }).map((s) => s.key);
    expect(shown.filter((key) => key !== "plugins")).toEqual(hidden);
    // And in its old place: after Search, before Advanced.
    expect(shown.indexOf("search")).toBeLessThan(shown.indexOf("plugins"));
    expect(shown.indexOf("plugins")).toBeLessThan(shown.indexOf("advanced"));
  });

  test("it is findable by name once it is back", () => {
    const all = settingsSectionsFor("personal", { plugins: true });
    expect(matchSettingsSections(all, "templater").map((s) => s.key)).toEqual(["plugins"]);
  });

  test("and unfindable while it is hidden, rather than a row that opens nothing", () => {
    // Search runs over the sections a context *has*. A hidden row still
    // matching "templater" would be the list advertising a screen the person
    // cannot reach.
    const all = settingsSectionsFor("personal");
    expect(matchSettingsSections(all, "templater")).toHaveLength(0);
  });
});

describe("the guard defaults closed", () => {
  test("an experimental section nobody named is absent", () => {
    // No second argument at all: the state every caller that has not been
    // updated is in, and it must hide rather than show.
    expect(settingsSectionsFor("personal").map((s) => s.key)).not.toContain("plugins");
    expect(settingsSectionsFor(null).map((s) => s.key)).not.toContain("plugins");
  });

  test("hiding it does not cost the list its default section", () => {
    // `DEFAULT_SETTINGS_SECTION` is what a URL naming a missing section falls
    // back to, so it has to survive every filter this function applies.
    for (const kind of ["personal", "shared", null] as const) {
      expect(settingsSectionsFor(kind).map((s) => s.key)).toContain(
        DEFAULT_SETTINGS_SECTION,
      );
    }
  });

  test("no other section was caught by the new filter", () => {
    // One row is experimental. If a second ever is, this says so rather than
    // letting a stray flag quietly remove a screen.
    expect(SETTINGS_SECTIONS.filter(isExperimentalSection).map((s) => s.key)).toEqual([
      "plugins",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                       the types the fixtures stand in for                  */
/* -------------------------------------------------------------------------- */

/*
  Compile-time only: the fixtures above are hand-written views, and a change to
  any of these three unions should fail here rather than silently making this
  file's evidence stale.
*/
const _views: {
  plugins: PluginsView;
  contextPlugins: ContextPluginsView;
  pluginInstalls: ManagedInstallsView;
} = UNTOUCHED;
void _views;
