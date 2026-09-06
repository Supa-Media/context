import { describe, expect, test } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  DENSITIES,
  ROUTE_REACHABILITY,
  routeFromFile,
  type Evidence,
  type ReachabilityDensity,
  type ReachabilityRegion,
  type RouteEntryPoint,
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
 * ## Three ways this guard could be satisfied vacuously, and what replaced them
 *
 * All three were found by reading the guard as an attacker rather than by
 * running it, which is the only way a checker that asserts an absence is ever
 * found wanting.
 *
 *  - **The walk saw `app/(app)/` and the file said "every route inside the
 *    app".** Nine of seventeen route files were outside it, including `/login`,
 *    `/invite`, `/s/<token>` and the root. The walk is `app/` now.
 *  - **The rail rule had no input that could fail it.** It compared claims
 *    against a hardcoded `["features/console/ConsoleRail.tsx"]`, which matched
 *    exactly one entry — already `POINTER` — while the three routes that really
 *    rested on the rail claimed it from `console/_layout.tsx`, which was not on
 *    the list. So deleting the sheet handler and re-pointing `/meetings`'s
 *    compact claim at `_layout.tsx` left the suite green over the original
 *    incident. Every entry point declares a `region` now, and every region's
 *    densities are read off `regionsFor`.
 *  - **A claim named one end of the press.** `DestinationSheet.tsx` draws the
 *    button and `useMeetingFlow.ts` navigates; only the second was named, so
 *    deleting the button a person actually presses left the suite green. That
 *    is the caller/callee boundary PR #242 broke. `evidence` is a list now, and
 *    every entry point must name something pressable *and* something that
 *    navigates.
 *
 * ## Sabotage record
 *
 * Each applied, this suite run, reverted.
 *
 *  1. Deleted the `onOpenMeetings` row this branch added to `useMeetingFlow` —
 *     the exact shape of PR #242's regression, with the registry left alone.
 *     → `a claim names files that still contain the wiring` failed, alone.
 *     The registry's claim survived the code it was about, which is the failure
 *     mode a list of prose has and this one does not.
 *  2. Wrote the honest version of that diff: deleted the row *and* the compact
 *     claim, so the registry told the truth about a phone with no way in.
 *     → `every route is reachable at every density, or says why not` failed,
 *     alone, naming `/meetings at compact`.
 *  3. Added a route file `app/(app)/orphan.tsx` and wired nothing.
 *     → `the registry names every route under app/, and no others` failed.
 *  4. Removed `/console/map` from the registry, leaving the route.
 *     → the same test failed from the other side.
 *  5. Claimed `/meetings` at every density from the rail, which is what the code
 *     believed before the phone lost its rail.
 *     → `a claim is made only at the densities its region is drawn at` failed.
 *  6. Emptied the enumerator's result.
 *     → the walk's self-test failed, leading the registry comparisons.
 *  7. Deleted the "Past meetings" button from `DestinationSheet.tsx`, leaving
 *     `useMeetingFlow` and the registry alone — the defeat this schema was
 *     written for.
 *     → `a claim names files that still contain the wiring` failed, alone.
 *  8. Re-pointed `/meetings`'s compact claim at the rail's own evidence.
 *     → `a claim is made only at the densities its region is drawn at` failed.
 */

const MOBILE = join(__dirname, "..");
const APP = join(MOBILE, "app");

/**
 * Every route file under `app/`, relative to `app/`.
 *
 * **The whole tree, and it used to be `app/(app)/` alone** — eight files of
 * seventeen, under a registry whose first line claimed every route in the app.
 * The completeness claim is the one thing this guard has that the mounted tests
 * do not, and it was false about `/login`, `/invite`, `/invite/<token>`,
 * `/s/<token>`, `/note/…`, `/authorize`, `/connect/dropbox`, `+not-found` and
 * the root.
 *
 * The two exclusions are Expo Router's own, not this file's opinion:
 *
 *  - **`_`-prefixed files and directories are not routes at all.** `_layout` is
 *    the one this app has, and the rule is the router's rather than a statement
 *    about layouts — a `_helpers.ts` beside a route would be excluded too, and
 *    should be. `+`-prefixed files *are* routes (`+not-found` is one), so the
 *    two prefixes are not the same thing and are not treated as one.
 *  - **The extension set is `routeFromFile`'s.** They disagreed: this required
 *    a trailing `x` while the derivation accepted `.ts` and `.js`, so a route
 *    written as a plain `.ts` was silently outside the walk while every other
 *    assertion in this file went on quantifying over what it found.
 */
function routeFiles(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith("_")) continue;
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
      continue;
    }
    if (!/\.[jt]sx?$/.test(name)) continue;
    out.push(relative(APP, full));
  }
  return out;
}

const files = routeFiles(APP);
const routes = files.map(routeFromFile);

