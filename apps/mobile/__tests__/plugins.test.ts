import { describe, expect, test } from "@jest/globals";

import {
  FLOOR_NOTE,
  SCOPE_NOTE,
  VERDICT_ORDER,
  byteLabel,
  foundLabel,
  groupPlugins,
  installPending,
  namedEvidence,
  offersInstall,
  pluginsPreview,
  readLabel,
  routeOut,
  scanCoverage,
  verdictCounts,
  verdictBlurb,
  verdictHeading,
  verdictPill,
  type ConsolePlugin,
  type PluginInventory,
  type PluginVerdict,
} from "../features/console/plugins/plugins";

/**
 * The plugin inventory's wording and its two guards.
 *
 * `docs/decisions/obsidian-plugins.md` argues one asymmetry at length:
 * `wont-run` rests on evidence the scan found and can name, `runs` rests on
 * evidence it did not find, and three paths where an absence could read as a
 * clean bill are routed to `unknown` instead. Everything below is that
 * asymmetry held on the client side, where it is one careless `??` away from
 * being reversed.
 *
 * Mutations these are written to catch, each one green before this file
 * existed:
 *
 *  - `offersInstall` returning true for `unknown` — an unread bundle offered
 *    as installable, which is the single failure the whole design exists to
 *    prevent;
 *  - `routeOut` returning `null` for `wont-run` — a refusal that ends on the
 *    refusal;
 *  - `foundLabel` dropping `truncated` — a floor printed as a total, which is
 *    the note count's old bug in a new place;
 *  - `readLabel` rendering `bytesRead` with no total — a number with nothing
 *    to be a fraction of;
 *  - `pluginsPreview` answering "0" from an unavailable or failed read — a
 *    claim about somebody's vault that nobody checked.
 */

