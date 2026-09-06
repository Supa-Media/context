import { describe, expect, test } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  DENSITIES,
  ROUTE_REACHABILITY,
  routeFromFile,
  type ReachabilityDensity,
} from "../features/app/reachability";

/**
 * Every route in the app is reachable, or is listed as deliberately not.
 *
 * ## The class this closes
 *
 * A feature nobody can reach passes every one of its own tests. That has now
 * shipped twice from this repository:
 *
 *  - meeting capture arrived complete and unreachable — a list, a live screen
 *    and a working recorder with no `href`, no `router.push` and no button
 *    anywhere outside `features/meetings/`;
 *  - the fix for that was a row on the console's rail, and PR #242 then took the
 *    rail off `compact` (`features/app/frame.ts` returns `rail: "hidden"`),
 *    which put `/meetings` straight back to unreachable on the one density that
 *    records meetings. A review flagged it before the merge and it merged. A
 *    real person then recorded a meeting on their phone, ended it, and had no
 *    route into the list that held it: "the note sort of just disappeared… I
 *    don't know if it succeeded, if it failed. Just nothing at all."
 *
 * Neither is visible to a test of the screen, because a screen's tests are
 * about what it draws once you are on it and nothing in them asks how you got
 * there. So this one is about the *set*: the routes come off the filesystem, so
 * a route cannot be added without being wired or named, and every claim names
 * the file it is made about, so a claim cannot go stale in silence.
 *
 * `/admin` is the precedent for the exception list rather than an invention of
 * one: it is deliberately URL-only and says so in its own file.
 *
 * ## What this proves and what it does not
 *
 * It reads source. It cannot lay a screen out — jsdom hit-tests nothing — so
 * "that control is on the glass at that width" stays with the mounted tests
 * each surface already has: `consoleChrome.test.ts` counts the phone console's
 * landmarks and its bottom row, `meetingsFlow.test.ts` presses the sheet's row
 * and follows it to `/meetings`, `meetingsEntry.test.ts` presses the rail's,
 * `railSections.test.ts` holds the rail's groups. What is genuinely new here is
 * the *completeness* claim, which none of those can make.
 *
 * ## The guard's own guard
 *
 * A checker of this shape asserts that it found nothing, so it needs a
 * self-test — `contextMenu.test.ts` records the version of that lesson where a
 * walk stopped at the first element and went green against the bug it was
 * written for. `the walk finds the routes it is supposed to be checking` is
 * that self-test: an enumerator that returned `[]` would satisfy every other
 * assertion in this file.
 *
 * ## Sabotage record
 *
 * Each applied, this suite run, reverted. The whole suite is green at 3,371.
 *
 *  1. Deleted the `onOpenMeetings` row this branch added to `useMeetingFlow` —
 *     the exact shape of PR #242's regression, with the registry left alone.
 *     → `a claim names a file that still contains the wiring` failed, alone.
 *     The registry's claim survived the code it was about, which is the failure
 *     mode a list of prose has and this one does not.
 *  2. Wrote the honest version of that diff: deleted the row *and* the compact
 *     claim, so the registry told the truth about a phone with no way in.
 *     → `every route is reachable at every density, or says why not` failed,
 *     alone, naming `/meetings at compact`.
 *  3. Added a route file `app/(app)/orphan.tsx` and wired nothing.
 *     → `the registry names every route under (app), and no others` failed.
 *  4. Removed `/console/map` from the registry, leaving the route.
 *     → the same test failed from the other side.
 *  5. Claimed `/meetings` at every density from `ConsoleRail.tsx`, which is
 *     what the code believed before the phone lost its rail.
 *     → `a claim made at compact is not made about the rail` failed, alone.
 *  6. Emptied the enumerator's result.
 *     → 3 failed, led by `the walk finds the routes it is supposed to be
 *     checking`. The other two are the registry comparisons, which fail because
 *     an empty filesystem side makes every entry an orphan — so the self-test is
 *     not the only thing standing between this file and a vacuous green, but it
 *     is the only one that says *why*.
 */

const MOBILE = join(__dirname, "..");
const APP_GROUP = join(MOBILE, "app", "(app)");

/** Route files under `app/(app)/`, relative to `app/`. Layouts are not routes. */
function routeFiles(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
      continue;
    }
    if (!/\.[jt]sx$/.test(name)) continue;
    // `_layout` is chrome around routes, not a route: it renders no screen of
    // its own and nothing can navigate to it.
    if (name.startsWith("_")) continue;
    out.push(relative(join(MOBILE, "app"), full));
  }
  return out;
}

const files = routeFiles(APP_GROUP);
const routes = files.map(routeFromFile);

/* -------------------------------------------------------------------------- */

