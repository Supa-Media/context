/**
 * DEVLOG — the weekly update's format, its promise rule, and the reader's
 * place in it.
 *
 *  1. **One parser for every surface.** The page, What's new, the draft and
 *     any release copy all read a week through `parseDevlog`; the four
 *     sections, the date line and the weeks written before sections are
 *     pinned here.
 *  2. **Exploring is never a promise.** A date or a promise word in an
 *     exploring line is a page problem, and a page problem holds the whole
 *     release (`buildWebsiteRouteStatuses`).
 *  3. **The dot clears everywhere, never backwards, and leaves with the
 *     account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   promiseIn always null                                          8
 *   devlog problems not added to page statuses                     1
 *   markDevlogSeen lets the week move backwards                    1
 *   drop the devlogReads sweep from personalRows                   1
 */

import { describe, expect, test } from "vitest";

import {
  buildWebsiteRouteStatuses,
  devlogPromiseProblems,
  latestDevlogWeek,
  parseDevlog,
  promiseIn,
} from "@context/shared";
import { api } from "../_generated/api";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

const PAGE = `---
title: devlog
nav: 10
---

# devlog

[home](/index) - [devlog](/devlog)

### week 5
*september 21 to 27, 2026*

#### shipped
- comments on notes.
- projects: tasks and a board.

#### in progress
- the iOS app on the App Store.

#### exploring
*ideas, not promises. some of these won't happen.*
- looking at: a graph view of how your notes link.

#### declined
- #tags typed inside a note. put tags in the note's properties instead.

[Discuss on Discord](https://example.invalid/discord)

### Week 4
*september 14-20, 2026*

- sandbox for plugins
- pasted images
`;

describe("parseDevlog", () => {
  test("reads a sectioned week and a week written before sections", () => {
    const [five, four] = parseDevlog(PAGE);
    expect(five).toMatchObject({
      number: 5,
      dates: "september 21 to 27, 2026",
      sectioned: true,
      legacy: [],
      exploringDisclaimed: true,
      sections: {
        shipped: ["comments on notes.", "projects: tasks and a board."],
        inProgress: ["the iOS app on the App Store."],
        exploring: ["looking at: a graph view of how your notes link."],
        declined: ["#tags typed inside a note. put tags in the note's properties instead."],
      },
    });
    expect(four).toMatchObject({
      number: 4,
      dates: "september 14-20, 2026",
      sectioned: false,
      legacy: ["sandbox for plugins", "pasted images"],
    });
  });

  test("the newest week is the highest number, wherever it sits", () => {
    const weeks = parseDevlog("### week 2\n- a\n### week 7\n- b\n### week 3\n- c\n");
    expect(latestDevlogWeek(weeks)?.number).toBe(7);
    expect(latestDevlogWeek([])).toBeNull();
  });

  test("a page with no week heading is not a devlog", () => {
    expect(parseDevlog("# pricing\n\n- one plan\n")).toEqual([]);
    expect(devlogPromiseProblems("# pricing\n\nwe will ship soon\n")).toEqual([]);
  });

  test("a later top-level heading ends the week", () => {
    const [week] = parseDevlog("### week 1\n- a\n## about\n- not a devlog item\n");
    expect(week!.legacy).toEqual(["a"]);
  });
});

describe("exploring is never a promise", () => {
  test.each([
    "looking at: a graph view, coming in october",
    "looking at: Google Drive storage, soon",
    "looking at: this will land next week",
    "looking at: a desktop app by Q4",
    "looking at: something for 2027",
    "looking at: planned for friday",
  ])("%s is a problem", (line) => {
    expect(promiseIn(line)).not.toBeNull();
  });

  test.each([
    "looking at: agents suggesting which workspace a note belongs in",
    "looking at: whether agents may suggest a folder",
    "looking at: a graph view of how your notes link",
  ])("%s is fine", (line) => {
    expect(promiseIn(line)).toBeNull();
  });

  test("a promise, a missing prefix and a missing disclaimer each stop the page", () => {
    const page = [
      "### week 6",
      "#### exploring",
      "- looking at: a graph view, coming in october",
      "- a better search",
    ].join("\n");
    const problems = devlogPromiseProblems(page);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/ideas, not promises/);
    expect(problems[1]).toMatch(/"coming" in exploring reads like a promise/);
    expect(problems[2]).toMatch(/starts with "looking at:"/);
  });

  test("the same words outside exploring are fine", () => {
    expect(devlogPromiseProblems("### week 6\n#### in progress\n- the iOS app, coming soon\n")).toEqual([]);
  });

  test("a promise makes the devlog page a problem, which holds the release", () => {
    const promised = PAGE.replace(
      "- looking at: a graph view of how your notes link.",
      "- looking at: a graph view, coming in october.",
    );
    const [clean] = buildWebsiteRouteStatuses([{ objectKey: "website/devlog.md", markdown: PAGE }]);
    const [held] = buildWebsiteRouteStatuses([{ objectKey: "website/devlog.md", markdown: promised }]);
    expect(clean!.status).toBe("live");
    expect(held!.status).toBe("problem");
    expect(held!.problems).toEqual([
      expect.objectContaining({ code: "devlog_promise", message: expect.stringMatching(/Week 5/) }),
    ]);
  });
});

describe("the reader's place", () => {
  test("signed out reads nothing; a read week never moves backwards", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    expect(await t.query(api.functions.devlog.devlogSeenWeek, {})).toBeNull();

    const me = asUser(t, seyi);
    expect(await me.query(api.functions.devlog.devlogSeenWeek, {})).toBeNull();
    await me.mutation(api.functions.devlog.markDevlogSeen, { week: 5 });
    expect(await me.query(api.functions.devlog.devlogSeenWeek, {})).toBe(5);
    await me.mutation(api.functions.devlog.markDevlogSeen, { week: 3 });
    expect(await me.query(api.functions.devlog.devlogSeenWeek, {})).toBe(5);
    await me.mutation(api.functions.devlog.markDevlogSeen, { week: 6 });
    expect(await me.query(api.functions.devlog.devlogSeenWeek, {})).toBe(6);
  });

  test("one person's place is not another's", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const shay = await createUser(t, "shay@example.invalid");
    await asUser(t, seyi).mutation(api.functions.devlog.markDevlogSeen, { week: 5 });
    expect(await asUser(t, shay).query(api.functions.devlog.devlogSeenWeek, {})).toBeNull();
  });

  test("the row goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(api.functions.devlog.markDevlogSeen, { week: 5 });
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    const rows = await t.run((ctx) => ctx.db.query("devlogReads").collect());
    expect(rows).toEqual([]);
  });

  test("signing in is required to record a read", async () => {
    const t = setupTest();
    await expect(t.mutation(api.functions.devlog.markDevlogSeen, { week: 5 })).rejects.toThrow();
  });
});