/* eslint-disable @typescript-eslint/no-require-imports */
const { regionsFor, initialFrame } =
  require("../features/app/frame") as typeof import("../features/app/frame");
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Which densities each region is actually drawn at, read off `frame.ts`.
 *
 * The point is that none of these is a number typed here. `rail` and
 * `bottomBar` are `Regions` keys and are asked directly; `contextStrip` is
 * *the densities the rail is hidden at*, which is the strip's own reason for
 * existing rather than a coincidence — so the day a density gets its rail back,
 * every claim in this registry moves with it instead of quietly becoming false.
 */
const REGION_DENSITIES: Record<ReachabilityRegion, ReadonlySet<ReachabilityDensity>> = {
  rail: new Set(DENSITIES.filter((d) => regionsFor(d, initialFrame).rail !== "hidden")),
  contextStrip: new Set(DENSITIES.filter((d) => regionsFor(d, initialFrame).rail === "hidden")),
  bottomBar: new Set(DENSITIES.filter((d) => regionsFor(d, initialFrame).bottomBar)),
  screen: new Set(DENSITIES),
};

/** Something a person can press. */
const PRESSABLE = ["onPress", "href="];
/** Something that turns a press into a route. */
const NAVIGATES = ["router.push", "router.replace", "router.navigate", "Redirect href", "<Link"];

/** Every file a claim rests on, control and navigation together. */
const filesOf = (point: RouteEntryPoint): readonly Evidence[] =>
  point.control === undefined ? point.navigation : [point.control, ...point.navigation];

const sourceOf = (file: string) => readFileSync(join(MOBILE, file), "utf8");

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
    expect(routes.length).toBeGreaterThanOrEqual(17);
    expect(routes).toContain("/meetings");
    expect(routes).toContain("/console");
    expect(routes).toContain("/admin");
    // The nine the walk could not see while it read `app/(app)/` alone, named
    // one by one rather than absorbed by a count.
    expect(routes).toContain("/");
    expect(routes).toContain("/login");
    expect(routes).toContain("/invite");
    expect(routes).toContain("/invite/[token]");
    expect(routes).toContain("/authorize");
    expect(routes).toContain("/connect/dropbox");
    expect(routes).toContain("/note/[...address]");
    expect(routes).toContain("/s/[token]");
    expect(routes).toContain("/+not-found");
    // And the derivation itself, on the two shapes that are easy to get wrong:
    // a group segment is not in the URL, and `index` is its folder.
    expect(routeFromFile("(app)/meetings/index.tsx")).toBe("/meetings");
    expect(routeFromFile("(app)/console/[slug]/settings.tsx")).toBe("/console/[slug]/settings");
    expect(routeFromFile("index.tsx")).toBe("/");
  });

  test("and the region table has an input at every region a claim can name", () => {
    /*
      The second self-test, and the one the rail rule needed. Its predecessor
      compared claims against a hardcoded list of one file that no compact claim
      named, so the rule was true of nothing and could not fail — an assertion
      about an empty set, exactly what `contextMenu.test.ts` recorded.

      Stated as: every region in the table is claimed by something, and the two
      regions that constrain a density — the rail and the strip — are claimed on
      both sides of the fence they draw.
    */
    const claimed = new Set<ReachabilityRegion>();
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      for (const point of entry.from) claimed.add(point.region);
    }
    expect([...claimed].sort()).toEqual(["bottomBar", "contextStrip", "rail", "screen"]);

    // And the table itself is not empty on either side, which is what makes
    // "claimed at a density this region is not drawn at" a reachable failure.
    expect([...REGION_DENSITIES.rail]).toEqual(["medium", "wide"]);
    expect([...REGION_DENSITIES.contextStrip]).toEqual(["compact"]);
    expect([...REGION_DENSITIES.bottomBar]).toEqual(["compact"]);
  });
});