describe("the guard can see", () => {
  test("the walk finds the routes it is supposed to be checking", () => {
    /*
      The self-test. Every other assertion in this file quantifies over the walk's
      result, so an enumerator that returned nothing would pass all of them —
      which is the failure mode of every checker that asserts an absence.

      Named routes rather than a count, so a rename is a change to this line
      rather than something a number absorbs.
    */
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(routes).toContain("/meetings");
    expect(routes).toContain("/console");
    expect(routes).toContain("/admin");
    // And the derivation itself, on the two shapes that are easy to get wrong:
    // a group segment is not in the URL, and `index` is its folder.
    expect(routeFromFile("(app)/meetings/index.tsx")).toBe("/meetings");
    expect(routeFromFile("(app)/console/[slug]/settings.tsx")).toBe("/console/[slug]/settings");
  });
});

describe("every route is accounted for", () => {
  test("the registry names every route under (app), and no others", () => {
    /*
      Both directions, and the second one matters as much as the first: an entry
      for a route that no longer exists is a claim nobody is checking, and it is
      what makes the list read as thorough while it rots.
    */
    const listed = ROUTE_REACHABILITY.map((entry) => entry.route).sort();
    expect(listed).toEqual([...routes].sort());
  });

  test("and names the file each one is declared by", () => {
    for (const entry of ROUTE_REACHABILITY) {
      const declared = files.map((file) => `app/${file}`);
      expect(declared).toContain(entry.file);
      expect(routeFromFile(relative("app", entry.file))).toBe(entry.route);
    }
  });
});

describe("every route is reachable, or says why not", () => {
  test("every route is reachable at every density, or says why not", () => {
    /*
      The assertion the incident is about. A route offered only at `medium` and
      `wide` is a route a phone cannot find, which is what `/meetings` was, and
      the reason it is stated as a set union rather than as a boolean is that
      the two surfaces that replaced the phone's rail each cover part of the
      range: the context strip and the bottom row are `compact`, the rail is
      `medium` and `wide`.
    */
    const missing: string[] = [];
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      const covered = new Set<ReachabilityDensity>();
      for (const point of entry.from) for (const density of point.densities) covered.add(density);
      for (const density of DENSITIES) {
        if (!covered.has(density)) missing.push(`${entry.route} at ${density}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("a claim names a file that still contains the wiring", () => {
    /*
      What stops the list being prose. Every claim carries the strings that have
      to be in the file it names, so deleting a navigation breaks the claim
      rather than leaving a sentence standing over a hole.
    */
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      expect(entry.from.length).toBeGreaterThan(0);
      for (const point of entry.from) {
        const source = readFileSync(join(MOBILE, point.file), "utf8");
        for (const evidence of point.evidence) {
          expect(`${entry.route} ← ${point.file}: ${source.includes(evidence)}`).toBe(
            `${entry.route} ← ${point.file}: true`,
          );
        }
        expect(point.densities.length).toBeGreaterThan(0);
        expect(point.surface.trim()).not.toBe("");
      }
    }
  });

  test("a claim made at compact is not made about the rail", () => {
    /*
      PR #242's regression, as a rule rather than as a memory. `frame.ts` answers
      `rail: "hidden"` at `compact`, so a compact claim resting on the rail is
      false the moment it is written — and it was: the rail's `onOpenMeetings`
      was believed to be the way in "at every density" for as long as the phone
      had a rail sheet, and the belief outlived the sheet.

      Read off `regionsFor` rather than off a comment, so the day a density gets
      its rail back this stops being a rule instead of stopping being true.
    */
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { regionsFor, initialFrame } =
      require("../features/app/frame") as typeof import("../features/app/frame");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const railed = new Set(
      DENSITIES.filter((density) => regionsFor(density, initialFrame).rail !== "hidden"),
    );
    expect(railed.has("compact")).toBe(false);

    const railFiles = ["features/console/ConsoleRail.tsx"];
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      for (const point of entry.from) {
        if (!railFiles.includes(point.file)) continue;
        for (const density of point.densities) {
          expect(`${entry.route}: rail claimed at ${density}`).toBe(
            `${entry.route}: rail claimed at ${railed.has(density) ? density : "a density with a rail"}`,
          );
        }
      }
    }
  });

  test("an exemption is stated where somebody adding a route would find it", () => {
    /*
      `/admin` is the precedent and the reason the exception list is a list
      rather than a special case: it is deliberately URL-only. What makes that
      honest is that the route's own file says so — a reason that lives only in
      this registry is a reason the next person editing that file never reads.
    */
    const exempt = ROUTE_REACHABILITY.filter((entry) => !entry.reachable);
    expect(exempt.map((entry) => entry.route)).toEqual(["/admin"]);
    for (const entry of exempt) {
      if (entry.reachable) continue;
      expect(entry.reason.length).toBeGreaterThan(60);
      const source = readFileSync(join(MOBILE, entry.file), "utf8");
      expect(`${entry.route}: ${source.includes(entry.marker)}`).toBe(`${entry.route}: true`);
    }
  });
});