function plugin(over: Partial<ConsolePlugin> & { verdict: PluginVerdict }): ConsolePlugin {
  return {
    id: over.id ?? `plugin-${over.verdict}`,
    name: over.name ?? "A plugin",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

function inventory(over: Partial<PluginInventory> = {}): PluginInventory {
  const plugins = over.plugins ?? [];
  return {
    found: plugins.length,
    scanned: plugins.length,
    truncated: false,
    checkedAt: "2026-09-12T09:41:00.000Z",
    ...over,
    plugins,
  };
}

describe("the five verdicts", () => {
  test("every verdict has a heading and a blurb, and no two share either", () => {
    const headings = VERDICT_ORDER.map(verdictHeading);
    const blurbs = VERDICT_ORDER.map(verdictBlurb);
    expect(VERDICT_ORDER).toHaveLength(5);
    expect(new Set(headings).size).toBe(5);
    expect(new Set(blurbs).size).toBe(5);
    for (const word of [...headings, ...blurbs]) expect(word.trim()).not.toBe("");
  });

  test("what works is offered first and what needs you is offered last", () => {
    expect([...VERDICT_ORDER]).toEqual([
      "runs",
      "needs-approval",
      "files-only",
      "wont-run",
      "unknown",
    ]);
  });

  test("unchecked is named as not-checked rather than as a refusal", () => {
    expect(verdictHeading("unknown")).toBe("Couldn't be checked");
    expect(verdictHeading("unknown")).not.toMatch(/refus|reject|unsupport|block/i);
    expect(verdictBlurb("unknown")).toContain("not offered as working");
  });
});

describe("install is offered only where a verdict can carry it", () => {
  test("runs and needs-approval can install; nothing else can", () => {
    expect(offersInstall("runs")).toBe(true);
    expect(offersInstall("needs-approval")).toBe(true);
    expect(offersInstall("files-only")).toBe(false);
    expect(offersInstall("wont-run")).toBe(false);
  });

  /*
    The one this file is really for. An unread bundle must not reach an install
    path at all — not a disabled one, which is a control with a precondition and
    teaches a reader to go hunting for the switch that satisfies it.
  */
  test("an unchecked plugin has no install path", () => {
    expect(offersInstall("unknown")).toBe(false);
  });
});

describe("no row ends on a refusal", () => {
  test("every verdict closes with exactly one of a route out or an install note", () => {
    for (const verdict of VERDICT_ORDER) {
      const closings = [routeOut(verdict), installPending(verdict)].filter(
        (line): line is string => line !== null,
      );
      expect(closings).toHaveLength(1);
      expect(closings[0]!.trim()).not.toBe("");
    }
  });

  test("a plugin that cannot run here is told where it still runs", () => {
    for (const verdict of ["wont-run", "files-only"] as const) {
      expect(routeOut(verdict)).toContain("Obsidian");
      expect(routeOut(verdict)).toContain("same bucket");
    }
  });

  test("an unchecked plugin is told it was not read, not that it was rejected", () => {
    const line = routeOut("unknown");
    expect(line).toContain("Not a refusal");
    expect(line).toContain("Obsidian");
  });

  test("the install-pending note is absent wherever a route out already answers", () => {
    expect(installPending("wont-run")).toBeNull();
    expect(installPending("files-only")).toBeNull();
    expect(installPending("unknown")).toBeNull();
    expect(installPending("runs")).toContain("not built yet");
  });
});

describe("the chip", () => {
  test("a refusal and a working-elsewhere plugin do not share a tone", () => {
    expect(verdictPill("wont-run").tone).toBe("crit");
    expect(verdictPill("files-only").tone).toBe("neutral");
    expect(verdictPill("runs").tone).toBe("ok");
    expect(verdictPill("needs-approval").tone).toBe("warn");
  });

  /*
    Shape, not hue. Whatever the palette does, the one state that is not the
    outcome of a check has to be separable from the four that are.
  */
  test("only the unchecked chip is dashed", () => {
    const dashed = VERDICT_ORDER.filter((verdict) => verdictPill(verdict).dashed);
    expect(dashed).toEqual(["unknown"]);
  });
});

describe("grouping and counts", () => {
  const plugins = [
    plugin({ verdict: "wont-run", id: "obsidian-git" }),
    plugin({ verdict: "runs", id: "highlightr-plugin" }),
    plugin({ verdict: "runs", id: "obsidian-virtual-linker" }),
    plugin({ verdict: "unknown", id: "dataview" }),
  ];

  test("groups come back in verdict order, not in the order the bucket listed them", () => {
    expect(groupPlugins(plugins).map((group) => group.verdict)).toEqual([
      "runs",
      "wont-run",
      "unknown",
    ]);
  });

  test("a verdict nothing matched is dropped rather than drawn as a zero group", () => {
    expect(groupPlugins(plugins).map((group) => group.verdict)).not.toContain("files-only");
  });

  test("every plugin lands in exactly one group", () => {
    const grouped = groupPlugins(plugins).flatMap((group) => group.plugins);
    expect(grouped).toHaveLength(plugins.length);
    expect(new Set(grouped.map((one) => one.id)).size).toBe(plugins.length);
  });

  test("the summary counts all five, zeroes included", () => {
    expect(verdictCounts(plugins)).toEqual({
      runs: 2,
      "needs-approval": 0,
      "files-only": 0,
      "wont-run": 1,
      unknown: 1,
    });
  });
});

describe("the count is a floor when the listing was one", () => {
  test("a truncated listing prints its count as a floor", () => {
    expect(foundLabel(inventory({ found: 47, truncated: true }))).toBe("47+");
  });

  test("a complete listing prints a total", () => {
    expect(foundLabel(inventory({ found: 47, truncated: false }))).toBe("47");
  });

  test("coverage is silent when everything found was read", () => {
    expect(scanCoverage(inventory({ found: 12, scanned: 12 }))).toBeNull();
  });

  test("coverage says so the moment the two numbers diverge", () => {
    expect(scanCoverage(inventory({ found: 47, scanned: 23 }))).toBe("23 of 47 read");
  });

  test("a truncated listing is never silent, even when scanned matches found", () => {
    expect(scanCoverage(inventory({ found: 47, scanned: 47, truncated: true }))).toBe(
      "47 of 47+ read",
    );
  });
});

describe("how much of a bundle was read", () => {
  test("both numbers or neither", () => {
    expect(readLabel(plugin({ verdict: "unknown", bytesRead: 512_000 }))).toBeNull();
    expect(readLabel(plugin({ verdict: "unknown", bytesTotal: 1_800_000 }))).toBeNull();
    expect(
      readLabel(plugin({ verdict: "unknown", bytesRead: 512_000, bytesTotal: 1_800_000 })),
    ).toBe("512 KB of 1.8 MB read");
  });

  test("byte labels stay in the units a storage provider bills in", () => {
    expect(byteLabel(840)).toBe("840 B");
    expect(byteLabel(84_000)).toBe("84 KB");
    expect(byteLabel(1_800_000)).toBe("1.8 MB");
  });
});

describe("evidence is a name and a reason, or it is not evidence", () => {
  test("a finding missing either half is dropped rather than rendered bare", () => {
    const kept = namedEvidence(
      plugin({
        verdict: "wont-run",
        evidence: [
          { id: "child_process", reason: "runs another program" },
          { id: "fs", reason: "   " },
          { id: "", reason: "reads a local filesystem" },
        ],
      }),
    );
    expect(kept.map((finding) => finding.id)).toEqual(["child_process"]);
  });
});

describe("the notes that cannot be dropped from one surface and kept on another", () => {
  test("the floor is stated, and states that nothing was executed", () => {
    expect(FLOOR_NOTE).toContain("floor, not a guarantee");
    expect(FLOOR_NOTE).toContain("does not run it");
  });

  test("the scope note names other people's notes rather than 'permissions'", () => {
    expect(SCOPE_NOTE).toContain("shared into this context");
    expect(SCOPE_NOTE).toContain("never");
  });
});

describe("the settings row never invents a claim out of an absence", () => {
  test("a console that cannot ask says nothing", () => {
    expect(pluginsPreview({ state: "unavailable" })).toBeNull();
  });

  test("a read in flight says nothing", () => {
    expect(pluginsPreview({ state: "loading" })).toBeNull();
  });

  test("a failed read says nothing — least of all 'None'", () => {
    expect(pluginsPreview({ state: "failed", reason: "storage: 403 from provider" })).toBeNull();
  });

  test("a successful read that found nothing may say so, because it looked", () => {
    expect(pluginsPreview({ state: "ready", inventory: inventory() })).toBe("None found");
  });

  test("a successful read leads with what runs here", () => {
    expect(
      pluginsPreview({
        state: "ready",
        inventory: inventory({
          plugins: [plugin({ verdict: "runs" }), plugin({ verdict: "wont-run" })],
        }),
      }),
    ).toBe("1 run here");
  });

  test("nothing running here reports the count rather than a cheerful zero", () => {
    expect(
      pluginsPreview({
        state: "ready",
        inventory: inventory({ plugins: [plugin({ verdict: "wont-run" })] }),
      }),
    ).toBe("1 found");
  });
});
