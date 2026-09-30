import { describe, expect, test } from "@jest/globals";
import type { ConsoleAuditEvent } from "../features/console/advanced/advanced";
import {
  activityActor,
  activityCategory,
  buildActivity,
  isRoutineActivity,
  shortAgo,
} from "../features/console/advanced/auditActivity";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Midday, so "an hour ago" and "ten minutes ago" are both still today.
const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();

let seq = 0;
function event(partial: Partial<ConsoleAuditEvent>): ConsoleAuditEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    action: "file.write",
    actorUserId: "u1",
    actorEmail: "seyi@example.com",
    paths: ["1-projects/board-update.md"],
    at: NOW - MINUTE,
    ...partial,
  };
}
const renewal = (at: number) => event({ action: "agent.session.renewed", paths: [], at });
const names = new Map([["u1", "Seyi"]]);

describe("the activity page", () => {
  test("routine sign-ins are hidden by default and counted, so the page shows real changes", () => {
    const page = buildActivity(
      [renewal(NOW - MINUTE), renewal(NOW - 2 * MINUTE), event({ at: NOW - 3 * MINUTE }), renewal(NOW - HOUR)],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    expect(page.hiddenRoutine).toBe(3);
    expect(page.days).toHaveLength(1);
    expect(page.days[0]?.rows).toHaveLength(1);
    expect(page.days[0]?.rows[0]?.sentence).toEqual({
      actor: "Seyi",
      verb: "edited",
      subject: "board-update",
    });
    // One note gets no folder line: the artboard drew the sentence alone.
    expect(page.days[0]?.rows[0]?.detail).toBeNull();
    expect(page.hiddenRoutineToday).toBe(true);
  });

  test("asked for, routine sign-ins come back and fold into one row", () => {
    const page = buildActivity([renewal(NOW - MINUTE), renewal(NOW - 2 * MINUTE)], {
      filter: "all",
      showRoutine: true,
      now: NOW,
      names,
    });
    expect(page.hiddenRoutine).toBe(0);
    const row = page.days[0]?.rows[0];
    expect(row?.count).toBe(2);
    expect(row?.when).toBe("2 times · 2 min ago to 1 min ago");
    expect(row?.sentence.verb).toBe("renewed the in-app agent's sign-in");
  });

  test("days are labelled, and older rows show a clock time rather than hours ago", () => {
    const yesterday = new Date(2026, 8, 28, 18, 12).getTime();
    const older = new Date(2026, 8, 22, 9, 5).getTime();
    const page = buildActivity(
      [event({ at: NOW - MINUTE }), event({ at: yesterday, action: "member.invited", paths: [] }), event({ at: older })],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    expect(page.days.map((day) => day.label)).toEqual(["Today", "Yesterday", "Tue, Sep 22"]);
    expect(page.days[1]?.rows[0]?.when).toBe("6:12 PM");
    expect(page.days[1]?.rows[0]?.sentence).toEqual({
      actor: "Seyi",
      verb: "invited somebody",
      subject: null,
    });
  });

  test("a run across midnight is two rows, one on each day", () => {
    const lateYesterday = new Date(2026, 8, 28, 23, 50).getTime();
    const earlyToday = new Date(2026, 8, 29, 0, 10).getTime();
    const page = buildActivity([event({ at: earlyToday }), event({ at: lateYesterday })], {
      filter: "all",
      showRoutine: false,
      now: NOW,
      names,
    });
    expect(page.days.map((day) => [day.label, day.rows.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
    ]);
  });

  test("filters keep only their family, and an unknown action shows only under Everything", () => {
    const events = [
      event({}),
      event({ action: "share.created" }),
      event({ action: "grant.created", paths: [] }),
      event({ action: "workspace.something_new", paths: [] }),
    ];
    const verbs = (filter: "all" | "notes" | "people" | "apps") =>
      buildActivity(events, { filter, showRoutine: false, now: NOW, names }).days.flatMap((day) =>
        day.rows.map((row) => row.sentence.verb),
      );
    expect(verbs("notes")).toEqual(["edited"]);
    expect(verbs("people")).toEqual(["shared"]);
    const shared = buildActivity([events[1]!], { filter: "all", showRoutine: false, now: NOW, names });
    expect(shared.days[0]?.rows[0]?.sentence).toEqual({
      actor: "Seyi",
      verb: "shared",
      subject: "board-update",
      rest: " with somebody",
    });
    expect(verbs("apps")).toEqual(["connected an AI app"]);
    expect(verbs("all")).toHaveLength(4);
    expect(verbs("all")).toContain("workspace something new");
  });

  test("hidden sign-ins are only counted under a filter that would have shown them", () => {
    const page = buildActivity([renewal(NOW - MINUTE), event({})], {
      filter: "notes",
      showRoutine: false,
      now: NOW,
      names,
    });
    expect(page.hiddenRoutine).toBe(0);
  });

  test("several notes name the first and count the rest; a move says where it went", () => {
    const many = buildActivity(
      [event({ paths: ["a/one.md", "a/two.md", "b/three.md"] })],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    expect(many.days[0]?.rows[0]?.sentence.subject).toBe("one");
    expect(many.days[0]?.rows[0]?.sentence.rest).toBe(" and 2 more");
    expect(many.days[0]?.rows[0]?.notes).toEqual(["one", "two", "three"]);

    // All in one folder: a count and the folder, as "added 3 notes to Inbox".
    const inbox = buildActivity(
      [event({ paths: ["0-inbox/a.md", "0-inbox/b.md", "0-inbox/c.md"] })],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    expect(inbox.days[0]?.rows[0]?.sentence).toEqual({
      actor: "Seyi",
      verb: "edited",
      subject: "3 notes",
      rest: " in 0-inbox",
    });
    expect(inbox.days[0]?.rows[0]?.notes).toHaveLength(3);

    const moved = buildActivity(
      [event({ action: "file.move", paths: ["0-inbox/plan.md", "1-projects/plan.md"] })],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    expect(moved.days[0]?.rows[0]?.sentence).toEqual({ actor: "Seyi", verb: "moved", subject: "plan" });
    expect(moved.days[0]?.rows[0]?.detail).toBe("to 1-projects");
  });

  test("a label that already says who stands alone and keeps the plugin's detail line", () => {
    const page = buildActivity(
      [event({ action: "plugin.network", paths: [], details: { pluginId: "p", host: "www.example.org", method: "GET", status: 200 } })],
      { filter: "all", showRoutine: false, now: NOW, names },
    );
    const row = page.days[0]?.rows[0];
    expect(row?.sentence).toEqual({ actor: null, verb: "A plugin reached the internet", subject: null });
    expect(row?.detail).toBe("p · www.example.org · GET · 200");
  });

  test("nothing in, nothing out", () => {
    expect(buildActivity([], { filter: "all", showRoutine: false, now: NOW })).toEqual({
      days: [],
      hiddenRoutine: 0,
      hiddenRoutineToday: false,
      people: [],
    });
  });
});

describe("a phone's times", () => {
  test("today reads 4m and 1h; other days keep the clock", () => {
    expect(shortAgo(NOW - 4 * MINUTE, NOW)).toBe("4m");
    expect(shortAgo(NOW - 90 * MINUTE, NOW)).toBe("1h");
    expect(shortAgo(NOW - 10_000, NOW)).toBe("now");
    const page = buildActivity([event({ at: NOW - 22 * MINUTE })], {
      filter: "all",
      showRoutine: false,
      now: NOW,
      names,
      short: true,
    });
    expect(page.days[0]?.rows[0]?.when).toBe("22m");
  });
});

describe("the person filter", () => {
  test("offers everybody in the trail, and keeps only the one picked", () => {
    const trail = [
      event({ at: NOW - MINUTE }),
      event({ actorUserId: "u2", actorEmail: "lk@example.com", at: NOW - 2 * MINUTE }),
      event({ actorUserId: undefined, actorEmail: undefined, actorClientId: "Claude", at: NOW - 3 * MINUTE }),
      renewal(NOW - 4 * MINUTE),
    ];
    const everyone = buildActivity(trail, { filter: "all", showRoutine: false, now: NOW, names });
    expect(everyone.people).toEqual(["Seyi", "lk@example.com", "Claude"]);

    const lk = buildActivity(trail, { filter: "all", showRoutine: false, now: NOW, names, who: "lk@example.com" });
    expect(lk.days.flatMap((day) => day.rows.map((row) => row.actor.name))).toEqual(["lk@example.com"]);
    // Seyi's hidden sign-in is not LK's to count.
    expect(lk.hiddenRoutine).toBe(0);
    // The menu still lists everybody, so the pick can be changed.
    expect(lk.people).toEqual(everyone.people);
  });

  test("an older hidden sign-in stops the line saying today", () => {
    const page = buildActivity([renewal(NOW - MINUTE), renewal(NOW - 30 * HOUR)], {
      filter: "all",
      showRoutine: false,
      now: NOW,
      names,
    });
    expect(page.hiddenRoutine).toBe(2);
    expect(page.hiddenRoutineToday).toBe(false);
  });
});

describe("who the sentence names", () => {
  test("an event that carries only an address still gets the member's name", () => {
    const byEmail = new Map([["seyi@example.com", "Seyi"]]);
    expect(activityActor(event({ actorUserId: undefined, actorEmail: "Seyi@Example.com" }), byEmail).name).toBe(
      "Seyi",
    );
  });

  test("a member's name, then their email, then an AI app, never a raw id", () => {
    expect(activityActor(event({}), names)).toEqual({ name: "Seyi", isAgent: false });
    expect(activityActor(event({ actorUserId: "u9" }), names).name).toBe("seyi@example.com");
    expect(
      activityActor(event({ actorUserId: undefined, actorEmail: undefined, actorClientId: "Claude" }), names),
    ).toEqual({ name: "Claude", isAgent: true });
    expect(activityActor(event({ actorUserId: "gone", actorEmail: undefined }), names).name).toBe(
      "Someone who has left",
    );
    expect(activityActor(event({ actorUserId: undefined, actorEmail: undefined }), names)).toEqual({
      name: "Context",
      isAgent: true,
    });
  });
});

describe("families", () => {
  test("each action answers to one filter, and sign-ins are routine", () => {
    expect(activityCategory("folder.create")).toBe("notes");
    expect(activityCategory("invitation.revoked")).toBe("people");
    expect(activityCategory("oauth.authorized")).toBe("apps");
    expect(activityCategory("storage.rekeyed")).toBeNull();
    expect(isRoutineActivity("agent.session.opened")).toBe(true);
    expect(isRoutineActivity("grant.created")).toBe(false);
  });
});