describe("every route is accounted for", () => {
  test("the registry names every route under app/, and no others", () => {
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

  test("a claim names files that still contain the wiring", () => {
    /*
      What stops the list being prose. Every claim carries the strings that have
      to be in each file it names, so deleting a navigation breaks the claim
      rather than leaving a sentence standing over a hole.

      **Files, plural, and that is the fix rather than a tidy-up.** Deleting the
      "Past meetings" button out of `DestinationSheet.tsx` — the pixels a person
      presses — left every assertion in this file green, because the claim named
      only `useMeetingFlow.ts`, which supplies the navigation the button calls.
      A way in is both halves and neither survives the other.
    */
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      expect(entry.from.length).toBeGreaterThan(0);
      for (const point of entry.from) {
        expect(point.navigation.length).toBeGreaterThan(0);
        for (const evidence of filesOf(point)) {
          const source = sourceOf(evidence.file);
          expect(evidence.contains.length).toBeGreaterThan(0);
          for (const needle of evidence.contains) {
            expect(`${entry.route} ← ${evidence.file}: ${source.includes(needle)}`).toBe(
              `${entry.route} ← ${evidence.file}: true`,
            );
          }
        }
        expect(point.densities.length).toBeGreaterThan(0);
        expect(point.surface.trim()).not.toBe("");
      }
    }
  });

  test("and names both ends of the press, not just the end that navigates", () => {
    /*
      The rule behind the split, so a new entry point cannot be written
      one-sided the way every existing one was. A claim names the file that
      draws the pixels and the files that turn the press into the route, and
      both have to look like what they claim to be — read off the source, so a
      registry edit alone cannot satisfy either.

      **A route or a layout is never a control.** That is what makes the split
      more than bookkeeping: `console/_layout.tsx` holds `onOpenMeetings`,
      `MEETINGS_ROUTE`, `router.push` and an `onPress`, so it satisfies every
      textual test a control has to pass — and it draws nothing. Re-pointing
      `/meetings`'s compact claim at it, which is the second half of the defeat
      this schema was written for, is refused here by where the file lives.

      `automatic` is the stated exception and the only one: a gate, a redirect,
      the resolution of the root. Those have no control by construction, and an
      absent capability is reported rather than faked with a nearby button.
    */
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      for (const point of entry.from) {
        const where = `${entry.route}/${point.surface}`;
        const navigates = point.navigation
          .map((evidence) => sourceOf(evidence.file))
          .some((source) => NAVIGATES.some((needle) => source.includes(needle)));
        expect(`${where}: navigates ${navigates}`).toBe(`${where}: navigates true`);

        if (point.control === undefined) {
          expect(`${where}: automatic ${point.automatic !== undefined}`).toBe(
            `${where}: automatic true`,
          );
          expect(point.automatic!.length).toBeGreaterThan(60);
          continue;
        }

        // A layout wires screens together and draws none of them. A claim whose
        // control is one is a claim about plumbing, and plumbing is exactly
        // what survived PR #242.
        expect(`${where}: control drawn in ${point.control.file.split("/")[0]}`).toBe(
          `${where}: control drawn in features`,
        );
        const source = sourceOf(point.control.file);
        const pressable = PRESSABLE.some((needle) => source.includes(needle));
        expect(`${where}: pressable ${pressable}`).toBe(`${where}: pressable true`);
      }
    }
  });

  test("a claim is made only at the densities its region is drawn at", () => {
    /*
      PR #242's regression, as a rule rather than as a memory, and general
      rather than a single hardcoded file. `frame.ts` answers `rail: "hidden"`
      at `compact`, so a compact claim resting on the rail is false the moment
      it is written — and it was: the rail's `onOpenMeetings` was believed to be
      the way in "at every density" for as long as the phone had a rail sheet,
      and the belief outlived the sheet.

      Its first version could not have caught that. It compared claims against
      `["features/console/ConsoleRail.tsx"]`, which matched one entry that was
      already `POINTER`, while the three routes that really rested on the rail
      claimed it from `console/_layout.tsx` — not on the list. A rule with no
      input that can fail it is not a rule. Every entry point declares its
      region now, and `REGION_DENSITIES` is read off `regionsFor`.
    */
    const wrong: string[] = [];
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      for (const point of entry.from) {
        const drawn = REGION_DENSITIES[point.region];
        for (const density of point.densities) {
          if (!drawn.has(density)) wrong.push(`${entry.route}: ${point.region} at ${density}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a control the rail draws is claimed as the rail", () => {
    /*
      The other direction, and what stops the region being a word somebody can
      simply retype. `ConsoleRail.tsx` draws the rail's entries, so a claim
      whose control lives in it and calls itself `bottomBar` would pass the rule
      above while being exactly the false claim it exists to catch.

      Read off the file rather than off the registry: a control is the rail's if
      the file that draws it is the rail. `AccountBlock` is also exported from
      that module and is drawn on the phone's chrome — so if a claim is ever made
      about it, this is the line that has to be split, deliberately, rather than
      a rule that quietly stopped applying.
    */
    const RAIL = "features/console/ConsoleRail.tsx";
    let claims = 0;
    for (const entry of ROUTE_REACHABILITY) {
      if (!entry.reachable) continue;
      for (const point of entry.from) {
        if (point.control?.file !== RAIL) continue;
        claims += 1;
        expect(`${entry.route}: drawn by the rail, claimed as ${point.region}`).toBe(
          `${entry.route}: drawn by the rail, claimed as rail`,
        );
      }
    }
    // The rule has input. Its predecessor did not, which is why it never fired.
    expect(claims).toBeGreaterThanOrEqual(3);
  });

  test("an exemption is stated where somebody adding a route would find it", () => {
    /*
      `/admin` is the precedent and the reason the exception list is a list
      rather than a special case: it is deliberately URL-only. What makes that
      honest is that the route's own file says so — a reason that lives only in
      this registry is a reason the next person editing that file never reads.
    */
    const exempt = ROUTE_REACHABILITY.filter((entry) => !entry.reachable);
    expect(exempt.map((entry) => entry.route).sort()).toEqual([
      "/+not-found",
      "/admin",
      "/authorize",
      "/connect/dropbox",
      "/invite/[token]",
      "/note/[...address]",
      "/s/[token]",
    ]);
    for (const entry of exempt) {
      if (entry.reachable) continue;
      expect(entry.reason.length).toBeGreaterThan(60);
      const source = readFileSync(join(MOBILE, entry.file), "utf8");
      expect(`${entry.route}: ${source.includes(entry.marker)}`).toBe(`${entry.route}: true`);
    }
  });
});
